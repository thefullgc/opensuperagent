import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ChatTool } from "../src/llm/types.js";
import type { Task } from "../src/types.js";
import { temporaryApp } from "./helpers/harness.js";
import { pizzaHarness } from "./helpers/pizza.js";

it("exposes Router and Watchdog function tools through Pizza with separate permissions", async () => {
  let round = 0;
  let taskId: string;
  const h = await pizzaHarness(() => {
    switch (++round) {
      case 1:
        return { calls: [{ name: "list_tasks", args: {}, id: "router-list" }] };
      case 3:
        return { calls: [
          { name: "read_task", args: { taskId }, id: "watchdog-read" },
          { name: "stop_task", args: { taskId }, id: "watchdog-stop" },
          { name: "cli", args: { command: "pwd" }, id: "watchdog-cli" },
        ] };
      default:
        return { text: "Tools verified" };
    }
  });
  const toolNames = (request: { tools: ChatTool[] }) => request.tools.map((tool) => tool.function.name).sort();
  const toolResults = (owner: string) => h.app.events.list(owner)
    .filter((event) => event.kind === "tool_result")
    .map((event) => event.payload as { toolCallId: string; isError: boolean; result: unknown });
  try {
    h.app.submitConsole({ text: "Inspect tasks" });
    assert.equal(await h.app.routerLoop.tick(), true);
    assert.deepEqual(toolNames(h.requests[0]), [
      "list_tasks", "read_task", "read_trigger", "reply", "send_to_task", "start_task", "stop_task",
    ]);
    assert.deepEqual(toolResults("router").find((result) => result.toolCallId === "router-list")?.result, []);

    const { app } = h;
    app.config.supervisor.stall_after_sec = 60;
    const task = app.store.tasks.insert({
      ownerId: "owner",
      objective: "stalled task",
      definition: app.store.catalog.getDefinition("coding")!,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "stalled"),
      status: "waiting",
    });
    taskId = task.id;
    const old = new Date(Date.now() - 120_000).toISOString();
    app.store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(old, taskId);

    assert.equal(await app.watchdogLoop.tick(), true);
    assert.deepEqual(toolNames(h.requests[2]), ["list_tasks", "read_task", "read_trigger"]);
    const outputs = toolResults("watchdog");
    const read = outputs.find((result) => result.toolCallId === "watchdog-read");
    assert.equal(read?.isError, false);
    assert.equal((read?.result as Task | undefined)?.id, taskId);
    assert.equal(outputs.find((result) => result.toolCallId === "watchdog-stop")?.isError, true);
    assert.equal(outputs.find((result) => result.toolCallId === "watchdog-cli")?.isError, true);
    assert.equal(app.store.tasks.get(taskId)?.status, "waiting");
  } finally {
    await h.close();
  }
});

it("escalates a stalled waiting Task to a read-only Watchdog run", async () => {
  const h = temporaryApp();
  const { app } = h;
  app.config.supervisor.stall_after_sec = 60;
  try {
    const def = app.store.catalog.getDefinition("coding")!;
    const task = app.store.tasks.insert({
      ownerId: "owner",
      objective: "stalled task",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "stalled"),
      status: "waiting",
    });
    const old = new Date(Date.now() - 120_000).toISOString();
    app.store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(old, task.id);

    const first = await app.watchdogLoop.tick();
    assert.equal(first, true);

    const externalId = `stall:${task.id}:${old}`;
    const trigger = app.store.triggers.findByExternal("watchdog", externalId);
    assert.ok(trigger);
    assert.equal(app.store.inbox.listPending("watchdog").length, 0);
    assert.ok(
      app.events.list("system").some((event) => event.kind === "watchdog"),
    );
    assert.ok(
      app.events.list("watchdog").some((event) => event.kind === "assistant"),
    );

    assert.ok(
      app.events
        .list("watchdog")
        .some((event) => event.summary.includes(task.id)),
    );

    const progressed = app.store.tasks.insert({
      ownerId: "owner",
      objective: "recent progress",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "progressed"),
      status: "waiting",
    });
    app.store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(old, progressed.id);
    app.events.emit({
      scope: progressed.id,
      kind: "progress",
      summary: "task is still active",
    });

    const terminal = app.store.tasks.insert({
      ownerId: "owner",
      objective: "terminal",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "terminal"),
      status: "completed",
    });
    app.store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(old, terminal.id);

    const second = await app.watchdogLoop.tick();
    assert.equal(second, false);
    const count = app.store.db
      .prepare("SELECT COUNT(*) AS c FROM triggers WHERE source = 'watchdog'")
      .get() as { c: number };
    assert.equal(count.c, 1);
  } finally {
    await h.close();
  }
});
