import { mkdirSync } from "node:fs";
import type { AppConfig } from "./config.js";
import { DataPaths, DATA_SUBDIRS } from "./paths.js";
import { InstanceLock } from "./instance-lock.js";
import { Store } from "./storage/index.js";
import { Ingress } from "./ingress/index.js";
import { DeliveryService } from "./delivery/index.js";
import { ConsoleChannelIngress } from "./channels/index.js";
import { WorkspaceManager, CommandRunner } from "./execution/index.js";
import { SessionManager, type FacadeFactory } from "./session/index.js";
import {
  createPizzaFacadeFactory,
  ensurePizzaRuntime,
} from "./session/pizza-agent.js";
import { buildRouterSystemPrompt } from "./router/prompts.js";
import { RouterTools, RouterLoop } from "./router/index.js";
import { WorkerControls, WorkerLoop } from "./worker/index.js";
import { Supervisor } from "./supervisor/index.js";
import { EventBus } from "./events/bus.js";
import { loadLlmConfig } from "./llm/index.js";
import { SettingsStore } from "./settings/store.js";
import { Adapters } from "./channels/adapters/index.js";
import { FeishuConnection } from "./channels/feishu-connection.js";
import type { IngressInput } from "./types.js";
import type { LlmConfig } from "./llm/types.js";
import type { IngressResult } from "./ingress/index.js";

function routeTargetIds(decision: IngressResult["decision"]): string[] {
  if (decision?.kind === "task") return [decision.taskId];
  if (decision?.kind === "tasks") return decision.taskIds;
  return [];
}

export class App {
  readonly paths: DataPaths;
  readonly store: Store;
  readonly lock: InstanceLock;
  readonly events: EventBus;
  readonly ingress: Ingress;
  readonly delivery: DeliveryService;
  readonly console: ConsoleChannelIngress;
  readonly workspaces: WorkspaceManager;
  readonly runner: CommandRunner;
  readonly sessions: SessionManager;
  readonly routerTools: RouterTools;
  readonly routerLoop: RouterLoop;
  readonly workerControls: WorkerControls;
  readonly workerLoop: WorkerLoop;
  readonly supervisor: Supervisor;
  readonly settings: SettingsStore;
  readonly adapters: Adapters;
  readonly feishuConnection: FeishuConnection;
  private readonly hasTestFacade: boolean;
  get engineMode(): "pizza" {
    return "pizza";
  }
  get agentMode(): "llm" | "unconfigured" {
    return this.hasTestFacade || this.settings.ready ? "llm" : "unconfigured";
  }

  private pumpTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private pendingPumps = new Set<Promise<void>>();

