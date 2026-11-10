import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { temporaryApp, eventually } from "./helpers/harness.js";

function task(
  h: ReturnType<typeof temporaryApp>,
  objective = "Preserve GOAL_FINAL_MARKER",
) {
  const trigger = h.app.submitConsole({ text: objective }).trigger;
  return h.app.routerTools.startTask({
    sessionId: "router",
    runId: "test",
    toolCallId: "start",
    triggerIds: [trigger.id],
    definition: "coding",
    objective,
  }).taskId;
}

it("rejects invalid deadlines and timeouts before starting an operation", async () => {
  const h = temporaryApp();
  try {
    const id = task(h),
      cwd = h.app.store.tasks.get(id)!.workspacePath;
    for (const deadlineAt of ["2020-01-01T00:00:00Z", "invalid-date"])
      assert.throws(
        () =>
          h.app.runner.startBackground({
            taskId: id,
            cwd,
            cmd: "sleep 30",
            deadlineAt,
          }),
        /future timestamp/,
      );
    for (const timeoutSec of [0, -1, NaN])
      await assert.rejects(
        h.app.runner.execSync({ taskId: id, cwd, cmd: "sleep 30", timeoutSec }),
        /positive finite/,
      );
    assert.equal(
      h.app.store.db.prepare("SELECT COUNT(*) AS n FROM operations").get()!.n,
      0,
    );
  } finally {
    await h.close();
  }
});

it("records foreground and background launch failures without crashing or leaving the Task busy", async () => {
  const h = temporaryApp();
  try {
    const id = task(h);
    const input = { taskId: id, cwd: `${h.dir}/missing`, cmd: "printf done" };
    const foreground = await h.app.runner.execSync(input);
    assert.equal(foreground.operation.status, "failed");
    assert.match(foreground.log, /ENOENT/);
    assert.equal(h.app.runner.assertIdle(id), null);

    const background = h.app.runner.startBackground(input);
    await eventually(() => existsSync(h.app.paths.operationDir(background.id) + "/result.json"));
    assert.deepEqual(h.app.runner.poll(), [background.id]);
    const finished = h.app.store.operations.get(background.id)!;
    assert.equal(finished.status, "failed");
    assert.match(readFileSync(finished.logPath!, "utf8"), /ENOENT/);
    assert.equal(h.app.runner.assertIdle(id), null);
  } finally {
    await h.close();
  }
});

it("wakes the Worker exactly once when supervision runs before a background completion is pumped", async () => {
  const prompts: string[] = [];
  const h = temporaryApp((factory) => async (input) => {
    const handle = await factory(input);
    return { ...handle, async prompt(text: string) {
      if (input.session.owner !== "router") prompts.push(text);
      await handle.prompt(text);
    } };
  });
  try {
    const id = task(h);
    const op = h.app.runner.startBackground({
      taskId: id,
      cwd: h.app.store.tasks.get(id)!.workspacePath,
      cmd: "printf done",
    });
    assert.equal(await h.app.workerLoop.tick(id), false);
    assert.equal(prompts.length, 0);
    await eventually(() => existsSync(h.app.paths.operationDir(op.id) + "/result.json"));

    await h.app.supervisor.check();
    await h.app.pump();
    await h.app.pump();

    assert.equal(h.app.store.operations.get(op.id)!.status, "succeeded");
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes(`Operation ${op.id} succeeded`));
    assert.equal(h.app.store.inbox.listPending(id).length, 0);
  } finally {
    await h.close();
  }
});

it("Router cancellation terminates the actual background process group and aborts the Worker", async () => {
  let aborted = 0;
  const h = temporaryApp((factory) => async (input) => {
    const facade = await factory(input);
    return {
      ...facade,
      async abort(reason?: string) {
        aborted++;
        await facade.abort(reason);
      },
    };
  });
  let pgid = 0;
  const alive = () => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const id = task(h),
      cwd = h.app.store.tasks.get(id)!.workspacePath;
    await h.app.sessions.open(id);
    const op = h.app.runner.startBackground({
      taskId: id,
      cwd,
      cmd: "sleep 30",
    });
    pgid = op.pgid!;
    assert.ok(pgid > 0 && alive());
    h.app.routerTools.stopTask({
      sessionId: "router",
      runId: "test",
      toolCallId: "cancel",
      taskId: id,
    });
    await eventually(() => !alive());
    await eventually(() => existsSync(h.app.paths.operationDir(op.id) + "/result.json"));
    assert.equal(aborted, 1);
    assert.equal(h.app.store.tasks.get(id)!.status, "cancelled");
    assert.equal(h.app.store.operations.get(op.id)!.status, "cancelled");
  } finally {
    if (pgid > 0 && alive()) process.kill(-pgid, "SIGKILL");
    await h.close();
  }
});

it("keeps the Task objective and earlier requirements across multiple Runs and a new session facade", async () => {
  const prompts: string[] = [];
  const h = temporaryApp((factory) => async (input) => {
    const facade = await factory(input);
    return {
      ...facade,
      async prompt(text: string) {
        prompts.push(text);
      },
    };
  });
  try {
    const id = task(h);
    await h.app.workerLoop.tick(id);
    h.app.submitConsole({ taskId: id, text: "Preserve REQUIREMENT_ONE" });
    await h.app.workerLoop.tick(id);
    await h.app.sessions.closeAll();
    h.app.submitConsole({ taskId: id, text: "Preserve REQUIREMENT_TWO" });
    await h.app.workerLoop.tick(id);
    const prompt = prompts.at(-1)!;
    assert.ok(prompt.includes("GOAL_FINAL_MARKER"));
    assert.ok(prompt.includes("REQUIREMENT_ONE"));
    assert.ok(prompt.includes("REQUIREMENT_TWO"));
    assert.match(prompt, /Current UTC time: \d{4}-\d{2}-\d{2}T/);
    assert.ok(prompt.split("## New inputs")[1]!.includes("REQUIREMENT_TWO"));
    assert.ok(!prompt.split("## New inputs")[1]!.includes("REQUIREMENT_ONE"));
  } finally {
    await h.close();
  }
});
