import { z } from "zod";
import type { SettingsStore, AdaptersConfig } from "../settings/store.js";
import type { Store } from "../storage/index.js";
import type { IngressInput } from "../types.js";
import type { GithubAdapter } from "./adapters/github.js";

const interval = 60_000;
const commentPage = z.array(
  z.object({
    id: z.number().int().positive(),
    issue_url: z.string(),
    created_at: z.iso.datetime({ offset: true }),
    body: z.string(),
    user: z
      .object({ login: z.string(), type: z.string().optional() })
      .nullable(),
  }),
);
type Config = AdaptersConfig["github"];
type Cursor = { since: string; last_id: number };

export class GithubPolling {
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private etags = new Map<string, { url: string; tag: string }>();
  private lastSuccess: string | null = null;
  private error: string | null = null;
  private failures = 0;
  private retryAt = 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly store: Store,
    private readonly adapter: GithubAdapter,
    private readonly submit: (input: IngressInput) => void,
  ) {}

  snapshot() {
    return { lastSuccess: this.lastSuccess, error: this.error };
  }

  stop() {
    this.controller?.abort();
    clearTimeout(this.timer);
    this.etags.clear();
  }

  reconcile() {
    this.stop();
    this.lastSuccess = null;
    this.error = null;
    this.failures = 0;
    const config = this.settings.adapters.github;
    const repos =
      config.enabled && config.receiveMode === "polling"
        ? [...new Set(config.repos.map((repo) => repo.toLowerCase()))]
        : [];
    const db = this.store.db;
    // Retain progress across restarts, but start fresh when a repository is re-enabled.
    const started = new Date(
      Math.floor(Date.now() / 1000) * 1000,
    ).toISOString();
    this.store.transaction(() => {
      db.prepare(
        `DELETE FROM github_poll_cursors WHERE api_url != ?
        OR repo NOT IN (SELECT value FROM json_each(?))`,
      ).run(config.apiBaseUrl, JSON.stringify(repos));
      const insert = db.prepare(
        "INSERT OR IGNORE INTO github_poll_cursors(api_url, repo, since) VALUES (?, ?, ?)",
      );
      for (const repo of repos) insert.run(config.apiBaseUrl, repo, started);
    });
    if (!repos.length) return;
    const controller = new AbortController();
    this.controller = controller;
    const tick = async () => {
      const errors: string[] = [];
      let minInterval = interval;
      for (const repo of repos) {
        if (controller.signal.aborted) return;
        if (Date.now() < this.retryAt) break;
        try {
          const pollInterval = await this.readRepo(
            config,
            repo,
            controller.signal,
          );
          minInterval = Math.max(minInterval, pollInterval);
        } catch (err) {
          if (controller.signal.aborted) return;
          errors.push(
            `${repo}: ${this.settings.redact(err instanceof Error ? err.message : String(err))}`,
          );
        }
      }
      if (controller.signal.aborted) return;
      if (errors.length) {
        this.error = errors.join("; ");
        this.failures++;
      } else if (Date.now() >= this.retryAt) {
        this.lastSuccess = new Date().toISOString();
        this.error = null;
        this.failures = 0;
      }
      const delay = Math.max(
        minInterval,
        interval * 2 ** Math.min(4, Math.max(0, this.failures - 1)),
        this.retryAt - Date.now(),
      );
      this.timer = setTimeout(
        () => void tick(),
        Math.min(delay, 2_147_483_647),
      );
      this.timer.unref();
    };
    void tick();
  }

  private async readRepo(config: Config, repo: string, signal: AbortSignal) {
    const path = `${config.apiBaseUrl}/repos/${repo}/issues`;
    let query = new URL(`${path}/comments`);
    const db = this.store.db;
    const cursor = db
      .prepare(
        "SELECT since, last_id FROM github_poll_cursors WHERE api_url = ? AND repo = ?",
      )
      .get(config.apiBaseUrl, repo) as Cursor;
    // GitHub's since is exclusive and applies to updates. Admit creations only,
    // in the endpoint's default order (ascending comment ID).
    query.searchParams.set(
      "since",
      new Date(Date.parse(cursor.since) - 1000).toISOString(),
    );
    query.searchParams.set("per_page", "100");
    const firstPage = query.href;
    let minInterval = interval;
    const fetchPage = async (url: URL, tag?: string | null) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
      };
      if (tag) headers["If-None-Match"] = tag;
      const response = await fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      signal.throwIfAborted();
      const requestedInterval = Number(response.headers.get("x-poll-interval"));
      if (Number.isFinite(requestedInterval))
        minInterval = Math.max(minInterval, requestedInterval * 1000);
      if (!response.ok && response.status !== 304) {
        if (response.status === 429 || response.status === 403) {
          const seconds = Number(response.headers.get("retry-after"));
          const reset =
            response.headers.get("x-ratelimit-remaining") === "0"
              ? Number(response.headers.get("x-ratelimit-reset")) * 1000
              : 0;
          if (seconds > 0 || reset > 0 || response.status === 429)
            this.retryAt = Math.max(
              Date.now() + interval,
              Date.now() + seconds * 1000,
              reset,
            );
        }
        await response.body?.cancel();
        throw new Error(`GitHub returned HTTP ${response.status}`);
      }
      return response;
    };

    const visited = new Set<string>();
    let previous: { url: URL; tag: string | null; lastId: number } | undefined;
    const advance = db.prepare(
      "UPDATE github_poll_cursors SET since = ?, last_id = ? WHERE api_url = ? AND repo = ?",
    );
    while (true) {
      if (visited.has(query.href))
        throw new Error("Repeated GitHub pagination link");
      visited.add(query.href);
      const cached = this.etags.get(repo);
      const response = await fetchPage(
        query,
        cached?.url === query.href ? cached.tag : undefined,
      );
      signal.throwIfAborted();
      if (response.status === 304) return minInterval;
      const comments = commentPage.parse(await response.json());
      signal.throwIfAborted();
      // GitHub uses offset pagination. A deletion on an earlier page can
      // shift an unread comment behind this page. Recheck the boundary before
      // committing any newer IDs; on drift, retry from the durable cursor.
      if (previous && comments.length) {
        const check = await fetchPage(previous.url, previous.tag);
        signal.throwIfAborted();
        if (check.status !== 304) {
          const earlier = commentPage.parse(await check.json());
          signal.throwIfAborted();
          if (earlier.at(-1)?.id !== previous.lastId)
            throw new Error(
              "Comment pages changed while reading. Retrying from the saved cursor.",
            );
        }
      }
      for (const comment of comments) {
        if (
          comment.id <= cursor.last_id ||
          Date.parse(comment.created_at) < Date.parse(cursor.since)
        )
          continue;
        const issuePrefix = path.toLowerCase() + "/";
        if (!comment.issue_url.toLowerCase().startsWith(issuePrefix))
          throw new Error("Unexpected issue URL");
        const number = comment.issue_url.slice(issuePrefix.length);
        if (!/^[1-9]\d*$/.test(number)) throw new Error("Invalid issue number");
        this.store.transaction(() => {
          const input = this.adapter.receiveComment(
            repo,
            Number(number),
            comment,
          );
          if (!("ignored" in input)) this.submit(input);
          advance.run(comment.created_at, comment.id, config.apiBaseUrl, repo);
        });
        cursor.last_id = comment.id;
      }
      const next = /<([^>]+)>;\s*rel="next"/.exec(
        response.headers.get("link") ?? "",
      );
      if (!next) {
        const tag = response.headers.get("etag");
        if (visited.size === 1 && tag)
          this.etags.set(repo, { url: firstPage, tag });
        return minInterval;
      }
      this.etags.delete(repo);
      const nextPage = new URL(next[1]!, query);
      // A pagination link must never forward the token to another origin or endpoint.
      if (
        nextPage.origin !== query.origin ||
        nextPage.pathname !== query.pathname ||
        nextPage.username ||
        nextPage.password
      )
        throw new Error("Unexpected GitHub pagination link");
      const last = comments.at(-1);
      if (!last) throw new Error("Empty GitHub page with a next link");
      previous = {
        url: query,
        tag: response.headers.get("etag"),
        lastId: last.id,
      };
      query = nextPage;
    }
  }
}
