import { it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pizzaHarness, submitResultCall } from "./helpers/pizza.js";

it("uses the actual Pizza SDK with persistent run receipts and complete tool telemetry", async () => {
  let calls = 0;
  const h = await pizzaHarness(() =>
    ++calls === 1
      ? {
          calls: [
            {
              name: "cli",
              args: { command: "_skill load --name test-driven-fix" },
            },
          ],
        }
      : { text: "Skill loaded" },
  );
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.engineMode, "pizza");
    const prompt = h.app.events.list(id).find(event => event.kind === "prompt");
    assert.deepEqual((prompt?.payload as { resolvedModel?: unknown })?.resolvedModel, { provider: "probe", id: h.requests[0].model });
    const tool = h.app.events
      .list(id)
      .find((e) => e.kind === "tool" && e.summary === "cli");
    assert.equal((tool?.payload as any)?.args?.command, "_skill load --name test-driven-fix");
    const result = h.app.events.list(id).find((e) => e.kind === "tool_result");
    assert.equal((result?.payload as any)?.details?.builtin?.name, "skill");
    assert.match(JSON.stringify((result?.payload as any)?.result), /test-driven-fix/);
    const session = h.app.store.sessions.getByOwner(id)!;
    const db = new DatabaseSync(session.eventsPath, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM events WHERE type='USER_MESSAGE' AND idempotency_key LIKE 'run:%'",
          )
          .get()!.n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await h.close();
  }
});

it("refreshes the model for the next Run on the same Pizza session after abort", async () => {
  const h = await pizzaHarness(() => ({ text: "Waiting for input" }));
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    await h.app.sessions.get(id)!.abort("steer");
    h.app.settings.saveRouting({
      router: { providerId: "probe", model: "router" },
      worker: { providerId: "probe", model: "worker-b" },
      profiles: {},
    });
    h.app.submitConsole({ taskId: id, text: "Continue after steering" });
    await h.app.workerLoop.tick(id);
    assert.equal(h.requests.at(-1).model, "worker-b");
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
  } finally {
    await h.close();
  }
});

it("resubmits an unreceived Run with the same ID instead of wedging accepted inputs", async () => {
  const h = await pizzaHarness(() => ({ text: "Recovered" }));
  try {
    const id = h.task();
    const batch = h.app.sessions.beginRun(
      id,
      () => "Submission that never reached Pizza",
    )!;
    h.app.store.runs.transition(batch.run.id, "pending", "submitted");
    assert.equal(await h.app.sessions.recoverIncomplete(), 1);
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.store.runs.get(batch.run.id)!.status, "completed");
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
    assert.equal(h.requests.length, 1);
  } finally {
    await h.close();
  }
});

it("reconciles a completed Pizza receipt without replaying a model request", async () => {
  const h = await pizzaHarness(() => ({ text: "Finished" }));
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    const session = h.app.store.sessions.getByOwner(id)!;
    const run = h.app.store.db
      .prepare("SELECT id FROM runs WHERE session_id=?")
      .get(session.id)!;
    h.app.store.db
      .prepare("UPDATE runs SET status='submitted' WHERE id=?")
      .run(run.id!);
    h.app.store.db
      .prepare("UPDATE inbox SET status='accepted' WHERE run_id=?")
      .run(run.id!);
    await h.app.sessions.closeAll();
    await h.app.sessions.recoverIncomplete();
    assert.equal(h.app.store.runs.get(String(run.id))!.status, "completed");
    // The text-only turn queued a result follow-up, not a replay of its original input.
    const followups = h.app.store.inbox.listPending(id);
    assert.equal(followups.length, 1);
    assert.equal(h.app.store.triggers.get(followups[0]!.triggerId)!.externalId, `worker-result:${String(run.id)}:1`);
    assert.equal(h.app.store.inbox.listAccepted(String(run.id)).length, 0);
    assert.equal(h.requests.length, 1);
  } finally {
    await h.close();
  }
});

