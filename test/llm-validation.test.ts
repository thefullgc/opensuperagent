import { it } from "node:test";
import assert from "node:assert/strict";
import { pizzaHarness, submitResultCall } from "./helpers/pizza.js";

it("Pizza rejects malformed submissions before side effects and accepts a valid retry", async () => {
  const valid = {
    outcome: "completed",
    notice: "Verified",
    summary: "Validated before execution",
    artifacts: ["verified.txt"],
  };
  const invalid = [
    null,
    [],
    { outcome: "completed", notice: "Missing summary" },
    { ...valid, outcome: "invented" },
    { ...valid, summary: null },
    { ...valid, artifacts: [123] },
    { ...valid, extra: true },
  ];
  let count = 0;
  const h = await pizzaHarness(() => {
    assert.equal(h.app.store.db.prepare("SELECT COUNT(*) n FROM tool_actions WHERE tool='submit_result'").get()!.n, 0);
    return { calls: [submitResultCall(count < invalid.length ? invalid[count++] : valid)] };
  });
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    assert.deepEqual(h.app.store.tasks.get(id)?.result, valid);
    const results = h.app.events
      .list(id)
      .filter((e) => e.kind === "tool_result");
    assert.equal(
      results.filter((e) => !(e.payload as any)?.details?.command).length,
      invalid.length,
    );
    assert.equal(h.requests.length, invalid.length + 1);
    assert.equal(
      h.app.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tool_actions WHERE tool='submit_result'",
        )
        .get()?.n,
      1,
    );
  } finally {
    await h.close();
  }
});

it("dispatches _submit_result help and flags through CLI without granting ordinary command permissions", async () => {
  const commands = [
    "_submit_result --help",
    "_submit_result --outcome completed --notice Done --summary Verified --taskId other-task",
    "_submit_result --outcome completed --notice Done --summary Verified --artifact report.txt --artifact 'other file.txt'",
  ];
  let round = 0;
  const h = await pizzaHarness(() => {
    assert.equal(h.app.store.db.prepare("SELECT COUNT(*) n FROM tool_actions").get()!.n, 1,
      "only the Router's existing start_task receipt may exist before valid submission");
    return { calls: [{ name: "cli", args: { command: commands[round++] } }] };
  });
  try {
    const base = h.app.store.catalog.getDefinition("coding")!;
    h.app.store.catalog.upsertDefinition({ ...base, id: "result-only", tools: [], cli: { allowShell: false } });
    const id = h.task("result-only");
    await h.app.workerLoop.tick(id);
    assert.deepEqual(h.requests[0].tools.map((tool: any) => tool.function.name), ["cli"]);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
    assert.deepEqual(h.app.store.tasks.get(id)!.result?.artifacts, ["report.txt", "other file.txt"]);
    assert.equal(round, 3);
    const output = h.app.events.list(id).find((event) =>
      (event.payload as any)?.details?.command?.name === "_submit_result",
    )!;
    assert.equal((output.payload as any).result.ok, true);
    assert.equal((output.payload as any).details.command.details.result.ok, true);
  } finally { await h.close(); }
});

it("treats result JSON as literal data and rejects attempts to supply a different Task or Run", async () => {
  let round = 0;
  const valid = {
    outcome: "completed", notice: "Done",
    summary: "Line one\nLine two; $(touch forbidden.txt) 'quoted' \"double quoted\"",
  };
  const h = await pizzaHarness(() => ({ calls: [submitResultCall(
    round++ === 0 ? { ...valid, taskId: "another-task", runId: "another-run" } : valid,
  )] }));
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const id = h.task();
    await h.app.workerLoop.tick(id);
    assert.deepEqual(h.app.store.tasks.get(id)!.result, valid);
    assert.equal(existsSync(join(h.app.paths.workspace(id), "forbidden.txt")), false);
    assert.equal(h.app.store.db.prepare("SELECT COUNT(*) n FROM tool_actions WHERE tool='submit_result'").get()!.n, 1);
  } finally { await h.close(); }
});

it("stops queued workspace mutations after _submit_result completes the Task", async () => {
  const h = await pizzaHarness(() => ({ calls: [
    submitResultCall({ outcome: "completed", notice: "Done", summary: "Finish before any further mutation" }),
    { name: "cli", args: { command: "_write after-completion.txt --content forbidden" } },
  ] }));
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const id = h.task();
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
    assert.equal(existsSync(join(h.app.paths.workspace(id), "after-completion.txt")), false);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

it("ends the Run after needs_input and accepts completion through _submit_result in a later Run", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ({ calls: [submitResultCall({
    outcome: round++ === 0 ? "needs_input" : "completed",
    notice: "Verified", summary: "Request input, then resume with the answer",
  }, `result-${round}`)] }));
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    assert.equal(h.requests.length, 1);
    assert.equal(h.app.store.tasks.get(id)!.status, "waiting");
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
    h.app.submitConsole({ taskId: id, text: "Here is the requested input; continue" });
    await h.app.workerLoop.tick(id);
    assert.equal(h.requests.length, 2);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
  } finally { await h.close(); }
});
