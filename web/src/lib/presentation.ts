import { t as tr, getLocale, translate } from "../i18n";
import type { TaskStatus, Source } from "../api";
export function sourceStatus(source: Source) {
  if (source.poll) {
    if (source.poll.error) return tr("adapter.pollFailed");
    return source.poll.lastSuccess ? tr("adapter.pollActive") : tr("adapter.pollStarting");
  }
  if (source.id === "feishu" && source.receiveMode === "websocket") {
    const states: Record<string, string> = {
      connected: tr("source.wsConnected"),
      connecting: tr("source.wsConnecting"),
      reconnecting: tr("source.wsReconnecting"),
      failed: tr("source.wsFailed"),
      idle: tr("source.wsIdle"),
      disabled: tr("common.disabled"),
    };
    return states[source.connectionState ?? "idle"] ?? tr("source.wsIdle");
  }
  return source.transport === "available"
    ? source.id === "console"
      ? tr("source.consoleAvailable")
      : tr("source.adapterEnabled")
    : tr("source.notEnabled");
}
export const statusLabels: Record<TaskStatus, string> = {
  pending: "status.pending",
  active: "status.active",
  waiting: "status.waiting",
  completed: "status.completed",
  failed: "status.failed",
  cancelled: "status.cancelled",
};
export const sourceLabels: Record<string, string> = {
  console: "source.console",
  feishu: "source.feishu",
  github: "source.github",
  webhook: "source.webhook",
  system: "source.system",
};
export function time(value: string | null, full = false) {
  if (!value) return tr("common.noRecord");
  const date = new Date(value);
  return date.toLocaleString(
    getLocale() === "zh" ? "zh-CN" : "en-US",
    full
      ? {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }
      : {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        },
  );
}
export function shortId(id: string) {
  return id.replace("task_", "").slice(0, 8);
}

export function sourceName(id: string, locale = getLocale()) {
  return translate(locale, sourceLabels[id] ?? id);
}
