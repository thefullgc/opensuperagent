import type { Db } from "../db.js";
import { row, rows } from "../db.js";
import type {
  SubscriptionRole,
  Task,
  TaskResult,
  TaskStatus,
  WorkerDefinitionSpec,
} from "../../types.js";
import type { ThreadRepo } from "./threads.js";
import { newId, nowIso } from "../../ids.js";

interface TaskRow {
  id: string;
  owner_id: string;
  objective: string;
  definition: string;
  origin_trigger_id: string;
  workspace_path: string;
  branch: string | null;
  status: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

function mapTask(r: TaskRow): Task {
  return {
    id: r.id,
    ownerId: r.owner_id,
    objective: r.objective,
    definition: JSON.parse(r.definition) as WorkerDefinitionSpec,
    originTriggerId: r.origin_trigger_id,
    workspacePath: r.workspace_path,
    branch: r.branch,
    status: r.status as TaskStatus,
    result: r.result ? (JSON.parse(r.result) as TaskResult) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const OPEN_STATUSES: TaskStatus[] = ["pending", "active", "waiting"];

export class TaskRepo {
  constructor(
    private readonly db: Db,
    private readonly threads?: ThreadRepo,
  ) {}

  get(id: string): Task | null {
    const r = row<TaskRow>(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id),
    );
    return r ? mapTask(r) : null;
  }

  insert(input: {
    ownerId: string;
    objective: string;
    definition: WorkerDefinitionSpec;
    originTriggerId: string;
    workspacePath: string;
    branch?: string | null;
    status?: TaskStatus;
  }): Task {
    const id = newId("task");
    const now = nowIso();
    const status = input.status ?? "pending";
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, owner_id, objective, definition, origin_trigger_id, workspace_path, branch, status, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.ownerId,
        input.objective,
        JSON.stringify(input.definition),
        input.originTriggerId,
        input.workspacePath,
        input.branch ?? null,
        status,
        now,
        now,
      );
    return {
      id,
      ownerId: input.ownerId,
      objective: input.objective,
      definition: input.definition,
      originTriggerId: input.originTriggerId,
      workspacePath: input.workspacePath,
      branch: input.branch ?? null,
      status,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  transition(id: string, from: TaskStatus, to: TaskStatus): boolean {
    const result = this.db
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
      )
      .run(to, nowIso(), id, from);
    return Number(result.changes) > 0;
  }

  retry(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE tasks SET status = 'pending', result = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
    ).run(nowIso(), id);
    return Number(result.changes) > 0;
  }

  complete(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    result: TaskResult,
  ): boolean {
    const placeholders = from.map(() => "?").join(",");
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = ?, result = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, JSON.stringify(result), nowIso(), id, ...from);
    return Number(res.changes) > 0;
  }

  list(filter?: { status?: TaskStatus }): Task[] {
    if (filter?.status) {
      return rows<TaskRow>(
        this.db
          .prepare(
            "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC",
          )
          .all(filter.status),
      ).map(mapTask);
    }
    return rows<TaskRow>(
      this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all(),
    ).map(mapTask);
  }

  listOpen(): Task[] {
    const placeholders = OPEN_STATUSES.map(() => "?").join(",");
    return rows<TaskRow>(
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`,
        )
        .all(...OPEN_STATUSES),
    ).map(mapTask);
  }

  countActive(): number {
    const r = row<{ c: number }>(
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM tasks WHERE status IN ('pending', 'active')",
        )
        .get(),
    );
    return Number(r?.c ?? 0);
  }

  /**
   * Subscribe a Task to a Thread.
   *
   * The first subscriber becomes the executor unless a role is explicitly
   * requested. Later subscribers default to observer; multi-executor Threads
   * require an explicit `role: "executor"` (Router does this when it assigns a
   * trigger to an existing Task).
   */
  addSubscription(
    taskId: string,
    threadId: string,
    requestedRole?: SubscriptionRole,
  ): SubscriptionRole {
    this.threads?.ensure({
      id: threadId,
      source: "system",
      externalKey: threadId,
    });
    const existing = row<{ role: string }>(
      this.db
        .prepare(
          "SELECT role FROM subscriptions WHERE task_id = ? AND thread_id = ?",
        )
        .get(taskId, threadId),
    );
    if (existing) {
      if (requestedRole === "executor" && existing.role !== "executor") {
        this.db
          .prepare(
            "UPDATE subscriptions SET role = 'executor' WHERE task_id = ? AND thread_id = ?",
          )
          .run(taskId, threadId);
        this.threads?.claimOwner(threadId, taskId);
        return "executor";
      }
      return existing.role as SubscriptionRole;
    }

    const hasExecutor = row<{ x: number }>(
      this.db
        .prepare(
          `SELECT 1 AS x
           FROM subscriptions s
           JOIN tasks t ON t.id = s.task_id
           WHERE s.thread_id = ? AND s.role = 'executor'
             AND t.status IN ('pending', 'active', 'waiting')
           LIMIT 1`,
        )
        .get(threadId),
    );
    const role: SubscriptionRole =
      requestedRole ?? (hasExecutor ? "observer" : "executor");
    this.db
      .prepare(
        "INSERT INTO subscriptions (task_id, thread_id, role, cursor_seq) VALUES (?, ?, ?, 0)",
      )
      .run(taskId, threadId, role);
    if (role === "executor") this.threads?.claimOwner(threadId, taskId);
    return role;
  }

  isExecutor(taskId: string): boolean {
    return !!row<{ x: number }>(
      this.db
        .prepare(
          "SELECT 1 AS x FROM subscriptions WHERE task_id = ? AND role = 'executor' LIMIT 1",
        )
        .get(taskId),
    );
  }

  hasSubscription(taskId: string): boolean {
    return !!row<{ x: number }>(
      this.db
        .prepare("SELECT 1 AS x FROM subscriptions WHERE task_id = ? LIMIT 1")
        .get(taskId),
    );
  }

  advanceCursor(taskId: string, threadId: string, seq: number): void {
    this.db
      .prepare(
        `UPDATE subscriptions
         SET cursor_seq = CASE WHEN cursor_seq < ? THEN ? ELSE cursor_seq END
         WHERE task_id = ? AND thread_id = ?`,
      )
      .run(seq, seq, taskId, threadId);
  }

  findOpenByThread(threadId: string): Task[] {
    return this.findOpenByRole(threadId, "executor");
  }

  findOpenObserversByThread(threadId: string): Task[] {
    return this.findOpenByRole(threadId, "observer");
  }

  private findOpenByRole(
    threadId: string,
    role: SubscriptionRole,
  ): Task[] {
    const placeholders = OPEN_STATUSES.map(() => "?").join(",");
    return rows<TaskRow>(
      this.db
        .prepare(
          `SELECT t.* FROM tasks t
           JOIN subscriptions s ON s.task_id = t.id
           WHERE s.thread_id = ? AND s.role = ? AND t.status IN (${placeholders})
           ORDER BY t.created_at, t.id`,
        )
        .all(threadId, role, ...OPEN_STATUSES),
    ).map(mapTask);
  }

  isTerminal(status: TaskStatus): boolean {
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }
}
