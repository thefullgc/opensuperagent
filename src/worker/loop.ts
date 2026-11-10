import { triggerText } from "../ingress/text.js";
import type { DataPaths } from "../paths.js";
import type { Store } from "../storage/index.js";
import type { SessionManager } from "../session/manager.js";
import type { InboxItem, Run, Trigger } from "../types.js";
import type { WorkerControls } from "./controls.js";
import type { EventBus } from "../events/bus.js";

const MAX_RESULT_FOLLOWUPS = 2;

/**
 * Worker turn loop: one session per Task, bounded by max_active_tasks.
 * Tool side effects are performed by the session facade (Pizza).
 */
export class WorkerLoop {
  private readonly busy = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly controls: WorkerControls,
    private readonly events: EventBus,
    private readonly maxConcurrent = 2,
    private readonly paths?: DataPaths,
    private readonly redact = (message: string) => message,
  ) {}

  async tickAll(): Promise<number> {
    const outcomes = await Promise.allSettled(
      this.store.tasks.listOpen().map((task) => this.tick(task.id)),
    );
    const failure = outcomes.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return outcomes.filter((r) => r.status === "fulfilled" && r.value).length;
  }

  async tick(taskId: string): Promise<boolean> {
    if (this.busy.has(taskId) || this.busy.size >= this.maxConcurrent)
      return false;
    const task = this.store.tasks.get(taskId);
    if (!task || this.store.tasks.isTerminal(task.status)) return false;
    if (
      this.store.tasks.hasSubscription(taskId) &&
      !this.store.tasks.isExecutor(taskId)
    )
      return false;
    if (!this.sessions.isIdle(taskId)) return false;
    if (this.store.operations.findActiveForTask(taskId)) return false;

    const pending = this.store.inbox.listPending(taskId);
    if (
      pending.length === 0 &&
      !this.store.runs.findActive(this.sessions.ensureSession(taskId).id)
    ) {
      const latest = this.store.runs.latest(
        this.sessions.ensureSession(taskId).id,
      );
      return latest ? this.settleRun(taskId, latest) : false;
    }

    this.busy.add(taskId);
    try {
      if (task.status === "pending" || task.status === "waiting") {
        this.store.tasks.transition(taskId, task.status, "active");
      }

      const handle = await this.sessions.open(taskId, {
        cwd: task.workspacePath,
        systemPrompt: buildWorkerPrompt(
          task.definition.systemPrompt,
          task.definition.skills,
        ),
        model: task.definition.model,
      });

      const batch = this.sessions.beginRun(taskId, (items) => {
        const history = this.store.db
          .prepare(
            `SELECT trigger_id FROM inbox
             WHERE target = ? AND status IN ('done', 'observed')
             ORDER BY created_at DESC, rowid DESC LIMIT 30`,
          )
          .all(taskId)
          .reverse()
          .map((row) => {
            const prior = this.store.triggers.get(String(row.trigger_id));
            return prior
              ? `- earlier input ${prior.id} (${prior.source}): ${(this.paths ? triggerText(this.paths, prior) : prior.preview).slice(0, 4000)}`
              : "";
          })
          .join("\n")
          .slice(-32000);
        const operation = this.store.operations.findActiveForTask(taskId);
        return (
          `## Task objective\n${task.objective}\n\n## Runtime state\nCurrent UTC time: ${new Date().toISOString()}\nWorkspace: ${task.workspacePath}\nActive operation: ${operation ? `${operation.id} (${operation.status}), deadline=${operation.deadlineAt}. Do not poll or write while busy; wait for its completion event.` : "none"}\n\n## Earlier processed inputs (context; preserve outstanding requirements, do not repeat completed side effects)\n${history || "(none)"}\n\n## New inputs\n` +
          formatWorkerBatch(
            orderInbox(items).map((i) => ({
              item: i,
              trigger: (() => {
                const t = this.store.triggers.get(i.triggerId)!;
                return this.paths
                  ? { ...t, preview: triggerText(this.paths, t) }
                  : t;
              })(),
            })),
          )
        );
      });
      if (!batch) return false;

      this.store.runs.transition(batch.run.id, "pending", "submitted");
      try {
        await handle.prompt(batch.promptText);
      } catch (error) {
        this.store.runs.transition(batch.run.id, "submitted", "failed");
        this.failRun(
          taskId,
          batch.run,
          this.redact(error instanceof Error ? error.message : String(error)),
        );
        throw error;
      } finally {
        if (this.store.runs.get(batch.run.id)?.status === "submitted") {
          this.store.runs.transition(batch.run.id, "submitted", "completed");
        }
        this.store.inbox.markDone(batch.items.map((i) => i.id));
      }

      this.settleRun(taskId, this.store.runs.get(batch.run.id)!);
      return true;
    } finally {
      this.busy.delete(taskId);
    }
  }

  private hasResult(runId: string): boolean {
    return this.store.toolActions
      .listByRun(runId)
      .some(
        (action) =>
          action.tool === "submit_result" &&
          (action.result as { ok?: boolean } | null)?.ok === true,
      );
  }

  private failRun(taskId: string, run: Run, reason: string): boolean {
    const task = this.store.tasks.get(taskId);
    if (
      !task ||
      this.store.tasks.isTerminal(task.status) ||
      this.hasResult(run.id) ||
      this.store.inbox.listPending(taskId).length ||
      this.store.operations.findActiveForTask(taskId)
    )
      return false;
    const summary = this.redact(reason);
    this.controls.submitResult({
      taskId,
      sessionId: run.sessionId,
      runId: run.id,
      toolCallId: `system:result-failure:${run.id}`,
      outcome: "failed",
      notice: `任务执行未完成：${summary}`,
      summary,
    });
    this.events.emit({
      scope: taskId,
      kind: "error",
      summary,
      payload: { runId: run.id },
    });
    return true;
  }

  private settleRun(taskId: string, run: Run): boolean {
    const task = this.store.tasks.get(taskId);
    if (
      !task ||
      this.store.tasks.isTerminal(task.status) ||
      this.hasResult(run.id) ||
      this.store.inbox.listPending(taskId).length ||
      this.store.operations.findActiveForTask(taskId)
    )
      return false;
    if (run.status === "failed" || run.status === "aborted") {
      const reason = this.events
        .list(taskId, 20)
        .find((event) => event.kind === "error")?.summary;
      return this.failRun(
        taskId,
        run,
        reason ?? "本轮执行中断，可在任务中发送新的消息重试。",
      );
    }
    if (run.status !== "completed") return false;

    const inputs = this.store.db
      .prepare(
        "SELECT t.source, t.external_id FROM inbox i JOIN triggers t ON t.id = i.trigger_id WHERE i.run_id = ?",
      )
      .all(run.id);
    const priorAttempts = inputs.map((row) =>
      row.source === "system"
        ? Number(
            /^worker-result:run_[a-zA-Z0-9]+:(\d+)$/.exec(
              String(row.external_id),
            )?.[1] ?? 0,
          )
        : 0,
    );
    const attempt = inputs.some((row) => row.source !== "system")
      ? 1
      : Math.max(0, ...priorAttempts) + 1;
    if (attempt > MAX_RESULT_FOLLOWUPS)
      return this.failRun(
        taskId,
        run,
        "模型在两次自动提醒后仍未提交任务结果，已停止执行。可重试或更换模型。",
      );

    const externalId = `worker-result:${run.id}:${attempt}`;
    this.store.transaction(() => {
      const trigger =
        this.store.triggers.findByExternal("system", externalId) ??
        this.store.triggers.insert({
          source: "system",
          externalId,
          threadId: null,
          actorId: "system",
          payloadRef: `run:${run.id}`,
          preview: `Your previous Run ended without submitting a Task result. This is automatic follow-up ${attempt}/${MAX_RESULT_FOLLOWUPS}. Continue the original goal using the existing workspace and conversation; do not repeat completed side effects. If the work is finished, call the cli tool now with _submit_result --outcome completed --notice 'Short user-facing outcome' --summary 'Your full findings and evidence'. A prose answer alone does not finish the Task. Use needs_input only if you need a specific answer from the user, and include the question in notice and summary. Use failed if you cannot proceed. Reply in the user's language.`,
          status: "routed",
        });
      this.store.inbox.insertOrGet({ target: taskId, triggerId: trigger.id });
      if (task.status === "waiting" || task.status === "pending")
        this.store.tasks.transition(taskId, task.status, "active");
    });
    this.events.emit({
      scope: taskId,
      kind: "continuation",
      summary: `任务尚未提交结果，自动继续收尾（${attempt}/${MAX_RESULT_FOLLOWUPS}）`,
      payload: { runId: run.id, attempt },
    });
    return true;
  }

  notifyOperationComplete(operationId: string): void {
    const op = this.store.operations.get(operationId);
    if (!op) return;
    const externalId = `operation:${operationId}`;
    if (this.store.triggers.findByExternal("system", externalId)) return;

    this.store.transaction(() => {
      const trigger = this.store.triggers.insert({
        source: "system",
        externalId,
        threadId: null,
        actorId: "system",
        payloadRef: `op:${operationId}`,
        preview: `Operation ${operationId} ${op.status} (exit ${op.exitCode})`,
        status: "routed",
      });
      this.store.inbox.insertOrGet({
        target: op.taskId,
        triggerId: trigger.id,
      });
    });
  }
}

