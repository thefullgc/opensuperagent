/** Verify a packed release through an isolated npm global installation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

const project = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const tarball = resolve(
  process.argv[2] ?? `artifacts/opensuperagent-${project.version}.tgz`,
);
const root = mkdtempSync(join(tmpdir(), "osa-npm-package-"));
const prefix = join(root, "prefix");
const pizzaPackage = "@tomsun28/pizza";
const env = { ...process.env, OPENSUPERAGENT_DATA_ROOT: join(root, "data") };
delete env.DEEPSEEK_API_KEY;
delete env.OPENSUPERAGENT_CONFIG;
let child, app, remote;
function command(args) {
  const result = spawnSync("npm", args, { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}
try {
  command([
    "install",
    "-g",
    "--prefix",
    prefix,
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    tarball,
  ]);
  const installed = join(prefix, "lib/node_modules/opensuperagent");
  const bin = join(prefix, "bin/opensuperagent");
  const sdkDir = join(installed, "node_modules", pizzaPackage);
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.license, "Apache-2.0");
  assert.match(
    readFileSync(join(installed, "LICENSE"), "utf8"),
    /Version 2.0, January 2004/,
  );
  assert.match(readFileSync(join(installed, "README.md"), "utf8"), /开源落地实现/);
  assert.ok(existsSync(join(installed, "README.en.md")));
  assert.ok(existsSync(join(installed, "resource/flow.png")));
  const sdkVersion = project.dependencies[pizzaPackage];
  assert.match(sdkVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.dependencies[pizzaPackage], sdkVersion);
  assert.ok(!manifest.optionalDependencies?.[pizzaPackage]);
  assert.equal(JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version, sdkVersion);
  for (const file of [
    "session/llm-agent.js",
    "session/mvp-agent.js",
    "llm/loop.js",
  ])
    assert.ok(
      !existsSync(join(installed, "dist", file)),
      `stale production module: ${file}`,
    );
  const { ensurePizzaRuntime } = await import(
    pathToFileURL(join(installed, "dist/session/pizza-agent.js")).href
  );
  await ensurePizzaRuntime();
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      instance: { data_root: join(root, "data") },
      console: { listen: "127.0.0.1:0" },
    }),
  );
  const init = spawnSync(bin, ["init", "--config", configPath], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Init complete/);
  let output = "";
  child = spawn(bin, ["serve", "--config", configPath], { cwd: root, env });
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  let url;
  for (let i = 0; i < 200; i++) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    assert.equal(child.exitCode, null, output);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(url, output);
  const state = await (await fetch(url + "/api/system")).json();
  assert.equal(state.engine, "pizza");
  assert.equal(state.agent, "unconfigured");
  assert.equal((await fetch(url)).status, 200);
  await stopChild();

  // Execute a real SDK session from the installed artifact with a local model endpoint.
  let calls = 0;
  remote = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume request */
    }
    const tool =
      ++calls === 1
        ? {
            name: "cli",
            arguments: JSON.stringify({
              command: "_write npm-smoke.txt --content PIZZA_NPM_OK",
            }),
          }
        : {
            name: "cli",
            arguments: JSON.stringify({
              command: '_submit_result --outcome completed --notice NPM_OK --summary "Installed Pizza executed native CLI commands"',
            }),
          };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "npm", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: tool }] }, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ id: "npm", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((r) => remote.listen(0, "127.0.0.1", r));
  const { App } = await import(pathToFileURL(join(installed, "dist/app.js")));
  const { loadConfig } = await import(
    pathToFileURL(join(installed, "dist/config.js"))
  );
  app = new App(loadConfig(configPath), { legacyLlm: null });
  app.settings.saveProvider({
    id: "local",
    name: "Local",
    baseUrl: `http://127.0.0.1:${remote.address().port}`,
    apiKey: "smoke-only",
    models: ["smoke"],
  });
  app.settings.saveRouting({
    router: { providerId: "local", model: "smoke" },
    worker: { providerId: "local", model: "smoke" },
    profiles: {},
  });
  const trigger = app.submitConsole({
    text: "Package runtime verification",
  }).trigger;
  const { taskId } = app.routerTools.startTask({
    sessionId: "router",
    runId: "smoke",
    toolCallId: "start",
    triggerIds: [trigger.id],
    definition: "coding",
    objective: "Verify npm SDK execution",
  });
  await app.workerLoop.tick(taskId);
  assert.equal(app.store.tasks.get(taskId)?.status, "completed");
  assert.equal(
    readFileSync(join(app.paths.workspace(taskId), "npm-smoke.txt"), "utf8"),
    "PIZZA_NPM_OK",
  );
  assert.equal(calls, 2);
  await app.stop();
  app = undefined;

  // Removing the required SDK must fail before the HTTP server opens.
  renameSync(sdkDir, sdkDir + "-missing");
  const missing = spawnSync(bin, ["serve", "--config", configPath], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /@tomsun28\/pizza/);
  assert.doesNotMatch(missing.stdout, /\[api\]/);
  const report = {
    at: new Date().toISOString(),
    version: manifest.version,
    tarballSha256: createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex"),
    license: manifest.license,
    chineseReadmeIncluded: true,
    omitOptional: true,
    sdkInstalled: true,
    cliInit: true,
    serverEngine: state.engine,
    webStatus: 200,
    sdkWriteAndSubmit: true,
    staleEnginesAbsent: true,
    missingSdkFails: true,
    passed: true,
  };
  mkdirSync("artifacts/verification", { recursive: true });
  writeFileSync(
    "artifacts/verification/npm-package-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stopChild();
  await app?.stop();
  if (remote)
    await new Promise((r) => {
      remote.close(r);
      remote.closeAllConnections();
    });
  rmSync(root, { recursive: true, force: true });
}