it("recovers an actual SIGKILL between a file side effect and Pizza's tool receipt", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  let count = 0;
  const h = await pizzaHarness(() => {
    count++;
    if (count === 1)
      return {
        calls: [
          {
            name: "cli",
            id: "crash-write",
            args: { command: "printf EXACTLY_ONCE > once.txt; kill -KILL $PPID" },
          },
        ],
      };
    if (count === 2)
      return {
        calls: [
          { name: "cli", id: "read-recovered", args: { command: "_read once.txt --anchors none" } },
        ],
      };
    return {
      calls: [
        submitResultCall({
            outcome: "completed",
            notice: "Recovered",
            summary: "Read the existing file; no repeated write",
          }, "finish-recovered"),
      ],
    };
  });
  try {
    const id = h.task();
    const configPath = join(h.dir, "child-config.json");
    writeFileSync(configPath, JSON.stringify(h.config));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/helpers/pizza-crash-child.ts", configPath, id],
      { stdio: "ignore" },
    );
    const exited = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exited.signal, "SIGKILL");
    assert.equal(
      readFileSync(join(h.app.paths.workspace(id), "once.txt"), "utf8"),
      "EXACTLY_ONCE",
    );
    const oldRun = h.app.store.runs.listIncomplete()[0]!;
    assert.equal(oldRun.status, "submitted");
    await h.app.sessions.recoverIncomplete();
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
    assert.equal(h.app.store.runs.get(oldRun.id)!.status, "failed");
    assert.equal(count, 3);
    const db = new DatabaseSync(
      h.app.store.sessions.getByOwner(id)!.eventsPath,
      { readOnly: true },
    );
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM events WHERE type='USER_MESSAGE' AND idempotency_key LIKE 'run:%'",
          )
          .get()!.n,
        2,
      );
      const recovered = db
        .prepare(
          "SELECT payload_json FROM events WHERE type='TOOL_EXECUTION_END'",
        )
        .all()
        .map((row) => JSON.parse(String(row.payload_json)))
        .find((row) => row.tool_call_id === "crash-write");
      assert.equal(recovered.is_error, true);
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM events WHERE type='TOOL_EXECUTION_START' AND json_extract(payload_json,'$.tool_call_id')='crash-write'",
          )
          .get()!.n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await h.close();
  }
});

it("keeps pre-existing server operations in scheduling rather than delegating them to native tools", async () => {
  const h = await pizzaHarness(() => ({
    calls: [
      {
        name: "cli",
        args: { command: "_write should-not-exist.txt --content busy" },
      },
    ],
  }));
  let operationId = "";
  try {
    const id = h.task();
    const task = h.app.store.tasks.get(id)!;
    operationId = h.app.runner.startBackground({
      taskId: id,
      cwd: task.workspacePath,
      cmd: "sleep 30",
    }).id;
    assert.equal(await h.app.workerLoop.tick(id), false);
    assert.equal(h.requests.length, 0, "an existing server operation blocks scheduling before any model call");
    assert.ok(h.app.store.inbox.listPending(id).length);
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
    const { existsSync } = await import("node:fs");
    assert.equal(
      existsSync(task.workspacePath + "/should-not-exist.txt"),
      false,
    );
  } finally {
    if (operationId) {
      h.app.runner.stop(operationId);
      const { eventually } = await import("./helpers/harness.js");
      const { existsSync } = await import("node:fs");
      await eventually(() =>
        existsSync(h.app.paths.operationDir(operationId) + "/result.json"),
      );
    }
    await h.close();
  }
});

it("rejects invalid native CLI arguments before writes and only exposes native CLI", async () => {
  let calls = 0;
  const h = await pizzaHarness(() =>
    ++calls === 1
      ? { calls: [{ name: "cli", args: { command: "_write bad.txt --content forbidden", timeout: "invalid" } }] }
      : { text: "Invalid arguments handled" },
  );
  try {
    const id = h.task("docs");
    await h.app.workerLoop.tick(id);
    const names = h.requests[0].tools.map((t: any) => t.function.name);
    assert.deepEqual(names, ["cli"]);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(h.app.paths.workspace(id) + "/bad.txt"), false);
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
  } finally {
    await h.close();
  }
});

