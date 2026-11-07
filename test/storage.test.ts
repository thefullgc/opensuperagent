import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { decideRoute } from "../src/ingress/route.js";
import { importSeed } from "../src/catalog/index.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("storage + routing", () => {
  it("preserves obsolete catalog definitions and Task snapshots instead of remapping their tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "osa-no-tool-remapping-"));
    const path = join(dir, "state.sqlite");
    let store = Store.open(path);
    try {
      importSeed(store, join(root, "seed"));
      const base = store.catalog.getDefinition("coding")!;
      const legacy = { ...base, tools: ["read", "exec", "start", "stop", "skill", "submit_result"] };
      store.db.prepare("UPDATE worker_definitions SET spec=? WHERE id=?")
        .run(JSON.stringify(legacy), legacy.id);
      const task = store.tasks.insert({
        ownerId: "owner", objective: "Preserve the original background requirements", definition: legacy,
        originTriggerId: "fixture", workspacePath: join(dir, "ws"),
      });
      store.close();
      store = Store.open(path);
      assert.deepEqual(store.catalog.getDefinition(legacy.id), legacy);
      assert.deepEqual(store.tasks.get(task.id)!.definition, legacy);
      assert.throws(() => store.catalog.upsertDefinition(legacy), /obsolete or unsupported.*start.*stop/);
      assert.deepEqual(store.catalog.getDefinition(legacy.id), legacy);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy modelProfile fields in the catalog and Task snapshots without changing tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "osa-model-migration-"));
    const path = join(dir, "state.sqlite");
    let store = Store.open(path);
    try {
      importSeed(store, join(root, "seed"));
      const definition = store.catalog.getDefinition("coding")!;
      const { model, ...rest } = definition;
      const legacy = { ...rest, modelProfile: model };
      store.db.prepare("UPDATE worker_definitions SET spec=? WHERE id=?")
        .run(JSON.stringify(legacy), definition.id);
      const task = store.tasks.insert({
        ownerId: "owner",
        objective: "Preserve the existing Task",
        definition,
        originTriggerId: "fixture",
        workspacePath: join(dir, "ws"),
      });
      store.db.prepare("UPDATE tasks SET definition=? WHERE id=?")
        .run(JSON.stringify({ ...legacy, model: "task-specific-model" }), task.id);
      store.db.exec("DELETE FROM schema_migrations WHERE version=4");
      store.close();
      store = Store.open(path);
      assert.deepEqual(store.catalog.getDefinition(definition.id), definition);
      assert.deepEqual(store.tasks.get(task.id)!.definition, {
        ...definition, model: "task-specific-model",
      });
      store.close();
      store = Store.open(path);
      assert.equal(store.tasks.get(task.id)!.definition.model, "task-specific-model");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates and imports seed", () => {
    const dir = mkdtempSync(join(tmpdir(), "osa-"));
    try {
      const store = Store.open(join(dir, "state.sqlite"));
      const imported = importSeed(store, join(root, "seed"));
      assert.ok(imported.definitions.includes("coding"));
      assert.equal(imported.skills.length, 13);
      const coding = store.catalog.getDefinition("coding");
      assert.equal(coding?.id, "coding");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes every open subscription on a shared thread", () => {
    const dir = mkdtempSync(join(tmpdir(), "osa-"));
    try {
      const store = Store.open(join(dir, "state.sqlite"));
      importSeed(store, join(root, "seed"));
      const def = store.catalog.getDefinition("coding")!;
      const makeTask = (name: string, status: "active" | "completed") =>
        store.tasks.insert({
          ownerId: "owner",
          objective: name,
          definition: def,
          originTriggerId: "fixture",
          workspacePath: join(dir, name),
          status,
        });
      const first = makeTask("first", "active");
      const second = makeTask("second", "active");
      const closed = makeTask("closed", "completed");
      store.tasks.addSubscription(first.id, "thread-shared");
      store.tasks.addSubscription(second.id, "thread-shared");
      store.tasks.addSubscription(closed.id, "thread-shared");

      const decision = decideRoute(store, { threadId: "thread-shared" });
      assert.equal(decision.kind, "tasks");
      if (decision.kind !== "tasks") throw new Error("expected tasks");
      assert.deepEqual(
        new Set(decision.taskIds),
        new Set([first.id, second.id]),
      );

      store.tasks.transition(second.id, "active", "completed");
      assert.deepEqual(decideRoute(store, { threadId: "thread-shared" }), {
        kind: "task",
        taskId: first.id,
      });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes unique subscription to task", () => {
    const dir = mkdtempSync(join(tmpdir(), "osa-"));
    try {
      const store = Store.open(join(dir, "state.sqlite"));
      importSeed(store, join(root, "seed"));
      const def = store.catalog.getDefinition("coding")!;
      const trigger = store.triggers.insert({
        source: "console",
        externalId: "e1",
        threadId: "thread-a",
        actorId: "owner",
        payloadRef: "x",
        preview: "fix bug",
        status: "routed",
      });
      const task = store.tasks.insert({
        ownerId: "owner",
        objective: "fix bug",
        definition: def,
        originTriggerId: trigger.id,
        workspacePath: join(dir, "ws"),
        status: "active",
      });
      store.tasks.addSubscription(task.id, "thread-a");

      const d = decideRoute(store, { threadId: "thread-a" });
      assert.deepEqual(d, { kind: "task", taskId: task.id });

      const d2 = decideRoute(store, {});
      assert.deepEqual(d2, { kind: "router" });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
