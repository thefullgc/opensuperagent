import type { Run, RouterTrace, Task } from "../api";

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type RouteOutcome =
  | "empty"
  | "deciding"
  | "unrecorded"
  | "failed"
  | "dispatched"
  | "replied"
  | "mixed"
  | "stopped";

/** Only durable side-effect records establish a route; text output alone does not. */
export function recordedRoutes(
  run: Run | null,
  trace: RouterTrace | null,
  tasks: Task[],
) {
  const actions = trace?.actions ?? run?.actions ?? [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const targets = new Map<
    string,
    { workerId: string; taskIds: string[]; tools: string[] }
  >();
  let reply = false;
  let missingTarget = false;
  let hasDispatch = false;
  let hasStop = false;
  let rejected = false;
  for (const action of actions) {
    const result = asRecord(action.result);
    const args = asRecord("args" in action ? action.args : null);
    if (action.tool === "reply" && typeof result.deliveryId === "string")
      reply = true;
    if (
      !["start_task", "send_to_task", "stop_task"].includes(
        action.tool,
      )
    )
      continue;
    if (result.ok === false || result.error) {
      rejected = true;
      continue;
    }
    const ids = new Set<string>();
    if (typeof result.taskId === "string") ids.add(result.taskId);
    if (
      (action.tool === "send_to_task" || action.tool === "stop_task") &&
      typeof args.taskId === "string"
    )
      ids.add(args.taskId);
    if (!ids.size) {
      missingTarget = true;
      continue;
    }
    for (const id of ids) {
      const task = taskById.get(id);
      if (!task) {
        missingTarget = true;
        continue;
      }
      const workerId = task.definition.id;
      const target = targets.get(workerId) ?? {
        workerId,
        taskIds: [],
        tools: [],
      };
      if (!target.taskIds.includes(id)) target.taskIds.push(id);
      if (!target.tools.includes(action.tool)) target.tools.push(action.tool);
      targets.set(workerId, target);
      if (action.tool === "stop_task") hasStop = true;
      else hasDispatch = true;
    }
  }
  const running = run?.status === "pending" || run?.status === "submitted";
  const outcome: RouteOutcome = !run
    ? "empty"
    : reply && targets.size
      ? "mixed"
      : reply
        ? "replied"
        : hasDispatch
          ? "dispatched"
          : hasStop
            ? "stopped"
            : running
              ? "deciding"
              : rejected || run.status === "failed" || run.status === "aborted"
                ? "failed"
                : "unrecorded";
  return {
    targets: [...targets.values()],
    reply,
    missingTarget,
    running,
    outcome,
  };
}

export function routingTotals(runs: Run[]) {
  const taskIds = new Set<string>();
  const replies = new Set<string>();
  for (const run of runs)
    for (const action of run.actions) {
      const result = asRecord(action.result);
      if (
        action.tool === "start_task" &&
        result.created === true
      ) {
        if (typeof result.taskId === "string") taskIds.add(result.taskId);
      }
      if (action.tool === "reply" && typeof result.deliveryId === "string")
        replies.add(result.deliveryId);
    }
  return { created: taskIds.size, replies: replies.size };
}