it("aborts an in-flight SDK model request and accepts a later Run on that session", async () => {
  const { deferred, eventually } = await import("./helpers/harness.js");
  const gate = deferred();
  let held = false;
  const h = await pizzaHarness(async () => {
    if (!held) {
      held = true;
      await gate.promise;
      return;
    }
    return { text: "Resumed successfully" };
  });
  try {
    const id = h.task();
    const first = h.app.workerLoop.tick(id);
    await eventually(() => held);
    await h.app.sessions.get(id)!.abort("steer");
    await first;
    h.app.submitConsole({ taskId: id, text: "Follow-up after abort" });
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
    assert.equal(h.requests.length, 2);
    const statuses = h.app.store.db
      .prepare("SELECT status FROM runs WHERE session_id=? ORDER BY created_at")
      .all(h.app.store.sessions.getByOwner(id)!.id)
      .map((r) => r.status);
    assert.deepEqual(statuses, ["aborted", "completed"]);
  } finally {
    gate.resolve();
    await h.close();
  }
});

it("resets the per-Run call budget after an exhausted Pizza turn", async () => {
  let round = 0;
  let exhausted = false;
  const h = await pizzaHarness(() =>
    exhausted
      ? { text: "New Run within budget" }
      : {
          calls: [
            // Distinct args per round so Pizza's identical-call loop guard
            // stays out of the way and the Run reaches our call budget.
            { name: "cli", args: { command: `_read missing-${++round}.txt` } },
          ],
        },
  );
  try {
    const id = h.task();
    await assert.rejects(h.app.workerLoop.tick(id), /budget exceeded/);
    const sent = h.requests.length;
    exhausted = true;
    h.app.submitConsole({ taskId: id, text: "New independent turn" });
    await h.app.workerLoop.tick(id);
    assert.ok(h.requests.length > sent);
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
  } finally {
    await h.close();
  }
});

it("restores Pizza conversation context from disk and keeps other Tasks isolated", async () => {
  const h = await pizzaHarness(() => ({ text: "Context acknowledged" }));
  try {
    const a = h.task("coding", "TASK_A_PRIVATE_MARKER");
    await h.app.workerLoop.tick(a);
    const b = h.task("coding", "TASK_B_PRIVATE_MARKER");
    await h.app.workerLoop.tick(b);
    assert.ok(
      !JSON.stringify(h.requests.at(-1).messages).includes(
        "TASK_A_PRIVATE_MARKER",
      ),
    );
    await h.app.sessions.closeAll();
    h.app.submitConsole({
      taskId: a,
      text: "Continue the earlier conversation",
    });
    await h.app.workerLoop.tick(a);
    const context = JSON.stringify(h.requests.at(-1).messages);
    assert.ok(
      context.includes("TASK_A_PRIVATE_MARKER") &&
        context.includes("Context acknowledged"),
    );
    assert.ok(!context.includes("TASK_B_PRIVATE_MARKER"));
  } finally {
    await h.close();
  }
});

it("rejects a corrupt persisted Pizza session", async () => {
  const { writeFileSync } = await import("node:fs");
  const h = await pizzaHarness(() => ({ text: "Must not reach model" }));
  try {
    const id = h.task();
    const session = h.app.sessions.ensureSession(id);
    writeFileSync(session.eventsPath, "corrupt event database");
    await assert.rejects(h.app.sessions.open(id), /database|file is not/i);
    assert.equal(h.requests.length, 0);
  } finally {
    await h.close();
  }
});

it("serializes parallel tools within a Task while keeping every real command result", async () => {
  let calls = 0;
  const h = await pizzaHarness(() =>
    ++calls === 1
      ? {
          calls: [
            {
              name: "cli",
              id: "parallel-one",
              args: { command: "sleep 0.1; printf FIRST" },
            },
            {
              name: "cli",
              id: "parallel-two",
              args: { command: "printf SECOND" },
            },
          ],
        }
      : {
          calls: [
            submitResultCall({
                outcome: "completed",
                notice: "Both done",
                summary: "Two ordered commands verified",
              }, "parallel-finish"),
          ],
        },
  );
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    const commands = h.app.events
      .list(id)
      .filter(
        (event) =>
          event.kind === "tool_result" && event.summary.startsWith("cli →") &&
          (event.payload as any).details?.builtin?.name !== "_submit_result",
      )
      .map((event) => (event.payload as any).result);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands.map((result) => result.map((block: any) => block.text).join("\n")).sort(), [
      "FIRST", "SECOND",
    ]);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
  } finally {
    await h.close();
  }
});

