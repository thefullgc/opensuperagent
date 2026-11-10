import type { Db } from "../db.js";
import { row, rows } from "../db.js";
import type { SessionRow, Run, RunStatus } from "../../types.js";
import { newId, nowIso } from "../../ids.js";

interface SessionDbRow {
  id: string;
  owner: string;
  events_path: string;
  created_at: string;
}

interface RunDbRow {
  id: string;
  session_id: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  updated_at: string;
}

function mapSession(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    owner: r.owner,
    eventsPath: r.events_path,
    createdAt: r.created_at,
  };
}

function mapRun(r: RunDbRow): Run {
  return {
    id: r.id,
    sessionId: r.session_id,
    status: r.status as RunStatus,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  getByOwner(owner: string): SessionRow | null {
    const r = row<SessionDbRow>(
      this.db.prepare("SELECT * FROM sessions WHERE owner = ?").get(owner),
    );
    return r ? mapSession(r) : null;
  }

  get(id: string): SessionRow | null {
    const r = row<SessionDbRow>(
      this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id),
    );
    return r ? mapSession(r) : null;
  }

  ensure(owner: string, eventsPath: string): SessionRow {
    const existing = this.getByOwner(owner);
    if (existing) return existing;
    const id = newId("ses");
    const createdAt = nowIso();
    this.db
      .prepare(
        "INSERT INTO sessions (id, owner, events_path, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, owner, eventsPath, createdAt);
    return { id, owner, eventsPath, createdAt };
  }

  listAll(): SessionRow[] {
    return rows<SessionDbRow>(
      this.db.prepare("SELECT * FROM sessions").all(),
    ).map(mapSession);
  }
}

export class RunRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Run | null {
    const r = row<RunDbRow>(
      this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id),
    );
    return r ? mapRun(r) : null;
  }

  latest(sessionId: string): Run | null {
    const result = row<RunDbRow>(this.db.prepare(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(sessionId));
    return result ? mapRun(result) : null;
  }

  create(sessionId: string): Run {
    const id = newId("run");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, status, input_tokens, output_tokens, created_at, updated_at)
         VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .run(id, sessionId, now, now);
    return {
      id,
      sessionId,
      status: "pending",
      inputTokens: null,
      outputTokens: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  transition(id: string, from: RunStatus, to: RunStatus): boolean {
    const result = this.db
      .prepare(
        "UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
      )
      .run(to, nowIso(), id, from);
    return Number(result.changes) > 0;
  }

  findActive(sessionId: string): Run | null {
    const r = row<RunDbRow>(
      this.db
        .prepare(
          `SELECT * FROM runs
           WHERE session_id = ? AND status IN ('pending', 'submitted')
           LIMIT 1`,
        )
        .get(sessionId),
    );
    return r ? mapRun(r) : null;
  }

  listIncomplete(): Run[] {
    return rows<RunDbRow>(
      this.db
        .prepare(
          `SELECT * FROM runs WHERE status IN ('pending', 'submitted') ORDER BY created_at`,
        )
        .all(),
    ).map(mapRun);
  }
}
