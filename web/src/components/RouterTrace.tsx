import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsSplitIcon,
  ArrowDownIcon,
  ArrowUpRightIcon,
  ChatCircleTextIcon,
  RobotIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import type {
  Overview,
  Run,
  RouterTrace as Trace,
  WorkerDefinition,
} from "../api";
import { recordedRoutes, routingTotals } from "../lib/router-trace";
import { sourceName, time, shortId } from "../lib/presentation";
import { t as tr, useLocale } from "../i18n";
import { SourceIcon } from "./shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import "./RouterTrace.css";

export function RouterTrace({
  data,
  run,
  trace,
  loading,
  following,
  onTask,
  onWorker,
}: {
  data: Overview;
  run: Run | null;
  trace: Trace | null;
  loading: boolean;
  following: boolean;
  onTask: (id: string) => void;
  onWorker: (id: string) => void;
}) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const inputNode = useRef<HTMLDivElement>(null);
  const hubNode = useRef<HTMLDivElement>(null);
  const targetNodes = useRef(new Map<string, HTMLDivElement>());
  const [wires, setWires] = useState<{ id: string; path: string }[]>([]);
  const routes = useMemo(
    () => recordedRoutes(run, trace, data.tasks),
    [run, trace, data.tasks],
  );
  const totals = useMemo(
    () => routingTotals(data.router.runs),
    [data.router.runs],
  );
  const selected = new Map(
    routes.targets.map((target) => [target.workerId, target]),
  );
  const definitions = new Map<string, WorkerDefinition>(
    data.definitions.map((definition) => [definition.id, definition]),
  );
  for (const target of routes.targets) {
    const task = data.tasks.find((task) => task.id === target.taskIds[0]);
    if (task && !definitions.has(target.workerId))
      definitions.set(target.workerId, task.definition);
  }
  const workers = [...definitions.values()]
    .map((definition) => {
      const tasks = data.tasks.filter(
        (task) => task.definition.id === definition.id,
      );
      return {
        definition,
        active: tasks.filter((task) => task.status === "active").length,
        pending: tasks.filter((task) => task.status === "pending").length,
        total: tasks.length,
        selected: selected.get(definition.id),
        available: data.definitions.some((item) => item.id === definition.id),
      };
    })
    .sort(
      (a, b) =>
        Number(!!b.selected) - Number(!!a.selected) ||
        b.active - a.active ||
        b.total - a.total ||
        Number(b.definition.id === "coding") -
          Number(a.definition.id === "coding") ||
        a.definition.id.localeCompare(b.definition.id),
    );
  const visibleWorkers = expanded
    ? workers
    : workers.slice(0, Math.max(4, routes.targets.length));
  const targetKeys = JSON.stringify([
    "reply",
    ...visibleWorkers.map((worker) => `worker:${worker.definition.id}`),
  ]);

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      if (!stage.current || !inputNode.current || !hubNode.current) return;
      const box = stage.current.getBoundingClientRect();
      const hub = hubNode.current.getBoundingClientRect();
      const input = inputNode.current.getBoundingClientRect();
      const curve = (from: DOMRect, to: DOMRect) => {
        const x1 = from.right - box.left,
          y1 = from.top + from.height / 2 - box.top;
        const x2 = to.left - box.left,
          y2 = to.top + to.height / 2 - box.top;
        const middle = x1 + (x2 - x1) / 2;
        return `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;
      };
      setWires([
        { id: "input", path: curve(input, hub) },
        ...[...targetNodes.current].map(([id, element]) => ({
          id,
          path: curve(hub, element.getBoundingClientRect()),
        })),
      ]);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    for (const element of [
      stage.current,
      inputNode.current,
      hubNode.current,
      ...targetNodes.current.values(),
    ])
      if (element) observer.observe(element);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [targetKeys]);

  const inputs = trace?.inputs ?? run?.inputs ?? [];
  const source = inputs[0]?.source ?? "console";
  const graphLabel = tr(`routerView.outcome.${routes.outcome}`);
  const lit = (id: string) =>
    id === "input" ? !!run : id === "reply" ? routes.reply : selected.has(id.slice("worker:".length));
  const register = (id: string) => (element: HTMLDivElement | null) => {
    if (element) targetNodes.current.set(id, element);
    else targetNodes.current.delete(id);
  };

  return (
    <>
      <section
        className="routing-board"
        aria-label={tr("routerView.graphLabel")}
      >
        <header className="routing-board-header">
          <div className="routing-board-title">
            <span
              className={`routing-live-dot ${routes.running ? "is-running" : ""}`}
            />
            <strong>
              {following
                ? tr("routerView.liveView")
                : tr("routerView.historyView")}
            </strong>
            <span className="routing-board-divider">/</span>
            <span>
              {run ? time(run.createdAt, true) : tr("routerView.noRuns")}
            </span>
          </div>
          <span
            className={`routing-outcome outcome-${routes.outcome}`}
            role="status"
          >
            {loading && !trace ? tr("routerView.loading") : graphLabel}
          </span>
        </header>
        <p className="routing-board-caption">
          {tr("routerView.policyCaption")}
        </p>
        <div className="routing-stage" ref={stage}>
          <svg className="routing-wires" aria-hidden="true">
            {wires.map((wire) => (
              <path
                key={wire.id}
                d={wire.path}
                className={`${lit(wire.id) ? "is-lit" : ""} ${lit(wire.id) && routes.running ? "is-flowing" : ""}`}
              />
            ))}
          </svg>
          <div className="routing-input-column">
            <span className="routing-column-label">
              {tr("routerView.input")}
            </span>
            <div
              className={`routing-input-node ${run ? "has-input" : ""}`}
              ref={inputNode}
            >
              <div className="routing-input-heading">
                <span className="routing-source-icon">
                  <SourceIcon source={source} size={20} />
                </span>
                <div>
                  <strong>
                    {inputs.length > 1
                      ? tr("routerView.inputBatch", { v0: inputs.length })
                      : sourceName(source)}
                  </strong>
                  <span className="routing-node-meta">
                    {inputs.length
                      ? tr("routerView.inputCount", { v0: inputs.length })
                      : tr("routerView.queuedCount", { v0: data.router.queued })}
                  </span>
                </div>
              </div>
              <p title={inputs.map((input) => input.preview).join("\n\n")}>
                {inputs[0]?.preview || tr("routerView.noInput")}
              </p>
            </div>
          </div>
          <ArrowDownIcon
            className="routing-mobile-arrow"
            size={20}
            aria-hidden="true"
          />
          <div className="routing-hub-column">
            <span className="routing-column-label">
              {tr("routerView.intentRouting")}
            </span>
            <div
              className={`routing-hub ${routes.running ? "is-running" : ""}`}
              ref={hubNode}
            >
              <div className="routing-hub-heading">
                <span className="routing-hub-icon">
                  <ArrowsSplitIcon size={24} weight="duotone" />
                </span>
                <strong>Router</strong>
              </div>
              <span className="routing-node-meta">
                {routes.running ? tr("router.deciding") : graphLabel}
              </span>
              <div className="routing-model">
                <span>
                  {tr(run ? "routerView.runModel" : "routerView.currentModel")}
                </span>
                <code>
                  {run
                    ? trace?.model
                      ? `${trace.model.provider} / ${trace.model.model}`
                      : loading
                        ? tr("routerView.loading")
                        : tr("routerView.modelNotRecorded")
                    : data.router.model}
                </code>
              </div>
              <button
                className="routing-policy-button"
                onClick={() => setRulesOpen(true)}
              >
                {tr("routerView.currentPolicy")}
                <CaretRightIcon size={12} />
              </button>
            </div>
          </div>
          <ArrowDownIcon
            className="routing-mobile-arrow"
            size={20}
            aria-hidden="true"
          />
          <div className="routing-targets">
            <div className="routing-targets-heading">
              <span className="routing-column-label">
                {tr("routerView.destinations")}
              </span>
              {workers.length > 4 ? (
                <button
                  className="routing-expand"
                  onClick={() => setExpanded((value) => !value)}
                  aria-expanded={expanded}
                  aria-label={tr(
                    expanded ? "routerView.collapseWorkers" : "routerView.showWorkers",
                    { v0: workers.length },
                  )}
                >
                  {tr("routerView.workerCount", { v0: workers.length })}
                  <CaretRightIcon
                    size={12}
                    className={expanded ? "is-expanded" : ""}
                  />
                </button>
              ) : (
                <span>{tr("routerView.workerCount", { v0: workers.length })}</span>
              )}
            </div>
            <div className="routing-target-list">
              <div
                className={`routing-target routing-reply ${routes.reply ? "is-selected" : ""}`}
                ref={register("reply")}
              >
                <span className="routing-target-icon">
                  <ChatCircleTextIcon size={18} />
                  <span className={`routing-target-dot ${routes.reply ? "is-selected" : ""}`} />
                </span>
                <div className="routing-target-copy">
                  <strong>{tr("routerView.directReply")}</strong>
                  <small>{tr("routerView.replyHint")}</small>
                </div>
                <span className="routing-target-status">
                  {routes.reply
                    ? tr("routerView.recorded")
                    : tr("routerView.available")}
                </span>
              </div>
              {visibleWorkers.map((worker) => (
                <div
                  key={worker.definition.id}
                  className={`routing-target ${worker.selected ? "is-selected" : ""}`}
                  ref={register(`worker:${worker.definition.id}`)}
                >
                  <span className="routing-target-icon">
                    <RobotIcon size={18} />
                    <span className={`routing-target-dot ${worker.selected ? "is-selected" : ""} ${worker.active ? "is-working" : ""}`} />
                  </span>
                  <button
                    className="routing-target-copy routing-worker-button"
                    disabled={!worker.available}
                    onClick={() => onWorker(worker.definition.id)}
                    title={tr(worker.definition.description || "")}
                  >
                    <strong>
                      {worker.definition.id}
                      <ArrowUpRightIcon size={12} />
                    </strong>
                    <small>
                      {tr(
                        worker.definition.description ||
                          "routerView.archivedWorker",
                      )}
                    </small>
                  </button>
                  <span
                    className={`routing-target-status ${worker.active ? "is-active" : ""}`}
                  >
                    {worker.active
                      ? tr("routerView.workerRunning", { v0: worker.active })
                      : worker.pending
                        ? tr("routerView.workerQueued", { v0: worker.pending })
                        : tr("routerView.idle")}
                  </span>
                  {worker.selected && (
                    <div className="routing-target-tasks">
                      {worker.selected.taskIds.map((id) => (
                        <button key={id} onClick={() => onTask(id)}>
                          <span>{tr("routerView.task")}</span>
                          <code>{shortId(id)}</code>
                          <ArrowUpRightIcon size={11} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="routing-legend">
          <span>
            <i className="is-lit" />
            {tr("routerView.recordedPath")}
          </span>
          <span>
            <i />
            {tr("routerView.availablePath")}
          </span>
          {routes.missingTarget && (
            <span className="routing-missing">
              {tr("routerView.missingTarget")}
            </span>
          )}
        </div>
        <footer className="routing-metrics">
          <div>
            <strong>{data.router.runs.length}</strong>
            <span>{tr("routerView.rounds")}</span>
          </div>
          <div>
            <strong>{totals.created}</strong>
            <span>{tr("routerView.createdTasks")}</span>
          </div>
          <div>
            <strong>{totals.replies}</strong>
            <span>{tr("routerView.recordedReplies")}</span>
          </div>
          <div>
            <strong>{data.stats.active}</strong>
            <span>{tr("routerView.activeTasks")}</span>
          </div>
        </footer>
      </section>
      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("routerView.currentPolicy")}</DialogTitle>
            <DialogDescription>
              {tr("routerView.evidenceHint")}
            </DialogDescription>
          </DialogHeader>
          <ul className="routing-policy-list">
            <li>{tr("routerView.workRule")}</li>
            <li>{tr("routerView.questionRule")}</li>
            <li>{tr("routerView.followupRule")}</li>
          </ul>
          {data.router.instructions && (
            <p className="preserve-lines">{data.router.instructions}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
