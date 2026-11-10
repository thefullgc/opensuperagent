import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "../app.js";
import { parseListen } from "../config.js";
import { newId } from "../ids.js";
import { HttpError, readBody, parseBody } from "../channels/http.js";
import { SettingsError } from "../settings/store.js";
import { LlmClient } from "../llm/client.js";
import { ZodError } from "zod";
import { ConsoleView } from "./console-view.js";

type SseClient = { res: ServerResponse; id: string };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ApiServer {
  private readonly sseClients = new Set<SseClient>();
  private server: ReturnType<typeof createServer> | null = null;
  private readonly webRoot: string;
  private unsub: (() => void) | null = null;

  constructor(private readonly app: App) {
    this.webRoot = resolveWebRoot();
  }

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string")
      throw new Error("Server is not listening");
    return `http://${formatHttpHost(address.address)}:${address.port}`;
  }

  async start(): Promise<void> {
    const { host, port } = parseListen(this.app.config.console.listen);
    this.unsub = this.app.events.on((event) => {
      this.broadcast("journal", event);
      if (
        event.kind === "tool" ||
        event.kind === "ingress" ||
        event.kind === "stop"
      ) {
        this.broadcast("tasks", { at: event.createdAt });
      }
    });

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        const address = this.server!.address();
        const boundPort = address && typeof address !== "string" ? address.port : port;
        console.log(`[api] listening on http://${formatHttpHost(host)}:${boundPort}`);
        console.log(`[api] web root ${this.webRoot}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    for (const c of this.sseClients) {
      c.res.end();
    }
    this.sseClients.clear();
    const server = this.server;
    this.server = null;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) {
      c.res.write(payload);
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (
        req.method === "POST" &&
        /^\/hooks\/(github|feishu|webhook)$/.test(path)
      ) {
        const name = path.split("/")[2] as "github" | "feishu" | "webhook";
        const raw = await readBody(req);
        const normalized = this.app.adapters[name].receive(raw, req.headers);
        if ("challenge" in normalized || "ignored" in normalized)
          return json(res, 200, normalized);
        const accepted = this.app.submitExternal(normalized);
        // Persisted before ACK. Model calls and outbound HTTP never hold this response open.
        json(res, 200, {
          ok: true,
          triggerId: accepted.trigger.id,
          duplicate: accepted.duplicate,
          route: accepted.decision,
        });
        void this.app.pump();
        return;
      }

      // Static + health before auth so SPA assets load; API still authorized.
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, {
          ok: true,
          tasks: this.app.store.tasks.countActive(),
          web: existsSync(join(this.webRoot, "index.html")),
        });
      }

      if (req.method === "GET" && !path.startsWith("/api/")) {
        return this.serveStatic(path, res);
      }

      if (!this.authorize(req, res)) return;
      if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method ?? "")) {
        const origin = req.headers.origin;
        if (origin && !isSameOrigin(origin, req.headers.host))
          throw new HttpError(403, "Cross-origin writes are not allowed");
        if (
          req.method !== "DELETE" &&
          !String(req.headers["content-type"]).startsWith("application/json")
        )
          throw new HttpError(415, "Use application/json");
      }
      if (req.method === "GET" && path === "/api/settings")
        return json(res, 200, this.app.settings.snapshot());
      if (req.method === "PUT" && path === "/api/settings/providers") {
        const result = this.app.settings.saveProvider(await readJson(req));
        this.app.events.emit({
          scope: "system",
          kind: "settings",
          summary: "LLM provider configuration updated",
        });
        return json(res, 200, result);
      }
      if (
        req.method === "DELETE" &&
        /^\/api\/settings\/providers\/[^/]+$/.test(path)
      )
        return json(
          res,
          200,
          this.app.settings.removeProvider(
            decodeURIComponent(path.split("/")[4]!),
          ),
        );
      if (req.method === "PUT" && path === "/api/settings/routing") {
        const result = this.app.settings.saveRouting(await readJson(req));
        this.app.events.emit({
          scope: "system",
          kind: "settings",
          summary: "Model routing updated; effective next Run",
        });
        return json(res, 200, result);
      }
      if (
        req.method === "PUT" &&
        /^\/api\/settings\/adapters\/(github|feishu|webhook)$/.test(path)
      ) {
        const name = path.split("/")[4]!;
        const result = this.app.settings.saveAdapter(name, await readJson(req));
        if (name === "feishu") this.app.feishuConnection.reconcile();
        this.app.events.emit({
          scope: "system",
          kind: "settings",
          summary: `${name} adapter configuration updated`,
        });
        return json(res, 200, result);
      }
      if (
        req.method === "GET" &&
        path === "/api/settings/adapters/feishu/status"
      )
        return json(res, 200, this.app.feishuConnection.snapshot());
      if (
        req.method === "POST" &&
        path === "/api/settings/adapters/feishu/reconnect"
      ) {
        await readJson(req);
        const config = this.app.settings.adapters.feishu;
        if (!config.enabled || config.receiveMode !== "websocket")
          throw new HttpError(409, "Enable Feishu WebSocket mode first");
        this.app.feishuConnection.reconnect();
        return json(res, 200, this.app.feishuConnection.snapshot());
      }
      if (
        req.method === "POST" &&
        /^\/api\/settings\/adapters\/(github|feishu)\/test$/.test(path)
      ) {
        await readJson(req);
        const name = path.split("/")[4] as "github" | "feishu";
        const started = Date.now();
        return json(res, 200, {
          ...(await this.app.adapters[name].testCredentials()),
          latencyMs: Date.now() - started,
        });
      }
      if (
        req.method === "POST" &&
        /^\/api\/settings\/providers\/[^/]+\/(models|test)$/.test(path)
      ) {
        const provider = this.app.settings.provider(
          decodeURIComponent(path.split("/")[4]!),
        );
        const body = await readJson(req);
        const model = String(body.model ?? provider.models[0] ?? "");
        const client = new LlmClient({
          provider: provider.id,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
        });
        if (path.endsWith("/models"))
          return json(res, 200, { models: await client.models() });
        if (!model) throw new HttpError(400, "Select a model to test");
        const started = Date.now();
        await client.test(model);
        // Only connectivity and latency are returned. Provider output can echo credentials.
        return json(res, 200, {
          ok: true,
          latencyMs: Date.now() - started,
          model,
        });
      }

      if (
        req.method === "POST" &&
        /^\/api\/deliveries\/[^/]+\/resolve$/.test(path)
      ) {
        const id = path.split("/")[3]!;
        const body = await readJson(req);
        if (body.status !== "sent" && body.status !== "failed")
          throw new HttpError(400, "Confirm sent or failed");
        const changed = this.app.store.deliveries.markStatus(
          id,
          "unknown",
          body.status,
        );
        if (!changed)
          return json(res, 409, {
            error: "Only an unknown delivery can be confirmed",
          });
        this.app.events.emit({
          scope: "system",
          kind: "delivery_resolved",
          summary: `Delivery ${id} confirmed ${body.status}`,
          payload: { deliveryId: id, status: body.status },
        });
        void this.app.delivery.flushPending();
        return json(res, 200, { ok: true });
      }

      const view = new ConsoleView(this.app);
      if (req.method === "GET" && path === "/api/overview") {
        return json(res, 200, view.overview());
      }
      if (req.method === "GET" && /^\/api\/router\/runs\/run_[a-zA-Z0-9]+$/.test(path)) {
        const trace = view.routerRun(path.split("/")[4]!);
        return json(res, trace ? 200 : 404, trace ?? { error: "not found" });
      }
      if (req.method === "GET" && path === "/api/messages") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          return json(res, 400, {
            error: "offset must be a non-negative integer",
          });
        }
        return json(
          res,
          200,
          view.messages(url.searchParams.get("source") || undefined, offset),
        );
      }
      if (req.method === "GET" && path.match(/^\/api\/tasks\/[^/]+\/flow$/)) {
        const flow = view.taskFlow(path.split("/")[3]!);
        return json(res, flow ? 200 : 404, flow ?? { error: "not found" });
      }
      if (req.method === "GET" && path.match(/^\/api\/skills\/[^/]+$/)) {
        const name = decodeURIComponent(path.split("/")[3]!);
        const skill = this.app.store.catalog
          .listSkills()
          .find((s) => s.name === name);
        if (!skill) return json(res, 404, { error: "not found" });
        return json(res, 200, {
          ...skill,
          files: this.app.store.catalog.getSkillFiles(name).map((f) => ({
            path: f.path,
            content: f.content.subarray(0, 262144).toString("utf8"),
            truncated: f.content.length > 262144,
          })),
        });
      }

      if (req.method === "GET" && path === "/api/tasks") {
        const status = url.searchParams.get("status") ?? undefined;
        const tasks = status
          ? this.app.store.tasks.list({ status: status as never })
          : this.app.store.tasks.list();
        return json(res, 200, { tasks });
      }

      if (req.method === "GET" && path.match(/^\/api\/tasks\/[^/]+$/)) {
        const id = path.split("/")[3]!;
        const task = this.app.store.tasks.get(id);
        if (!task) return json(res, 404, { error: "not found" });
        const inbox = this.app.store.inbox.listPending(id);
        const op = this.app.store.operations.findActiveForTask(id);
        const journal = this.app.events.list(id, 200);
        const origin = this.app.store.triggers.get(task.originTriggerId);
        return json(res, 200, { task, inbox, operation: op, journal, origin });
      }

      if (req.method === "POST" && path === "/api/tasks") {
        const body = await readJson(req);
        const text = String(body.text ?? body.objective ?? "");
        if (!text) return json(res, 400, { error: "text required" });
        const result = this.app.submitConsole({ text });
        void this.app.pump();
        return json(res, 201, result);
      }

      if (
        req.method === "POST" &&
        path.match(/^\/api\/tasks\/[^/]+\/messages$/)
      ) {
        const taskId = path.split("/")[3]!;
        const body = await readJson(req);
        const text = String(body.text ?? "");
        if (!text) return json(res, 400, { error: "text required" });
        const result = this.app.submitConsole({
          text,
          taskId,
          steer: !!body.steer,
        });
        void this.app.pump();
        return json(res, 201, result);
      }

      if (req.method === "POST" && path.match(/^\/api\/tasks\/[^/]+\/stop$/)) {
        const taskId = path.split("/")[3]!;
        const result = this.app.submitConsole({
          text: `/stop ${taskId}`,
          stopTaskId: taskId,
        });
        void this.app.pump();
        return json(res, 200, result);
      }

      if (req.method === "GET" && path === "/api/router") {
        const items = this.app.store.inbox.listPending("router");
        const journal = this.app.events.list("router", 100);
        return json(res, 200, { items, journal });
      }

      if (req.method === "POST" && path === "/api/router/messages") {
        const body = await readJson(req);
        const text = String(body.text ?? "");
        if (!text) return json(res, 400, { error: "text required" });
        const result = this.app.submitConsole({
          text,
          threadId: "console:router",
        });
        void this.app.pump();
        return json(res, 201, result);
      }

      if (req.method === "GET" && path === "/api/definitions") {
        return json(res, 200, {
          definitions: this.app.store.catalog.listActiveDefinitions(),
        });
      }

      if (req.method === "GET" && path === "/api/skills") {
        return json(res, 200, { skills: this.app.store.catalog.listSkills() });
      }

      if (req.method === "GET" && path === "/api/deliveries") {
        const channel = url.searchParams.get("channel") ?? "console";
        const target = url.searchParams.get("target");
        if (target) {
          return json(res, 200, {
            deliveries: this.app.store.deliveries.listByTarget(channel, target),
          });
        }
        return json(res, 200, {
          deliveries: this.app.store.deliveries.listPending(),
        });
      }

      if (req.method === "GET" && path === "/api/journal") {
        const scope = url.searchParams.get("scope") ?? undefined;
        return json(res, 200, {
          events: this.app.events.list(scope, 200),
        });
      }

      if (req.method === "GET" && path === "/api/pending") {
        return json(res, 200, {
          operations: this.app.store.operations.listUnknown(),
          deliveries: this.app.store.db
            .prepare("SELECT * FROM deliveries WHERE status = 'unknown'")
            .all(),
        });
      }

      if (
        req.method === "POST" &&
        path.match(/^\/api\/operations\/[^/]+\/confirm$/)
      ) {
        const id = path.split("/")[3]!;
        const body = await readJson(req);
        const status = body.status === "succeeded" ? "succeeded" : "failed";
        const ok = this.app.store.operations.finish(
          id,
          ["unknown"],
          status,
          body.exitCode == null ? null : Number(body.exitCode),
        );
        return json(res, ok ? 200 : 409, { ok });
      }

      if (req.method === "GET" && path === "/api/system") {
        return json(res, 200, {
          dataRoot: this.app.paths.root,
          listen: this.app.config.console.listen,
          maxActiveTasks: this.app.config.instance.max_active_tasks,
          activeTasks: this.app.store.tasks.countActive(),
          openTasks: this.app.store.tasks.listOpen().length,
          unknownOps: this.app.store.operations.listUnknown().length,
          pendingDeliveries: this.app.store.deliveries.listPending().length,
          definitions: this.app.store.catalog.listActiveDefinitions().length,
          skills: this.app.store.catalog.listSkills().length,
          agent: this.app.agentMode,
          engine: this.app.engineMode,
        });
      }

      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const client = { res, id: newId("sse") };
        this.sseClients.add(client);
        res.write(
          `event: ready\ndata: ${JSON.stringify({ id: client.id })}\n\n`,
        );
        req.on("close", () => this.sseClients.delete(client));
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      const status =
        err instanceof HttpError || err instanceof SettingsError
          ? err.status
          : err instanceof ZodError || err instanceof SyntaxError
            ? 400
            : 500;
      const message =
        err instanceof ZodError
          ? err.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : this.app.settings.redact(String(err));
      if (status >= 500) console.error("[api]", message);
      if (!res.headersSent) json(res, status, { error: message });
    }
  }

  private serveStatic(urlPath: string, res: ServerResponse): void {
    const safe = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = resolve(this.webRoot, "." + safe);
    if (!filePath.startsWith(this.webRoot)) {
      json(res, 403, { error: "forbidden" });
      return;
    }

    let target = filePath;
    if (!existsSync(target) || statSync(target).isDirectory()) {
      // SPA fallback
      target = join(this.webRoot, "index.html");
    }
    if (!existsSync(target)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        "Web console not built. Run: npm run build:web\nAPI is available under /api/*",
      );
      return;
    }

    const ext = extname(target);
    const body = readFileSync(target);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(body);
  }

  private authorize(req: IncomingMessage, res: ServerResponse): boolean {
    const host = req.socket.localAddress ?? "";
    const isLoopback =
      host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
    const token = this.app.config.console.admin_token;
    if (isLoopback && !token) return true;
    if (!token) {
      json(res, 403, { error: "admin token required for non-loopback" });
      return false;
    }
    const header = req.headers.authorization ?? "";
    const got = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (got !== token) {
      json(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }
}

function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (origin === "null") return false;
  try {
    return new URL(origin).host.toLowerCase() === host?.toLowerCase();
  } catch {
    return false;
  }
}

function formatHttpHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function resolveWebRoot(): string {
  const candidates = [
    resolve(__dirname, "../../web/dist"),
    resolve(__dirname, "../web/dist"),
    resolve(process.cwd(), "web/dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  return raw.length ? parseBody(raw) : {};
}