  constructor(
    readonly config: AppConfig,
    opts?: { testFacadeFactory?: FacadeFactory; legacyLlm?: LlmConfig | null },
  ) {
    this.paths = new DataPaths(config.instance.data_root);
    this.lock = new InstanceLock(this.paths.instanceLock);
    this.store = Store.open(this.paths.stateDb);
    this.events = new EventBus(this.store.db);
    this.hasTestFacade = !!opts?.testFacadeFactory;
    this.settings = new SettingsStore(
      this.paths.root,
      opts?.legacyLlm === undefined
        ? loadLlmConfig(process.cwd(), this.paths.root)
        : opts.legacyLlm,
    );
    this.adapters = new Adapters(this.settings, this.store);
    this.ingress = new Ingress(this.store, this.paths, config, (source) => {
      if (source === "github" || source === "feishu" || source === "webhook")
        return this.settings.adapters[source].enabled;
      return config.sources.some((s) => s.source === source);
    });
    this.delivery = new DeliveryService(this.store, (delivery, error) =>
      this.events.emit({
        scope: "system",
        kind: "delivery",
        summary: `Delivery ${delivery.id} ${delivery.status}${error ? `: ${this.settings.redact(error)}` : ""}`,
        payload: {
          deliveryId: delivery.id,
          channel: delivery.channel,
          status: delivery.status,
        },
      }),
    );
    this.delivery.register(this.adapters.github);
    this.delivery.register(this.adapters.feishu);
    this.delivery.register(this.adapters.webhook);
    this.console = new ConsoleChannelIngress(this.ingress);
    this.workspaces = new WorkspaceManager(this.paths);
    this.runner = new CommandRunner(this.store, this.paths, config);

    this.routerTools = new RouterTools(
      this.store,
      this.paths,
      this.delivery,
      this.workspaces,
      (taskId, operationId) => {
        if (operationId) this.runner.stop(operationId);
        void this.sessions.get(taskId)?.abort("stop");
        this.events.emit({
          scope: taskId,
          kind: "stop",
          summary: `Task ${taskId} stopped`,
        });
      },
    );
    this.workerControls = new WorkerControls(
      this.store,
      this.delivery,
    );

    const deps = {
      store: this.store,
      routerTools: this.routerTools,
      workerControls: this.workerControls,
      events: this.events,
    };
    const pizzaFactory = createPizzaFacadeFactory({
      ...deps,
      paths: this.paths,
      resolveModel: (owner, profile) => this.settings.resolve(owner, profile),
      routerSystemPrompt: () =>
        buildRouterSystemPrompt(
          config,
          this.store.catalog.listActiveDefinitions(),
        ),
      redact: (message) => this.settings.redact(message),
    });
    this.sessions = new SessionManager(
      this.store,
      this.paths,
      opts?.testFacadeFactory ?? pizzaFactory,
    );
    this.routerLoop = new RouterLoop(
      this.store,
      this.sessions,
      config,
      this.paths,
    );
    this.workerLoop = new WorkerLoop(
      this.store,
      this.sessions,
      config.instance.max_active_tasks,
      this.paths,
    );
    this.supervisor = new Supervisor(
      this.store,
      config,
      this.sessions,
    );
    this.feishuConnection = new FeishuConnection(
      this.settings,
      this.adapters.feishu,
      (input) => {
        this.submitExternal(input);
        queueMicrotask(() => {
          void this.pump();
        });
      },
      this.events,
    );
  }

  async start(): Promise<void> {
    if (!this.hasTestFacade) await ensurePizzaRuntime();
    ensureDataDirs(this.paths.root);
    this.lock.acquire();

    const ops = this.runner.recoverIncomplete();
    if (ops > 0) console.log(`[recover] finalized ${ops} operations`);

    const runs = await this.sessions.recoverIncomplete();
    if (runs > 0) console.log(`[recover] handled ${runs} incomplete runs`);

    for (const t of this.store.triggers.listPending()) {
      this.store.triggers.setStatus(t.id, "pending", "routed");
      this.store.inbox.insertOrGet({ target: "router", triggerId: t.id });
    }

    if (!this.hasTestFacade && this.settings.ready) {
      await this.sessions.open("router", {
        systemPrompt: buildRouterSystemPrompt(
          this.config,
          this.store.catalog.listActiveDefinitions(),
        ),
        model: this.config.models.router,
      });
    }

    this.delivery.recoverInterrupted();
    await this.delivery.flushPending();

    this.supervisor.start();
    this.feishuConnection.reconcile();
    this.pumpTimer = setInterval(() => {
      void this.pump();
    }, 400);
    this.pumpTimer.unref();

    this.events.emit({
      scope: "system",
      kind: "started",
      summary: `OpenSuperAgent started (data_root=${this.paths.root}, agent=${this.agentMode})`,
    });
    console.log(`[app] data_root=${this.paths.root}`);
    console.log(`[app] agent=${this.agentMode}`);
  }

  async stop(): Promise<void> {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.stopping = true;
    this.feishuConnection.stop();
    this.supervisor.stop();
    await this.sessions.closeAll();
    await Promise.allSettled([...this.pendingPumps]);
    this.lock.release();
    this.store.close();
  }

  submitConsole(input: {
    text: string;
    actorId?: string;
    taskId?: string | null;
    threadId?: string | null;
    steer?: boolean;
    stopTaskId?: string;
  }): IngressResult {
    const result = this.console.submit(input);
    if (input.steer) {
      for (const taskId of routeTargetIds(result.decision))
        void this.sessions.get(taskId)?.abort("steer");
    }
    const scopes =
      result.decision?.kind === "tasks"
        ? result.decision.taskIds
        : [input.taskId ?? "router"];
    for (const scope of scopes) {
      this.events.emit({
        scope,
        kind: "ingress",
        summary: input.text.slice(0, 120),
        payload: {
          triggerId: result.trigger.id,
          decision: result.decision,
          duplicate: result.duplicate,
        },
      });
    }
    if (
      result.decision?.kind === "control" &&
      result.decision.action === "stop"
    ) {
      this.handleStop(result.decision.taskId);
    }
    return result;
  }

