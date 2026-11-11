import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pizzaHarness, submitResultCall } from "./helpers/pizza.js";

const cli = (command: string) => ({ name: "cli", args: { command } });
const results = (h: Awaited<ReturnType<typeof pizzaHarness>>, id: string) =>
  h.app.events.list(id).filter((event) => event.kind === "tool_result");

it("exposes only Pizza's native CLI schema for all snapshotted Worker command lists", async () => {
  const h = await pizzaHarness(() => ({ text: "Tools inspected" }));
  try {
    for (const definition of h.app.store.catalog.listActiveDefinitions()) {
      const id = h.task(definition.id);
      h.app.store.catalog.upsertDefinition({ ...definition, tools: [] });
      await h.app.workerLoop.tick(id);
      const sent = h.requests.at(-1).tools;
      assert.deepEqual(sent.map((tool: any) => tool.function.name).sort(), ["cli"]);
      const schema = sent[0].function.parameters;
      assert.deepEqual(schema.required, ["command"]);
      assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "timeout"]);
      assert.equal(schema.properties.command.type, "string");
      assert.equal(schema.properties.timeout.type, "number");
      await h.app.sessions.closeAll();
    }
  } finally { await h.close(); }
});

it("runs native underscore file and skill commands plus native shell, preserving native results", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ++round === 1 ? {
    calls: [
      cli("_write proof.txt --content before"),
      cli(`_edit proof.txt --edits '[{"op":"search","old":"before","new":"after"}]'`),
      cli("_read proof.txt --anchors none"),
      cli("cat proof.txt"),
      cli("_skill load --name test-driven-fix"),
    ],
  } : {
    calls: [submitResultCall({
      outcome: "completed", notice: "Verified", summary: "Native tools executed",
    })],
  });
  try {
    const id = h.task();
    await h.app.workerLoop.tick(id);
    assert.equal(readFileSync(join(h.app.paths.workspace(id), "proof.txt"), "utf8"), "after");
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
    const output = results(h, id);
    assert.equal(output.length, 6);
    assert.ok(output.every((event) => !(event.payload as any).isError));
    const commands = output.map((event) => (event.payload as any).details?.command).filter(Boolean);
    assert.deepEqual(commands.map((command) => command.name).sort(), ["_edit", "_read", "_skill", "_submit_result", "_write"]);
    assert.match(commands.find((command) => command.name === "_edit").details.diff, /after/);
    const returned = JSON.stringify(h.requests[1].messages.filter((message: any) => message.role === "tool"));
    assert.match(returned, /after/);
    assert.match(returned, /test-driven-fix/);
    assert.equal(h.app.store.db.prepare("SELECT COUNT(*) n FROM operations").get()!.n, 0,
      "native shell must not delegate to the application CommandRunner");
  } finally { await h.close(); }
});

it("enforces docs CLI permissions including shell and quoted-command bypasses", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ++round === 1 ? { calls: [
    cli("printf forbidden > forbidden.txt"),
    cli("'_write' forbidden.txt --content forbidden"),
    cli("_session_split"),
    cli("_write allowed.txt --content allowed"),
    cli("_skill load --name technical-writing"),
  ] } : { text: "Restricted commands checked" });
  try {
    const id = h.task("docs");
    await h.app.workerLoop.tick(id);
    assert.equal(existsSync(join(h.app.paths.workspace(id), "forbidden.txt")), false);
    assert.equal(readFileSync(join(h.app.paths.workspace(id), "allowed.txt"), "utf8"), "allowed");
    assert.equal(results(h, id).filter((event) => (event.payload as any).isError).length, 3);
    assert.match(JSON.stringify(h.requests[1].messages), /technical-writing/);
  } finally { await h.close(); }
});

