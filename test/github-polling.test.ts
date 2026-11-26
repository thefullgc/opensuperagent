import assert from "node:assert/strict";
import { it } from "node:test";
import { App } from "../src/app.js";
import { setImmediate as immediate } from "node:timers/promises";
import {
  deferred,
  eventually,
  httpServer,
  jsonBody,
  temporaryApp,
} from "./helpers/harness.js";

it("receives offline comments after restart without replaying history, filtered comments or a partially read page", async () => {
  const h = temporaryApp();
  const started = new Date(Date.now() + 2000).toISOString();
  let unavailable = true;
  let backlog = false;
  const pages: number[] = [];
  const remote = await httpServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    assert.equal(req.headers.authorization, "Bearer fixture");
    assert.equal(url.pathname, "/repos/demo/agent/issues/comments");
    const page = Number(url.searchParams.get("page") ?? 1);
    pages.push(page);
    if (page === 2 && unavailable) {
      res.writeHead(502).end();
      return;
    }
    const comment = (
      id: number,
      body: string,
      login = "human",
      type = "User",
    ) => ({
      id,
      body,
      user: { login, type },
      issue_url: remote.url + "/repos/demo/agent/issues/2",
      created_at: id === 1 ? "2020-01-01T00:00:00Z" : started,
    });
    if (page === 1) {
      url.searchParams.set("page", "2");
      res.setHeader("link", `<${url.pathname}${url.search}>; rel="next"`);
      res.end(
        JSON.stringify([
          comment(1, "@opensuperagent old"),
          comment(2, "@opensuperagent skip", "stranger"),
          comment(3, "@opensuperagent skip", "bot", "Bot"),
          comment(4, "unaddressed"),
          comment(5, "@OpenSuperAgent first"),
        ]),
      );
    } else {
      res.end(
        JSON.stringify(
          backlog ? [comment(6, "@opensuperagent while offline")] : [],
        ),
      );
    }
  });
  let restarted: App | undefined;
  try {
    await h.api.start();
    const save = await fetch(h.api.url + "/api/settings/adapters/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        receiveMode: "polling",
        repos: ["Demo/Agent"],
        actors: ["human", "bot"],
        token: "fixture",
        apiBaseUrl: remote.url,
      }),
    });
    assert.equal(save.status, 200);
    await eventually(() => !!h.app.githubPolling.snapshot().error);
    assert.match(h.app.githubPolling.snapshot().error!, /502/);
    assert.deepEqual(pages, [1, 2]);
    assert.equal(h.app.store.inbox.listPending("router").length, 1);
    const webhook = await fetch(h.api.url + "/hooks/github", {
      method: "POST",
      body: "{}",
    });
    assert.equal(webhook.status, 409);

    h.app.githubPolling.stop();
    unavailable = false;
    backlog = true;
    restarted = new App(h.app.config, { legacyLlm: null });
    restarted.githubPolling.reconcile();
    await eventually(() => !!restarted!.githubPolling.snapshot().lastSuccess);
    const readTriggers = () =>
      restarted!.store.db
        .prepare(
          "SELECT preview FROM triggers WHERE source='github' ORDER BY rowid",
        )
        .all()
        .map((row) => row.preview);
    assert.deepEqual(readTriggers(), [
      "@OpenSuperAgent first",
      "@opensuperagent while offline",
    ]);
    restarted.githubPolling.reconcile();
    await eventually(() => !!restarted!.githubPolling.snapshot().lastSuccess);
    assert.equal(readTriggers().length, 2);
    assert.equal(restarted.store.inbox.listPending("router").length, 2);
  } finally {
    await restarted?.stop();
    await h.close();
    await remote.close();
  }
});

it("disables polling on a mode change and discards an in-flight response", async () => {
  const h = temporaryApp();
  const pending = deferred();
  const release = deferred();
  const remote = await httpServer(async (_req, res) => {
    pending.resolve();
    await release.promise;
    res.end(
      JSON.stringify([
        {
          id: 10,
          body: "@opensuperagent stale",
          issue_url: remote.url + "/repos/demo/agent/issues/2",
          created_at: new Date().toISOString(),
          user: { login: "human" },
        },
      ]),
    );
  });
  try {
    const config = {
      enabled: true,
      token: "fixture",
      repos: ["demo/agent"],
      actors: ["human"],
      apiBaseUrl: remote.url,
    };
    assert.equal(h.app.settings.adapters.github.receiveMode, "webhook");
    assert.throws(
      () => h.app.settings.saveAdapter("github", config),
      /signing secret/,
    );
    h.app.settings.saveAdapter("github", { ...config, receiveMode: "polling" });
    h.app.githubPolling.reconcile();
    await pending.promise;
    h.app.settings.saveAdapter("github", {
      receiveMode: "webhook",
      webhookSecret: "test",
    });
    h.app.githubPolling.reconcile();
    release.resolve();
    await remote.close();
    assert.equal(h.app.store.inbox.listPending("router").length, 0);
    assert.equal(
      h.app.store.db.prepare("SELECT * FROM github_poll_cursors").all().length,
      0,
    );
  } finally {
    release.resolve();
    await h.close();
  }
});