  submitExternal(input: IngressInput): IngressResult {
    const result = this.store.transaction(() => {
      const accepted = this.ingress.accept(input);
      if (
        input.source === "feishu" &&
        input.threadId &&
        !accepted.duplicate &&
        accepted.trigger.status !== "ignored"
      ) {
        const payload = input.payload as { messageId: string; chatId: string };
        const messageId = input.threadId.endsWith(":p2p")
          ? payload.messageId
          : input.threadId.split(":").at(-1)!;
        this.store.db
          .prepare(
            `INSERT INTO channel_routes (channel, thread_id, target, updated_at) VALUES ('feishu', ?, ?, ?)
          ON CONFLICT(channel, thread_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,
          )
          .run(
            input.threadId,
            JSON.stringify({ messageId, chatId: payload.chatId }),
            new Date().toISOString(),
          );
      }
      return accepted;
    });
    const scopes =
      result.decision?.kind === "tasks"
        ? result.decision.taskIds
        : [result.decision?.kind === "task" ? result.decision.taskId : "router"];
    for (const scope of scopes) {
      this.events.emit({
        scope,
        kind: "ingress",
        summary: `${input.source}: ${input.preview.slice(0, 120)}`,
        payload: {
          triggerId: result.trigger.id,
          source: input.source,
          decision: result.decision,
          duplicate: result.duplicate,
        },
      });
    }
    if (result.decision?.kind === "control")
      this.handleStop(result.decision.taskId);
    return result;
  }

  handleStop(taskId: string): void {
    const session = this.store.sessions.getByOwner("router");
    const run = session ? this.store.runs.findActive(session.id) : null;
    this.routerTools.stopTask({
      sessionId: session?.id ?? "router",
      toolCallId: `ctrl:stop:${taskId}:${Date.now()}`,
      runId: run?.id ?? "control",
      taskId,
    });
  }

  pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const promise = this.pumpOnce();
    this.pendingPumps.add(promise);
    void promise.finally(() => this.pendingPumps.delete(promise));
    return promise;
  }
  private async pumpOnce(): Promise<void> {
    try {
      const completed = this.runner.poll();
      for (const opId of completed) {
        this.workerLoop.notifyOperationComplete(opId);
        this.events.emit({
          scope: this.store.operations.get(opId)?.taskId ?? "system",
          kind: "operation",
          summary: `Operation ${opId} finished`,
          payload: { operationId: opId },
        });
      }

      const canRun = this.hasTestFacade || this.settings.ready;
      const progress = await Promise.allSettled([
        canRun ? this.routerLoop.tick() : Promise.resolve(false),
        canRun ? this.workerLoop.tickAll() : Promise.resolve(0),
        this.delivery.flushPending(),
      ]);
      for (const result of progress)
        if (result.status === "rejected")
          this.events.emit({
            scope: "system",
            kind: "error",
            summary: this.settings.redact(String(result.reason)),
          });
      const routed = progress[0]?.status === "fulfilled" && progress[0].value;
      const worked =
        progress[1]?.status === "fulfilled" ? Number(progress[1].value) : 0;
      const sent =
        (progress[2]?.status === "fulfilled" ? Number(progress[2].value) : 0) +
        (await this.delivery.flushPending());
      if (routed || worked > 0 || sent > 0 || completed.length > 0) {
        this.events.emit({
          scope: "system",
          kind: "pump",
          summary: `router=${routed} workers=${worked} deliveries=${sent} ops=${completed.length}`,
        });
      }
    } catch (err) {
      console.error("[pump]", err);
      this.events.emit({
        scope: "system",
        kind: "error",
        summary: this.settings.redact(String(err)),
      });
    }
  }
}

export function ensureDataDirs(root: string): void {
  mkdirSync(root, { recursive: true });
  for (const sub of DATA_SUBDIRS) {
    mkdirSync(`${root}/${sub}`, { recursive: true });
  }
}
