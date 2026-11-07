import type { Db } from "../db.js";
import { row, rows } from "../db.js";
import type {
  Task,
  TaskResult,
  TaskStatus,
  WorkerDefinitionSpec,
} from "../../types.js";
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
  constructor(private readonly db: Db) {}

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

  addSubscription(taskId: string, threadId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO subscriptions (task_id, thread_id) VALUES (?, ?)",
      )
      .run(taskId, threadId);
  }

  findOpenByThread(threadId: string): Task[] {
    const placeholders = OPEN_STATUSES.map(() => "?").join(",");
    return rows<TaskRow>(
      this.db
        .prepare(
          `SELECT t.* FROM tasks t
           JOIN subscriptions s ON s.task_id = t.id
           WHERE s.thread_id = ? AND t.status IN (${placeholders})
           ORDER BY t.created_at, t.id`,
        )
        .all(threadId, ...OPEN_STATUSES),
    ).map(mapTask);
  }

  isTerminal(status: TaskStatus): boolean {
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }
}