it("releases Pizza's process listeners when short-lived sessions close", async () => {
  const signals = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  const h = await pizzaHarness(() => ({ text: "Done" }));
  try {
    for (let i = 0; i < 3; i++) {
      const id = h.task();
      await h.app.workerLoop.tick(id);
      await h.app.sessions.closeAll();
    }
    assert.deepEqual(
      signals.map((signal) => process.listenerCount(signal)),
      before,
    );
  } finally {
    await h.close();
  }
});

it("uses Pizza's native Anthropic streaming protocol and application tools", async () => {
  let requests = 0;
  const h = await pizzaHarness((body, res) => {
    requests++;
    assert.equal(body.model, "claude-fixture");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (type: string, payload: unknown) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...(payload as object) })}\n\n`,
      );
    send("message_start", {
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    if (requests === 1) {
      send("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "anthropic-write",
          name: "cli",
          input: {},
        },
      });
      send("content_block_delta", {
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            command: "_write anthropic.txt --content ANTHROPIC_OK",
          }),
        },
      });
    } else {
      send("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "File verified" },
      });
    }
    send("content_block_stop", { index: 0 });
    send("message_delta", {
      delta: {
        stop_reason: requests === 1 ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 10 },
    });
    send("message_stop", {});
    res.end();
  });
  try {
    h.app.settings.saveProvider({
      id: "anthropic",
      name: "Anthropic",
      protocol: "anthropic",
      baseUrl: h.remote.url,
      apiKey: "anthropic-fixture-key",
      models: ["claude-fixture"],
    });
    h.app.settings.saveRouting({
      router: { providerId: "probe", model: "router" },
      worker: { providerId: "anthropic", model: "claude-fixture" },
      profiles: {},
    });
    const id = h.task();
    await h.app.workerLoop.tick(id);
    const { readFileSync } = await import("node:fs");
    assert.equal(
      readFileSync(h.app.paths.workspace(id) + "/anthropic.txt", "utf8"),
      "ANTHROPIC_OK",
    );
    assert.equal(requests, 2);
    assert.equal(h.app.engineMode, "pizza");
  } finally {
    await h.close();
  }
});

it("rotates credentials for the next Run without recreating the Pizza session", async () => {
  const h = await pizzaHarness(() => ({ text: "Authorized" }));
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    h.app.settings.saveProvider({
      id: "probe",
      name: "Probe",
      baseUrl: h.remote.url,
      apiKey: "rotated-fixture-key",
      models: ["router", "worker-a"],
    });
    h.app.submitConsole({ taskId: id, text: "Use rotated credentials" });
    await h.app.workerLoop.tick(id);
    assert.equal(h.headers[0]?.authorization, "Bearer probe-secret");
    assert.equal(h.headers.at(-1)?.authorization, "Bearer rotated-fixture-key");
  } finally {
    await h.close();
  }
});

it("keeps a truncated SDK turn failed when reconciling its durable completion", async () => {
  const h = await pizzaHarness(() => ({
    text: "Truncated",
    finishReason: "length",
  }));
  try {
    const id = h.task();
    await assert.rejects(h.app.workerLoop.tick(id), /length limit/);
    const session = h.app.store.sessions.getByOwner(id)!;
    const run = h.app.store.db
      .prepare("SELECT id FROM runs WHERE session_id=?")
      .get(session.id)!;
    h.app.store.db
      .prepare("UPDATE runs SET status='submitted' WHERE id=?")
      .run(run.id!);
    await h.app.sessions.closeAll();
    await h.app.sessions.recoverIncomplete();
    assert.equal(h.app.store.runs.get(String(run.id))!.status, "failed");
  } finally {
    await h.close();
  }
});