it("delivers a polled request back to its GitHub conversation through the normal worker pipeline", async () => {
  const h = temporaryApp();
  const replies: string[] = [];
  const remote = await httpServer(async (req, res) => {
    if (req.method === "POST") {
      assert.equal(req.url, "/repos/demo/agent/issues/12/comments");
      replies.push((await jsonBody(req)).body);
      res.end(JSON.stringify({ id: 321 }));
      return;
    }
    res.end(
      JSON.stringify([
        {
          id: 123,
          issue_url: remote.url + "/repos/demo/agent/issues/12",
          created_at: new Date().toISOString(),
          body: "@opensuperagent check",
          user: { login: "human", type: "User" },
        },
      ]),
    );
  });
  try {
    h.app.settings.saveAdapter("github", {
      enabled: true,
      receiveMode: "polling",
      repos: ["demo/agent"],
      actors: ["human"],
      token: "fixture",
      apiBaseUrl: remote.url,
    });
    await h.app.start();
    await eventually(
      () => !!h.app.store.deliveries.hasExternalMessageId("github:321"),
    );
    assert.equal(h.app.store.tasks.list().length, 1);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /<!-- opensuperagent:dlv_/);
  } finally {
    await h.close();
    await remote.close();
  }
});

it("honors Retry-After and conditionally checks an unchanged comments page", async (t) => {
  const h = temporaryApp();
  const requests: (string | undefined)[] = [];
  const remote = await httpServer((req, res) => {
    requests.push(req.headers["if-none-match"]);
    if (requests.length === 1)
      res.writeHead(429, { "retry-after": "120" }).end();
    else if (requests.length === 2)
      res.writeHead(200, { etag: '"comments"' }).end("[]");
    else res.writeHead(304).end();
  });
  // Keep I/O on the real event loop while advancing only the poller's clock.
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && !predicate()) await immediate();
    assert.ok(predicate());
  };
  try {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    h.app.settings.saveAdapter("github", {
      enabled: true,
      receiveMode: "polling",
      repos: ["demo/agent"],
      actors: ["human"],
      token: "fixture",
      apiBaseUrl: remote.url,
    });
    h.app.githubPolling.reconcile();
    await waitFor(() => !!h.app.githubPolling.snapshot().error);
    t.mock.timers.tick(119_999);
    await immediate();
    assert.equal(requests.length, 1);
    t.mock.timers.tick(1);
    await waitFor(() => !!h.app.githubPolling.snapshot().lastSuccess);
    const first = h.app.githubPolling.snapshot().lastSuccess;
    t.mock.timers.tick(60_000);
    await waitFor(() => h.app.githubPolling.snapshot().lastSuccess !== first);
    assert.deepEqual(requests, [undefined, undefined, '"comments"']);
    assert.equal(h.app.githubPolling.snapshot().error, null);
  } finally {
    await h.close();
    t.mock.timers.reset();
    await remote.close();
  }
});

it("recovers a surviving comment shifted to the previous page by a deletion", async () => {
  const h = temporaryApp();
  let removed = false;
  const remote = await httpServer((req, res) => {
    const onSecondPage = req.url!.includes("page=2");
    if (onSecondPage) removed = true;
    const ids = onSecondPage ? [4] : removed ? [2, 3] : [1, 2];
    if (!onSecondPage) res.setHeader("link", '<?page=2>; rel="next"');
    res.end(
      JSON.stringify(
        ids.map((id) => ({
          id,
          user: { login: "human" },
          body: "@opensuperagent task " + id,
          issue_url: remote.url + "/repos/demo/agent/issues/2",
          created_at: at,
        })),
      ),
    );
  });
  const at = new Date(Date.now() + 2000).toISOString();
  try {
    h.app.settings.saveAdapter("github", {
      enabled: true,
      receiveMode: "polling",
      repos: ["demo/agent"],
      actors: ["human"],
      token: "fixture",
      apiBaseUrl: remote.url,
    });
    h.app.githubPolling.reconcile();
    await eventually(() => !!h.app.githubPolling.snapshot().error);
    assert.match(h.app.githubPolling.snapshot().error!, /pages changed/);
    assert.equal(h.app.store.inbox.listPending("router").length, 2);
    h.app.githubPolling.reconcile();
    await eventually(() => !!h.app.githubPolling.snapshot().lastSuccess);
    assert.equal(h.app.store.inbox.listPending("router").length, 4);
  } finally {
    await h.close();
    await remote.close();
  }
});