function orderInbox(items: InboxItem[]): InboxItem[] {
  const steer = items.filter((i) => i.steer);
  const rest = items.filter((i) => !i.steer);
  return [...steer, ...rest];
}

function buildWorkerPrompt(systemPrompt: string, skills: string[]): string {
  const skillLines =
    skills.length === 0
      ? ""
      : `\n\nAvailable skills (use _skill through cli, or read the snapshot files listed by Pizza):\n${skills.map((s) => `- ${s}`).join("\n")}`;
  return `${systemPrompt}\n\nTool interface: the only model tool is Pizza native cli. Use _read/_write/_edit for file operations, _skill list/load/read for skills, and authorized shell commands for execution. cli.timeout is in milliseconds and commands wait for completion. Submit results with _submit_result --outcome completed --notice TEXT --summary TEXT; choose failed or needs_input when appropriate. A prose answer does not finish the Task: invoke _submit_result through cli before ending your turn. Use needs_input only for a concrete question that requires a user answer. Quote text values. Run _submit_result --help for JSON/heredoc input. It is always available.${skillLines}`;
}

function formatWorkerBatch(
  rows: { item: InboxItem; trigger: Trigger }[],
): string {
  return rows
    .map(({ item, trigger }) => {
      const flag = item.steer ? " [STEER]" : "";
      return `-${flag} trigger=${trigger.id} source=${trigger.source}: ${trigger.preview}`;
    })
    .join("\n");
}
