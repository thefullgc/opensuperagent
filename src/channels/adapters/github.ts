import type { IncomingHttpHeaders } from "node:http";
import type { SettingsStore } from "../../settings/store.js";
import type { Store } from "../../storage/index.js";
import type { IngressInput, Delivery } from "../../types.js";
import { fetchJson, HttpError, parseBody, verifyHmac } from "../http.js";
import type { DeliveryChannel } from "../../delivery/index.js";

export interface GithubComment {
  id: number;
  issue_url: string;
  created_at: string;
  body: string;
  user: { login: string; type?: string } | null;
}

export class GithubAdapter implements DeliveryChannel {
  readonly name = "github";
  isEnabled() {
    return this.settings.adapters.github.enabled;
  }
  constructor(
    private readonly settings: SettingsStore,
    private readonly store: Store,
  ) {}
  receive(
    raw: Buffer,
    headers: IncomingHttpHeaders,
  ): IngressInput | { ignored: string } {
    const config = this.settings.adapters.github;
    if (!config.enabled) throw new HttpError(503, "GitHub adapter is disabled");
    if (config.receiveMode !== "webhook")
      throw new HttpError(409, "GitHub is in polling mode");
    verifyHmac(
      config.webhookSecret,
      raw,
      String(headers["x-hub-signature-256"] ?? ""),
    );
    const body = parseBody(raw);
    const event = String(headers["x-github-event"] ?? "");
    const delivery = String(headers["x-github-delivery"] ?? "");
    if (!delivery) throw new HttpError(400, "Missing GitHub delivery ID");
    if (event === "ping") return { ignored: "GitHub ping acknowledged" };
    return this.normalize(body, event, delivery);
  }

  receiveComment(repo: string, number: number, comment: GithubComment) {
    const config = this.settings.adapters.github;
    if (!config.enabled || config.receiveMode !== "polling")
      throw new Error("GitHub polling is disabled");
    const body = {
      repository: { full_name: repo },
      issue: { number },
      sender: comment.user,
      action: "created",
      comment,
    };
    return this.normalize(
      body,
      "issue_comment",
      `comment:${config.apiBaseUrl}:${repo.toLowerCase()}:${comment.id}`,
    );
  }

  private normalize(
    body: ReturnType<typeof parseBody>,
    event: string,
    delivery: string,
  ): IngressInput | { ignored: string } {
    const config = this.settings.adapters.github;
    const repo = String(body.repository?.full_name ?? "");
    const actor = String(body.sender?.login ?? "");
    if (
      !config.repos.some((r) => r.toLowerCase() === repo.toLowerCase()) ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo)
    )
      throw new HttpError(403, "Repository is outside the allowlist");
    if (!config.actors.some((a) => a.toLowerCase() === actor.toLowerCase())) {
      if (config.receiveMode === "polling")
        return { ignored: "Actor is outside the allowlist" };
      throw new HttpError(403, "Actor is outside the allowlist");
    }
    if (
      body.sender?.type === "Bot" ||
      actor.toLowerCase() === config.botLogin.toLowerCase()
    )
      return { ignored: "Bot or outbound echo" };
    const supported =
      (event === "issue_comment" && body.action === "created") ||
      (event === "issues" && body.action === "opened") ||
      (event === "pull_request" &&
        ["opened", "reopened"].includes(body.action)) ||
      (event === "pull_request_review_comment" && body.action === "created") ||
      (event === "pull_request_review" && body.action === "submitted");
    if (!supported)
      return { ignored: `Unsupported event ${event}/${body.action}` };
    const number = body.issue?.number ?? body.pull_request?.number;
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new HttpError(400, "Missing issue or PR number");
    const threadId = `github:${repo.toLowerCase()}#${number}`;
    const text = String(
      [
        "issue_comment",
        "pull_request_review",
        "pull_request_review_comment",
      ].includes(event)
        ? (body.comment?.body ?? body.review?.body ?? "")
        : `${body.issue?.title ?? body.pull_request?.title ?? ""}\n${body.issue?.body ?? body.pull_request?.body ?? ""}`,
    ).trim();
    if (!text) return { ignored: "Empty message" };
    if (
      !this.store.tasks.findOpenByThread(threadId).length &&
      !text.toLowerCase().includes(config.mention.toLowerCase())
    )
      return { ignored: "New requests must mention the agent" };
    const marker = /<!-- opensuperagent:(dlv_[a-f0-9]+) -->/.exec(text);
    const ownDelivery = marker ? this.store.deliveries.get(marker[1]!) : null;
    if (ownDelivery?.channel === "github" && ownDelivery.target === threadId)
      return { ignored: "Outbound echo marker" };
    const messageId =
      body.comment?.id != null ? `github:${body.comment.id}` : null;
    if (messageId && this.store.deliveries.hasExternalMessageId(messageId))
      return { ignored: "Outbound echo" };
    return {
      source: "github",
      externalId: delivery,
      threadId,
      actorId: actor,
      preview: text.slice(0, 200),
      payload: {
        text,
        event,
        repository: repo,
        issueNumber: number,
        raw: body,
      },
    };
  }
  async testCredentials() {
    const config = this.settings.adapters.github;
    if (!config.token || !config.repos.length)
      throw new HttpError(
        400,
        "Save a GitHub token and repository allowlist first",
      );
    for (const repo of config.repos) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new HttpError(400, "Invalid repository name");
      await fetchJson(`${config.apiBaseUrl}/repos/${repo}`, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "OpenSuperAgent",
        },
      });
    }
    return { ok: true, repositories: config.repos };
  }
  async send(delivery: Delivery): Promise<{ externalMessageId: string }> {
    const config = this.settings.adapters.github;
    if (!config.enabled) throw new HttpError(503, "GitHub adapter is disabled");
    const match = /^github:([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(
      delivery.target,
    );
    if (
      !match ||
      !config.repos.some((r) => r.toLowerCase() === match[1]!.toLowerCase())
    )
      throw new HttpError(
        403,
        "Delivery target is outside the repository allowlist",
      );
    const marker = `<!-- opensuperagent:${delivery.id} -->`;
    const data = await fetchJson(
      `${config.apiBaseUrl}/repos/${match[1]}/issues/${match[2]}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "OpenSuperAgent",
        },
        body: JSON.stringify({ body: `${delivery.content}\n\n${marker}` }),
      },
    );
    if (!data.id) throw new HttpError(502, "GitHub response has no comment ID");
    return { externalMessageId: `github:${data.id}` };
  }
}