it("denies writes for read-only Workers and guards native file paths including symlink parents", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ++round === 1 ? { calls: [
    cli("_write forbidden.txt --content forbidden"),
    cli("_read ../outside.txt"),
    { name: "exec", args: { cmd: "printf forbidden > forbidden.txt" } },
  ] } : { text: "Denied calls handled" });
  try {
    const id = h.task("research");
    writeFileSync(join(h.app.paths.workspace(id), "..", "outside.txt"), "PRIVATE_OUTSIDE_WORKSPACE");
    await h.app.workerLoop.tick(id);
    assert.equal(existsSync(join(h.app.paths.workspace(id), "forbidden.txt")), false);
    assert.equal(results(h, id).filter((event) => (event.payload as any).isError).length, 3);
    const returned = JSON.stringify(h.requests[1].messages);
    assert.match(returned, /Path escapes workspace/);
    assert.ok(!returned.includes("PRIVATE_OUTSIDE_WORKSPACE"));
  } finally { await h.close(); }

  round = 0;
  const writable = await pizzaHarness(() => ++round === 1 ? {
    calls: [
      cli("_write escape/new.txt --content forbidden"),
      cli("_write dangling --content forbidden"),
      cli(`_read "screenshot 12 PM.txt"`),
    ],
  } : { text: "Symlink checked" });
  try {
    const id = writable.task("docs");
    const outside = join(writable.dir, "outside");
    mkdirSync(outside);
    const workspace = writable.app.paths.workspace(id);
    symlinkSync(outside, join(workspace, "escape"));
    symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling"));
    writeFileSync(join(outside, "private.txt"), "PRIVATE_OUTSIDE_WORKSPACE");
    symlinkSync(join(outside, "private.txt"), join(workspace, "screenshot 12\u202fPM.txt"));
    await writable.app.workerLoop.tick(id);
    assert.equal(existsSync(join(outside, "new.txt")), false);
    assert.equal(existsSync(join(outside, "missing.txt")), false);
    assert.ok(results(writable, id).every((event) => (event.payload as any).isError));
    assert.ok(!JSON.stringify(writable.requests[1].messages).includes("PRIVATE_OUTSIDE_WORKSPACE"));
  } finally { await writable.close(); }
});

it("loads only immutable Task skill snapshots through Pizza's native skill command", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ++round === 1 ? { calls: [
    cli("_skill list"),
    cli("_skill load --name test-driven-fix"),
    cli("_skill load --name technical-writing"),
  ] } : { text: "Snapshots checked" });
  try {
    const id = h.task();
    h.app.store.catalog.replaceSkillFiles("test-driven-fix", [{
      path: "SKILL.md", content: Buffer.from("MUTATED_CATALOG"), mode: 0o644,
    }]);
    await h.app.workerLoop.tick(id);
    const returned = JSON.stringify(h.requests[1].messages.filter((message: any) => message.role === "tool"));
    assert.match(returned, /test-driven-fix/);
    assert.ok(!returned.includes("MUTATED_CATALOG"));
    assert.match(returned, /not found/i);
  } finally { await h.close(); }
});

it("cancels native shell execution when its Worker Run is aborted", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ++round === 1 ? { calls: [
    cli("echo $$ > shell.pid; sleep 30; printf late > should-not-exist.txt"),
  ] } : { text: "Continued" });
  try {
    const { eventually } = await import("./helpers/harness.js");
    const id = h.task();
    const running = h.app.workerLoop.tick(id);
    const pidFile = join(h.app.paths.workspace(id), "shell.pid");
    await eventually(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await h.app.sessions.get(id)!.abort("stop native shell");
    await running;
    await eventually(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    assert.equal(existsSync(join(h.app.paths.workspace(id), "should-not-exist.txt")), false);
    h.app.submitConsole({ taskId: id, text: "Continue after cancellation" });
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
  } finally { await h.close(); }
});

