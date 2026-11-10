import { it } from "node:test";
import assert from "node:assert/strict";
import { temporaryApp } from "./helpers/harness.js";
import { recordedRoutes, routingTotals } from "../web/src/lib/router-trace.js";
import type { Run, RouterTrace, Task } from "../web/src/api.js";

it("serves an authenticated Router trace with the correct per-run arguments and reply", async () => {
  const h = temporaryApp();
  try {
    const origin = h.app.submitConsole({ text: "Initial goal" }).trigger;
    const { taskId } = h.app.routerTools.startTask({
      sessionId: "seed",
      runId: "seed",
      toolCallId: "seed",
      triggerIds: [origin.id],
      definition: "coding",
      objective: "Inspect fixture",
    });
    h.app.store.inbox.markDone([
      h.app.store.inbox.findByTargetTrigger("router", origin.id)!.id,
    ]);
    const message = h.app.submitConsole({
      text: "Continue this work",
      threadId: "console:router-trace",
    }).trigger;
    const batch = h.app.sessions.beginRun("router", () => "Trace fixture")!;
    h.app.store.runs.transition(batch.run.id, "pending", "submitted");
    h.app.events.emit({
      scope: "router",
      kind: "prompt",
      summary: "Trace input",
      payload: {
        runId: batch.run.id,
        model: "legacy-profile",
        resolvedModel: { provider: "fixture", id: "router-model" },
      },
    });
    h.app.events.emit({
      scope: "router",
      kind: "tool",
      summary: "unrelated",
      payload: {
        runId: "run_unrelated",
        toolCallId: "forward",
        args: { taskId: "wrong-task" },
      },
    });
    h.app.events.emit({
      scope: "router",
      kind: "tool",
      summary: "send_to_task",
      payload: {
        runId: batch.run.id,
        toolCallId: "forward",
        args: { taskId, triggerIds: [message.id] },
      },
    });
    h.app.routerTools.sendToTask({
      sessionId: batch.run.sessionId,
      runId: batch.run.id,
      toolCallId: "forward",
      taskId,
      triggerIds: [message.id],
    });
    h.app.events.emit({
      scope: "router",
      kind: "tool",
      summary: "reply",
      payload: {
        runId: batch.run.id,
        toolCallId: "reply",
        args: { triggerId: message.id, content: "Continuing" },
      },
    });
    h.app.routerTools.reply({
      sessionId: batch.run.sessionId,
      runId: batch.run.id,
      toolCallId: "reply",
      triggerId: message.id,
      content: "Continuing",
    });
    h.app.events.emit({
      scope: "router",
      kind: "assistant",
      summary: "Null payload must be safe",
      payload: null,
    });
    h.app.store.runs.transition(batch.run.id, "submitted", "completed");
    h.app.store.inbox.markDone(batch.items.map((item) => item.id));
    h.app.config.console.admin_token = "fixture-admin";
    await h.api.start();
    const path = `${h.api.url}/api/router/runs/${batch.run.id}`;
    assert.equal((await fetch(path)).status, 401);
    const headers = { Authorization: "Bearer fixture-admin" };
    const response = await fetch(path, { headers });
    assert.equal(response.status, 200);
    const trace = (await response.json()) as RouterTrace;
    assert.equal(trace.inputs[0]!.threadId, "console:router-trace");
    assert.equal(
      trace.actions.find((action) => action.tool === "send_to_task")!.args!
        .taskId,
      taskId,
    );
    assert.equal(
      trace.actions.find((action) => action.tool === "reply")!.replyText,
      "Continuing",
    );
    assert.equal(trace.journal.length, 3);
    assert.deepEqual(trace.model, {
      provider: "fixture",
      model: "router-model",
    });
    const task = {
      ...h.app.store.tasks.get(taskId)!,
      source: "console",
      runCount: 0,
    };
    const route = recordedRoutes(trace, trace, [task]);
    assert.equal(route.outcome, "mixed");
    assert.deepEqual(route.targets[0]!.taskIds, [taskId]);
    const workerRun = h.app.store.runs.create(
      h.app.sessions.ensureSession(taskId).id,
    );
    assert.equal(
      (await fetch(`${h.api.url}/api/router/runs/${workerRun.id}`, { headers }))
        .status,
      404,
    );
    assert.equal(
      (await fetch(`${h.api.url}/api/router/runs/run_unknown`, { headers }))
        .status,
      404,
    );
    const legacyRun = h.app.store.runs.create(batch.run.sessionId);
    h.app.events.emit({
      scope: "router",
      kind: "prompt",
      summary: "Legacy model profile",
      payload: { runId: legacyRun.id, model: "old-profile" },
    });
    const legacy = await (
      await fetch(`${h.api.url}/api/router/runs/${legacyRun.id}`, { headers })
    ).json();
    assert.equal(
      legacy.model,
      null,
      "A legacy profile name is not proof of the model used",
    );
  } finally {
    await h.close();
  }
});

const at = "2026-11-10T00:00:00.000Z";
const run: Run = {
  id: "run_trace",
  status: "completed",
  createdAt: at,
  updatedAt: at,
  inputs: [],
  actions: [],
};
const task = {
  id: "task_one",
  definition: { id: "research" },
  status: "completed",
} as Task;
const action = (tool: string, result: unknown) => ({
  tool,
  result,
  toolCallId: tool,
  createdAt: at,
});

it("does not invent a dispatch or reply from an assistant message or a failed tool action", () => {
  const trace: RouterTrace = {
    ...run,
    actions: [],
    journal: [
      {
        id: "event",
        scope: "router",
        kind: "assistant",
        summary: "I created a task",
        payload: null,
        createdAt: at,
      },
    ],
  };
  assert.equal(recordedRoutes(run, trace, [task]).outcome, "unrecorded");
  const failed: RouterTrace = {
    ...trace,
    actions: [
      {
        ...action("send_to_task", { ok: false }),
        args: { taskId: task.id },
        replyText: null,
      },
    ],
  };
  assert.equal(recordedRoutes(run, failed, [task]).outcome, "failed");
  assert.deepEqual(recordedRoutes(run, failed, [task]).targets, []);
  const empty: RouterTrace = {
    ...trace,
    actions: [{ ...action("reply", null), args: null, replyText: null }],
  };
  assert.equal(recordedRoutes(run, empty, [task]).reply, false);
});

it("shows recorded targets while exposing missing historical task references", () => {
  const record: Run = {
    ...run,
    actions: [
      action("start_task", { taskId: task.id, created: true }),
      action("start_task", { taskId: "task_missing", created: true }),
    ],
  };
  const route = recordedRoutes(record, null, [task]);
  assert.equal(route.outcome, "dispatched");
  assert.equal(route.missingTarget, true);
  assert.equal(route.targets[0]!.workerId, "research");
  const reply = {
    ...run,
    actions: [action("reply", { deliveryId: "delivery" })],
  };
  assert.equal(recordedRoutes(reply, null, [task]).outcome, "replied");
  assert.equal(
    recordedRoutes({ ...run, status: "submitted" }, null, []).outcome,
    "deciding",
  );
});

it("counts unique created tasks and reply deliveries rather than repeated tool records", () => {
  const records = [
    {
      ...run,
      actions: [
        action("start_task", { taskId: "one", created: true }),
        action("start_task", { taskId: "one", created: true }),
        action("start_task", { taskId: "reused", created: false }),
        action("start_task", { taskId: "two", created: true }),
        action("reply", { deliveryId: "reply-one" }),
        action("reply", { deliveryId: "reply-one" }),
      ],
    },
  ];
  assert.deepEqual(routingTotals(records), { created: 2, replies: 1 });
});
