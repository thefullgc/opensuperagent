import type { App } from "../app.js";
import { rows } from "../storage/db.js";

/** Read models for the console. All relationships come from durable records. */
export class ConsoleView {
  constructor(private readonly app: App) {}

  overview() {
    const { store, config } = this.app;
    const runCounts = new Map(
      rows<{ owner: string; count: number }>(
        store.db
          .prepare(
            `SELECT s.owner, COUNT(r.id) AS count FROM sessions s
       JOIN runs r ON r.session_id = s.id GROUP BY s.owner`,
          )
          .all(),
      ).map((r) => [r.owner, r.count]),
    );
    const tasks = store.tasks.list().map((task) => ({
      ...task,
      source: store.triggers.get(task.originTriggerId)?.source ?? "console",
      runCount: runCounts.get(task.id) ?? 0,
    }));
    const sourceCounts = rows<{
      source: string;
      count: number;
      lastAt: string;
    }>(
      store.db
        .prepare(
          `SELECT source, COUNT(*) AS count, MAX(created_at) AS lastAt
        FROM triggers GROUP BY source`,
        )
        .all(),
    );
    const feishu = this.app.feishuConnection.snapshot();
    const sources = [
      ...new Set([
        "console",
        "feishu",
        "github",
        "webhook",
        ...config.sources.map((s) => s.source),
        ...sourceCounts.map((s) => s.source),
      ]),
    ]
      .filter((s) => s !== "system")
      .map((id) => ({
        id,
        configured:
          id === "console" ||
          (id === "github" || id === "feishu" || id === "webhook"
            ? this.app.settings.adapters[id].enabled
            : config.sources.some((s) => s.source === id)),
        // A source allowlist does not mean a transport adapter is connected.
        transport:
          id === "feishu" && feishu.enabled && feishu.mode === "websocket"
            ? feishu.state === "connected"
              ? "available"
              : feishu.state
            : id === "console" ||
                ((id === "github" || id === "feishu" || id === "webhook") &&
                  this.app.settings.adapters[id].enabled)
              ? "available"
              : "disabled",
        implemented: ["console", "github", "feishu", "webhook"].includes(id),
        ...(id === "feishu"
          ? { receiveMode: feishu.mode, connectionState: feishu.state }
          : {}),
        count: sourceCounts.find((s) => s.source === id)?.count ?? 0,
        lastAt: sourceCounts.find((s) => s.source === id)?.lastAt ?? null,
      }));
    const routerRuns = this.runs("router");
    return {
      tasks,
      definitions: store.catalog.listActiveDefinitions(),
      skills: store.catalog.listSkills(),
      sources,
      router: {
        model: this.app.settings.routing.router
          ? `${this.app.settings.routing.router.providerId} / ${this.app.settings.routing.router.model}`
          : config.models.router,
        instructions: config.router.instructions,
        runs: routerRuns,
        queued: store.inbox.listPending("router").length,
        active: routerRuns.some(
          (r) => r.status === "pending" || r.status === "submitted",
        ),
        journal: this.app.events.list("router", 100),
      },
      events: this.app.events.list(undefined, 100),
      stats: {
        total: tasks.length,
        active: tasks.filter((t) => t.status === "active").length,
        open: tasks.filter((t) => !store.tasks.isTerminal(t.status)).length,
        completed: tasks.filter((t) => t.status === "completed").length,
        capacity: config.instance.max_active_tasks,
        runs: Number(
          store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n ?? 0,
        ),
        messages: sourceCounts
          .filter((s) => s.source !== "system")
          .reduce((n, s) => n + s.count, 0),
      },
      agent: this.app.agentMode,
      generatedAt: new Date().toISOString(),
    };
  }