it("applies a Worker's model route through to the SDK request", async () => {
  const h = await pizzaHarness(() => ({ text: "Model selected" }));
  try {
    h.app.settings.saveRouting({
      router: { providerId: "probe", model: "router" },
      worker: { providerId: "probe", model: "worker-a" },
      profiles: { "worker-fast": { providerId: "probe", model: "worker-b" } },
    });
    const id = h.task("docs");
    await h.app.workerLoop.tick(id);
    assert.equal(h.app.store.tasks.get(id)!.definition.model, "worker-fast");
    assert.equal(h.requests[0].model, "worker-b");
  } finally { await h.close(); }
});

it("uses the command allowlist while CLI remains the only model tool", async () => {
  let round = 0;
  const h = await pizzaHarness(() => ++round === 1 ? {
    calls: [
      cli("_read native.txt --offset 2 --limit 1 --anchors none"),
      cli("'_write' forbidden.txt --content forbidden"),
      cli("printf SHELL_ALLOWED"),
    ],
  } : {
    calls: [submitResultCall({
      outcome: "completed", notice: "Read verified", summary: "Native read and independent task controls",
    })],
  });
  try {
    const base = h.app.store.catalog.getDefinition("coding")!;
    h.app.store.catalog.upsertDefinition({ ...base, id: "native-read", tools: ["_read"] });
    const id = h.task("native-read");
    writeFileSync(join(h.app.paths.workspace(id), "native.txt"), "first\nsecond\nthird\n");
    await h.app.workerLoop.tick(id);
    assert.deepEqual(h.app.store.tasks.get(id)!.definition.tools, ["_read"]);
    const [tool] = h.requests[0].tools;
    assert.equal(h.requests[0].tools.length, 1);
    assert.equal(tool.function.name, "cli");
    assert.match(tool.function.description, /_read, _submit_result/);
    assert.doesNotMatch(tool.function.description, /_write|_edit|_skill/);
    const toolResults = results(h, id).map((event) => event.payload as any);
    const output = toolResults.find((payload) => payload.details?.command?.name === "_read");
    assert.ok(!output.isError);
    assert.match(JSON.stringify(output.result), /second/);
    assert.ok(!JSON.stringify(output.result).includes("first"));
    const errors = toolResults.filter((payload) => payload.isError);
    assert.equal(errors.length, 1);
    assert.match(JSON.stringify(errors[0].result), /Unknown underscore command: _write/);
    assert.ok(toolResults.some((payload) => !payload.isError && payload.result?.[0]?.text === "SHELL_ALLOWED"));
    assert.equal(existsSync(join(h.app.paths.workspace(id), "forbidden.txt")), false);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
  } finally { await h.close(); }
});

it("always registers _submit_result even when no ordinary command is permitted", async () => {
  const h = await pizzaHarness(() => ({ calls: [submitResultCall({
    outcome: "completed", notice: "Done", summary: "Task control is independent of native tool selection",
  })] }));
  try {
    const base = h.app.store.catalog.getDefinition("coding")!;
    h.app.store.catalog.upsertDefinition({ ...base, id: "no-native-tools", tools: [], cli: { allowShell: false } });
    const id = h.task("no-native-tools");
    await h.app.workerLoop.tick(id);
    assert.deepEqual(h.requests[0].tools.map((tool: any) => tool.function.name), ["cli"]);
    assert.equal(h.app.store.tasks.get(id)!.status, "completed");
  } finally { await h.close(); }
});

it("refuses an obsolete Task snapshot before any model request without changing its tools", async () => {
  const h = await pizzaHarness(() => ({ text: "Must not execute" }));
  try {
    const id = h.task();
    const definition = { ...h.app.store.tasks.get(id)!.definition, tools: ["exec", "start", "stop"] };
    h.app.store.db.prepare("UPDATE tasks SET definition=? WHERE id=?").run(JSON.stringify(definition), id);
    await assert.rejects(h.app.workerLoop.tick(id), /obsolete or unsupported.*start.*stop/);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.app.store.tasks.get(id)!.definition, definition);
    assert.equal(h.app.store.runs.listIncomplete().length, 0);
  } finally { await h.close(); }
});
