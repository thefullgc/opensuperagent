import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowsSplitIcon,
  ArrowClockwiseIcon,
  PaperPlaneTiltIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  api,
  type Overview,
  type RouterTrace as TraceData,
  type Run,
} from "../api";
import { t as tr, useLocale } from "../i18n";
import { time, sourceName } from "../lib/presentation";
import { asRecord } from "../lib/router-trace";
import { Button } from "../components/ui/button";
import { PageHeading, SectionTitle, EventFeed } from "../components/shared";
import { RouterTrace } from "../components/RouterTrace";

function actionLabel(action: Run["actions"][number]) {
  const result = asRecord(action.result);
  if (action.tool === "start_task" && result.created === false)
    return tr("routerView.reusedTask");
  const labels: Record<string, string> = {
    start_task: "routerView.actionCreate",
    send_to_task: "routerView.actionContinue",
    stop_task: "routerView.actionStop",
    reply: "routerView.directReply",
  };
  return labels[action.tool] ? tr(labels[action.tool]) : action.tool;
}

export function RouterPage({
  data,
  onTask,
  onWorker,
  refresh,
  notify,
}: {
  data: Overview;
  onTask: (id: string) => void;
  onWorker: (id: string) => void;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  useLocale();
  const [selection, setSelection] = useState("live");
  const [response, setResponse] = useState<{
    key: string;
    detail: TraceData | null;
    error: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const runs = [...data.router.runs].reverse();
  const historical =
    selection === "live" ? null : runs.find((run) => run.id === selection);
  const selected = historical ?? runs[0] ?? null;
  const selectedId = selected?.id;
  const stamp =
    data.router.journal.find(
      (event) => asRecord(event.payload).runId === selectedId,
    )?.id ?? selected?.updatedAt;
  const requestKey = `${selectedId ?? ""}:${stamp ?? ""}:${retry}`;
  const trace = response?.detail && response.detail.id === selectedId ? response.detail : null;
  const loading = !!selectedId && response?.key !== requestKey;
  const error = response?.key === requestKey ? response.error : "";
  const recentRuns = runs.slice(0, 50);
  if (historical && !recentRuns.some((run) => run.id === historical.id))
    recentRuns.push(historical);

  useEffect(() => {
    if (!selectedId) return;
    const abort = new AbortController();
    void api
      .routerTrace(selectedId, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted)
          setResponse({ key: requestKey, detail: value, error: "" });
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setResponse((previous) => ({
            key: requestKey,
            detail:
              previous?.detail && previous.detail.id === selectedId ? previous.detail : null,
            error: failure instanceof Error ? failure.message : String(failure),
          }));
      });
    return () => abort.abort();
  }, [selectedId, requestKey]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api.routerMessage(text.trim());
      setText("");
      setSelection("live");
      notify(tr("router.sent"));
      await refresh();
    } catch (failure) {
      notify(String(failure), true);
    } finally {
      setBusy(false);
    }
  }

  const actions = trace?.actions ?? selected?.actions ?? [];
  return (
    <div className="router-visual-page">
      <PageHeading
        eyebrow="ROUTER / TRACE"
        title={tr("routerView.title")}
        description={tr("routerView.description")}
        action={
          <div className="routing-page-controls">
            <select
              aria-label={tr("routerView.selectRun")}
              value={historical?.id ?? "live"}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="live">{tr("routerView.followLive")}</option>
              {recentRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {time(run.createdAt, true)} · {run.id.slice(-8)}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="icon"
              aria-label={tr("shell.refresh")}
              onClick={() => {
                setRetry((value) => value + 1);
                void refresh();
              }}
            >
              <ArrowClockwiseIcon />
            </Button>
          </div>
        }
      />
      {error && (
        <div className="error-banner routing-error" role="alert">
          <WarningCircleIcon />
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            {tr("shell.retry")}
          </Button>
        </div>
      )}
      <RouterTrace
        data={data}
        run={selected}
        trace={trace}
        loading={loading}
        following={!historical}
        onTask={onTask}
        onWorker={onWorker}
      />

      <div className="routing-audit">
        <section className="panel">
          <SectionTitle
            title={tr("routerView.history")}
            meta={tr("router.roundsMeta", { v0: data.router.runs.length })}
          />
          <div className="routing-history">
            {!recentRuns.length && (
              <p className="routing-empty">{tr("routerView.noRuns")}</p>
            )}
            {recentRuns.map((run) => (
              <button
                key={run.id}
                className={run.id === selectedId ? "is-selected" : ""}
                onClick={() => setSelection(run.id)}
                aria-current={run.id === selectedId ? "true" : undefined}
              >
                <span>
                  <strong>{run.inputs[0]?.preview || run.id}</strong>
                  <small>
                    {time(run.createdAt, true)} · {run.id.slice(-8)}
                  </small>
                </span>
                <span className="run-label">
                  {run.status === "pending" || run.status === "submitted"
                    ? tr("router.deciding")
                    : run.status === "failed" || run.status === "aborted"
                      ? tr("routerView.roundFailed")
                      : run.actions.length
                        ? tr("routerView.actionCount", {
                            v0: run.actions.length,
                          })
                        : tr("routerView.noActions")}
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel" id="router-run-records">
          <SectionTitle
            title={tr("routerView.evidence")}
            meta={selected?.id.slice(-8)}
          />
          <div className="routing-detail-content">
            <p>{tr("routerView.evidenceHint")}</p>
            <div className="routing-input-details">
              {(trace?.inputs ?? selected?.inputs ?? []).map((input) => (
                <div key={input.id}>
                  <small>
                    {sourceName(input.source)} · {input.id}
                  </small>
                  <p>{input.preview}</p>
                </div>
              ))}
            </div>
            {!actions.length && (
              <div className="routing-empty">
                {loading && !trace
                  ? tr("routerView.loading")
                  : tr("routerView.noActionDetail")}
              </div>
            )}
            {actions.map((action) => {
              const args = "args" in action ? action.args : null;
              const reply =
                "replyText" in action && typeof action.replyText === "string"
                  ? action.replyText
                  : null;
              return (
                <article className="routing-action" key={action.toolCallId}>
                  <div className="routing-action-head">
                    <strong>{actionLabel(action)}</strong>
                    <code>{action.tool}</code>
                    <time>{time(action.createdAt)}</time>
                  </div>
                  {reply && <p>{reply}</p>}
                  <details>
                    <summary>{tr("routerView.rawAction")}</summary>
                    <pre>
                      {JSON.stringify(
                        { arguments: args, result: action.result },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </article>
              );
            })}
            <details className="routing-raw-events">
              <summary>{tr("routerView.toolTimeline")}</summary>
              <EventFeed events={trace?.journal ?? []} onTask={onTask} />
            </details>
          </div>
        </section>
      </div>

      <details className="panel routing-activity">
        <summary>{tr("routerView.recentEvents")}</summary>
        <EventFeed events={data.router.journal} onTask={onTask} />
      </details>
      <section className="panel routing-message">
        <SectionTitle
          title={tr("router.sendToRouter")}
          meta={<ArrowsSplitIcon size={17} />}
        />
        <form
          className="router-composer"
          onSubmit={(event) => void send(event)}
        >
          <textarea
            aria-label={tr("router.sendToRouter")}
            placeholder={tr("router.composerPlaceholder")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button disabled={busy || !text.trim()} type="submit">
            <PaperPlaneTiltIcon />
            {tr("router.sendToRouter")}
          </Button>
        </form>
      </section>
    </div>
  );
}