  runs(owner: string) {
    const session = this.app.store.sessions.getByOwner(owner);
    if (!session) return [];
    const records = rows<{
      id: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>(
      this.app.store.db
        .prepare(
          `SELECT id, status, created_at AS createdAt,
        updated_at AS updatedAt FROM runs WHERE session_id = ? ORDER BY created_at, rowid`,
        )
        .all(session.id),
    );
    return records.map((run) => ({
      ...run,
      inputs: this.inputs(run.id),
      actions: this.app.store.toolActions.listByRun(run.id),
    }));
  }

  private inputs(runId: string) {
    return rows<{
      id: string;
      source: string;
      preview: string;
      steer: number;
      threadId: string | null;
      createdAt: string;
    }>(
      this.app.store.db
        .prepare(
          `SELECT t.id, t.source, t.preview, i.steer, t.thread_id AS threadId, t.created_at AS createdAt FROM inbox i
        JOIN triggers t ON t.id = i.trigger_id WHERE i.run_id = ? ORDER BY i.created_at`,
        )
        .all(runId),
    );
  }

  routerRun(id: string) {
    const run = this.app.store.runs.get(id);
    const session = this.app.store.sessions.getByOwner("router");
    if (!run || run.sessionId !== session?.id) return null;
    const journal = rows<{
      id: string;
      scope: string;
      kind: string;
      summary: string;
      payload: string;
      created_at: string;
    }>(
      this.app.store.db
        .prepare(
          "SELECT * FROM journal WHERE scope = 'router' AND json_extract(payload, '$.runId') = ? ORDER BY created_at, rowid",
        )
        .all(id),
    ).map((event) => ({
      id: event.id,
      scope: event.scope,
      kind: event.kind,
      summary: event.summary,
      payload: JSON.parse(event.payload) as unknown,
      createdAt: event.created_at,
    }));
    const argumentsByCall = new Map<string, Record<string, unknown>>();
    for (const event of journal) {
      if (
        event.kind !== "tool" ||
        !event.payload ||
        typeof event.payload !== "object"
      )
        continue;
      const payload = event.payload as Record<string, unknown>;
      if (
        typeof payload.toolCallId === "string" &&
        payload.args &&
        typeof payload.args === "object" &&
        !Array.isArray(payload.args)
      )
        argumentsByCall.set(
          payload.toolCallId,
          payload.args as Record<string, unknown>,
        );
    }
    const actions = this.app.store.toolActions.listByRun(id).map((action) => {
      const result =
        action.result && typeof action.result === "object"
          ? (action.result as Record<string, unknown>)
          : {};
      return {
        ...action,
        args: argumentsByCall.get(action.toolCallId) ?? null,
        replyText:
          action.tool === "reply" && typeof result.deliveryId === "string"
            ? (this.app.store.deliveries.get(result.deliveryId)?.content ??
              null)
            : null,
      };
    });
    const prompt = journal.find((event) => event.kind === "prompt")?.payload as
      | { resolvedModel?: { provider?: unknown; id?: unknown } }
      | null
      | undefined;
    const resolved = prompt?.resolvedModel;
    const model =
      typeof resolved?.provider === "string" && typeof resolved.id === "string"
        ? { provider: resolved.provider, model: resolved.id }
        : null;
    return { ...run, inputs: this.inputs(id), actions, journal, model };
  }

  taskFlow(id: string) {
    const task = this.app.store.tasks.get(id);
    if (!task) return null;
    const { store } = this.app;
    const origin = store.triggers.get(task.originTriggerId);
    const taskRuns = this.runs(id);
    const deliveryIds = new Set(
      taskRuns
        .flatMap((run) => run.actions)
        .map((a) => (a.result as { deliveryId?: string } | null)?.deliveryId)
        .filter(Boolean),
    );
    const routerRuns = this.runs("router").filter((run) =>
      run.actions.some((action) => {
        const result = action.result as { taskId?: string } | null;
        return result?.taskId === id;
      }),
    );
    return {
      task,
      origin,
      runs: taskRuns,
      routerRuns,
      journal: this.app.events.list(id, 300),
      subscriptions: rows<{ threadId: string }>(
        store.db
          .prepare(
            "SELECT thread_id AS threadId FROM subscriptions WHERE task_id = ?",
          )
          .all(id),
      ),
      operations: rows<{ id: string }>(
        store.db
          .prepare(
            "SELECT id FROM operations WHERE task_id = ? ORDER BY created_at",
          )
          .all(id),
      ).map((r) => store.operations.get(r.id)),
      deliveries: [...deliveryIds].flatMap((deliveryId) => {
        const delivery = store.deliveries.get(deliveryId!);
        return delivery ? [delivery] : [];
      }),
    };
  }

  messages(source?: string, offset = 0) {
    const { store } = this.app;
    const ids = rows<{ id: string }>(
      store.db
        .prepare(
          `SELECT id FROM triggers
      WHERE source != 'system' ${source ? "AND source = ?" : ""}
      ORDER BY created_at DESC, rowid DESC LIMIT 100 OFFSET ?`,
        )
        .all(...(source ? [source, offset] : [offset])),
    );
    const total = Number(
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM triggers
      WHERE source != 'system' ${source ? "AND source = ?" : ""}`,
        )
        .get(...(source ? [source] : []))?.n ?? 0,
    );
    return {
      total,
      messages: ids.map(({ id }) => ({
        ...store.triggers.get(id)!,
        routes: rows<{ target: string; status: string; runId: string | null }>(
          store.db
            .prepare(
              "SELECT target, status, run_id AS runId FROM inbox WHERE trigger_id = ? ORDER BY created_at",
            )
            .all(id),
        ),
      })),
    };
  }
}
