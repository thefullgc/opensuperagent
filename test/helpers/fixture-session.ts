import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Store } from "../../src/storage/index.js";
import { rows, row } from "../../src/storage/db.js";
import type { RouterTools } from "../../src/router/tools.js";
import type { WorkerControls } from "../../src/worker/controls.js";
import type { EventBus } from "../../src/events/bus.js";
import type {
  FacadeFactory,
  SessionFacadeHandle,
} from "../../src/session/manager.js";
import { loadSkillsFromDir } from "@tomsun28/pizza";
import { newId, nowIso } from "../../src/ids.js";

const runFile = promisify(execFile);

/**
 * fixture agent runtime without Pizza LLM.
 * Router auto-dispatches to `coding`; Worker writes artifacts, runs a probe
 * command, and submits a completed result — enough to exercise the full pipeline.
 */
export function createFixtureFacadeFactory(deps: {
  store: Store;
  routerTools: RouterTools;
  workerControls: WorkerControls;
  events: EventBus;
}): FacadeFactory {
  return async ({ session, cwd }) => {
    let aborted = false;
    const handle: SessionFacadeHandle = {
      session,
      tagging: null,
      async prompt(text: string) {
        if (aborted) return;
        const active = deps.store.runs.findActive(session.id);
        if (!active) return;
        if (active.status === "pending") {
          deps.store.runs.transition(active.id, "pending", "submitted");
        }

        deps.events.emit({
          scope: session.owner,
          kind: "prompt",
          summary: text.slice(0, 160),
          payload: { runId: active.id },
        });

        if (session.owner === "router") {
          await runRouterTurn(deps, session.id, active.id);
        } else if (session.owner === "watchdog") {
          deps.events.emit({
            scope: "watchdog",
            kind: "assistant",
            summary: "Watchdog diagnosis: read-only inspection complete",
          });
        } else {
          await runWorkerTurn(deps, session.owner, session.id, active.id, cwd);
        }

        const run = deps.store.runs.get(active.id);
        if (run?.status === "submitted") {
          deps.store.runs.transition(active.id, "submitted", "completed");
        }
        deps.events.emit({
          scope: session.owner,
          kind: "run_completed",
          summary: `Run ${active.id} completed`,
          payload: { runId: active.id },
        });
      },
      async abort(reason?: string) {
        aborted = true;
        const active = deps.store.runs.findActive(session.id);
        if (active) {
          deps.store.runs.transition(
            active.id,
            active.status as "pending" | "submitted",
            "aborted",
          );
        }
        deps.events.emit({
          scope: session.owner,
          kind: "aborted",
          summary: reason ?? "aborted",
        });
      },
      async close() {
        /* no-op */
      },
    };
    return handle;
  };
}

async function runRouterTurn(
  deps: {
    store: Store;
    routerTools: RouterTools;
    events: EventBus;
  },
  sessionId: string,
  runId: string,
): Promise<void> {
  const coding = deps.store.catalog.getDefinition("coding");
  if (!coding) {
    deps.events.emit({
      scope: "router",
      kind: "error",
      summary: "No coding worker definition",
    });
    return;
  }

  const bound = rows<{ trigger_id: string }>(
    deps.store.db
      .prepare(
        `SELECT trigger_id FROM inbox WHERE run_id = ? AND status = 'accepted'`,
      )
      .all(runId),
  );

  for (const item of bound) {
    const triggerId = item.trigger_id;
    const assigned = row<{ x: number }>(
      deps.store.db
        .prepare(
          `SELECT 1 AS x FROM inbox WHERE trigger_id = ? AND target != 'router' LIMIT 1`,
        )
        .get(triggerId),
    );
    if (assigned) continue;

    const trigger = deps.store.triggers.get(triggerId);
    if (!trigger) continue;

    const result = deps.routerTools.startTask({
      sessionId,
      toolCallId: `fixture:${newId("tc")}`,
      runId,
      triggerIds: [triggerId],
      definition: "coding",
      objective: trigger.preview,
    });

    deps.events.emit({
      scope: "router",
      kind: "tool",
      summary: `start_task → ${result.taskId}`,
      payload: { tool: "start_task", result },
    });
  }
}

async function runWorkerTurn(
  deps: {
    store: Store;
    workerControls: WorkerControls;
    events: EventBus;
  },
  taskId: string,
  sessionId: string,
  runId: string,
  cwd?: string,
): Promise<void> {
  const task = deps.store.tasks.get(taskId);
  if (!task || deps.store.tasks.isTerminal(task.status)) return;

  const workspace = cwd ?? task.workspacePath;
  mkdirSync(workspace, { recursive: true });

  // Follow-up messages after an open task: append note and re-complete.
  const bound = rows<{ preview: string }>(
    deps.store.db
      .prepare(
        `SELECT t.preview FROM inbox i
         JOIN triggers t ON t.id = i.trigger_id
         WHERE i.run_id = ?`,
      )
      .all(runId),
  ).map((r) => r.preview);

  const objectiveBlock = [
    `# Task ${task.id}`,
    "",
    `Objective: ${task.objective}`,
    `Updated: ${nowIso()}`,
    "",
    "## Inputs this turn",
    ...bound.map((p) => `- ${p}`),
    "",
  ].join("\n");

  writeFileSync(join(workspace, "OBJECTIVE.md"), objectiveBlock);
  deps.events.emit({
    scope: taskId,
    kind: "tool",
    summary: "write OBJECTIVE.md",
    payload: { tool: "write", path: "OBJECTIVE.md" },
  });

  const notesPath = join(workspace, "NOTES.md");
  writeFileSync(
    notesPath,
    [
      `# Working notes`,
      ``,
      `- Agent: fixture (no Pizza LLM)`,
      `- Workspace: ${workspace}`,
      `- Definition: ${task.definition.id}`,
      `- Skills: ${task.definition.skills.join(", ") || "(none)"}`,
      ``,
      `## Progress`,
      `- Captured objective and inputs`,
      `- Ran workspace probe`,
      ``,
    ].join("\n"),
  );
  deps.events.emit({
    scope: taskId,
    kind: "tool",
    summary: "write NOTES.md",
    payload: { tool: "write", path: "NOTES.md" },
  });

  const execResult = await runFile("sh", ["-c", "pwd && date && ls -la"], { cwd: workspace, timeout: 30000 });
  deps.events.emit({
    scope: taskId,
    kind: "tool",
    summary: "exec probe",
    payload: { tool: "exec", result: execResult },
  });

  // Skill snapshot check
  const skills = loadSkillsFromDir({
    dir: join(workspace, "..", "..", "tasks", taskId, "skills"), source: "task",
  }).skills;
  deps.events.emit({
    scope: taskId,
    kind: "tool",
    summary: `skill list (${skills.length})`,
    payload: { tool: "skill", skills },
  });

  const submit = deps.workerControls.submitResult({
    sessionId,
    toolCallId: `fixture:${newId("tc")}`,
    runId,
    taskId,
    outcome: "completed",
    notice: `已完成：${task.objective}`,
    summary: `fixture worker wrote OBJECTIVE.md / NOTES.md and ran a workspace probe.`,
    artifacts: [`${workspace}/OBJECTIVE.md`, `${workspace}/NOTES.md`],
  });

  deps.events.emit({
    scope: taskId,
    kind: "tool",
    summary: submit.ok
      ? `_submit_result completed`
      : `_submit_result rejected: ${"reason" in submit ? submit.reason : ""}`,
    payload: { tool: "submit_result", result: submit },
  });
}
