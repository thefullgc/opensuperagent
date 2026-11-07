import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { temporaryApp } from "./helpers/harness.js";

it("fans out one shared-thread event to every open subscriber", async () => {
  const h = temporaryApp();
  const { app } = h;
  await app.start();
  app.settings.saveAdapter("webhook", {
    enabled: true,
    secret: "fanout-secret",
    callbackUrl: "http://127.0.0.1/callback",
    outboundSecret: "fanout-outbound-secret",
  });
  try {
    const def = app.store.catalog.getDefinition("coding")!;
    const first = app.store.tasks.insert({
      ownerId: "owner",
      objective: "first",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "first"),
      status: "active",
    });
    const second = app.store.tasks.insert({
      ownerId: "owner",
      objective: "second",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "second"),
      status: "active",
    });
    app.store.tasks.addSubscription(first.id, "thread-shared");
    app.store.tasks.addSubscription(second.id, "thread-shared");

    const result = app.submitExternal({
      source: "webhook",
      externalId: "fanout-1",
      threadId: "thread-shared",
      actorId: "owner",
      preview: "shared update",
      payload: { text: "shared update" },
    });

    assert.equal(result.decision?.kind, "tasks");
    if (result.decision?.kind !== "tasks") throw new Error("expected tasks");
    assert.deepEqual(
      new Set(result.decision.taskIds),
      new Set([first.id, second.id]),
    );
    assert.equal(result.inboxItemIds.length, 2);
    assert.equal(app.store.inbox.listPending(first.id).length, 1);
    assert.equal(app.store.inbox.listPending(second.id).length, 1);
    assert.equal(app.store.inbox.listPending("router").length, 0);
    assert.ok(app.events.list(first.id).some((event) => event.kind === "ingress"));
    assert.ok(app.events.list(second.id).some((event) => event.kind === "ingress"));

    const duplicate = app.submitExternal({
      source: "webhook",
      externalId: "fanout-1",
      threadId: "thread-shared",
      actorId: "owner",
      preview: "shared update",
      payload: { text: "shared update" },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(app.store.inbox.listPending(first.id).length, 1);
    assert.equal(app.store.inbox.listPending(second.id).length, 1);
  } finally {
    await h.close();
  }
});
