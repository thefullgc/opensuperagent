import { t as tr } from "./i18n";
export type TaskStatus =
  | "pending"
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export interface WorkerDefinition {
  id: string;
  description: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  cli?: { allowShell: boolean };
  skills: string[];
}
export interface Task {
  id: string;
  objective: string;
  definition: WorkerDefinition;
  originTriggerId: string;
  workspacePath: string;
  branch: string | null;
  status: TaskStatus;
  result: {
    outcome: string;
    notice: string;
    summary: string;
    artifacts?: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
  source: string;
  runCount: number;
}
export interface JournalEvent {
  id: string;
  scope: string;
  kind: string;
  summary: string;
  payload: unknown;
  createdAt: string;
}
export interface Skill {
  name: string;
  description: string;
  updatedAt: string;
}
export interface SkillDetail extends Skill {
  files: {
    path: string;
    content: string;
    truncated: boolean;
  }[];
}
export interface Source {
  id: string;
  configured: boolean;
  transport: string;
  receiveMode?: "websocket" | "webhook";
  connectionState?: string;
  implemented?: boolean;
  count: number;
  lastAt: string | null;
}
export interface Run {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  inputs: {
    id: string;
    source: string;
    preview: string;
    steer: number;
    threadId?: string | null;
    createdAt?: string;
  }[];
  actions: {
    tool: string;
    toolCallId: string;
    result: unknown;
    createdAt: string;
  }[];
}
export interface RouterTrace extends Omit<Run, "actions"> {
  model?: { provider: string; model: string } | null;
  actions: (Run["actions"][number] & { args: Record<string, unknown> | null; replyText: string | null })[];
  journal: JournalEvent[];
}
export interface Overview {
  tasks: Task[];
  definitions: WorkerDefinition[];
  skills: Skill[];
  sources: Source[];
  router: {
    model: string;
    instructions: string;
    runs: Run[];
    queued: number;
    active: boolean;
    journal: JournalEvent[];
  };
  events: JournalEvent[];
  agent: string;
  generatedAt: string;
  stats: {
    total: number;
    active: number;
    open: number;
    completed: number;
    capacity: number;
    runs: number;
    messages: number;
  };
}
export interface InboundMessage {
  id: string;
  source: string;
  preview: string;
  status: string;
  threadId: string | null;
  actorId: string | null;
  externalId: string;
  createdAt: string;
  routes: {
    target: string;
    status: string;
    runId: string | null;
  }[];
}
export interface TaskFlow {
  task: Task;
  origin: InboundMessage | null;
  runs: Run[];
  routerRuns: Run[];
  journal: JournalEvent[];
  subscriptions: {
    threadId: string;
  }[];
  operations: {
    id: string;
    cmd: string;
    status: string;
    exitCode: number | null;
  }[];
  deliveries: {
    id: string;
    channel: string;
    target: string;
    content: string;
    status: string;
    createdAt: string;
  }[];
}
export interface SystemInfo {
  dataRoot: string;
  listen: string;
  maxActiveTasks: number;
  activeTasks: number;
  openTasks: number;
  unknownOps: number;
  pendingDeliveries: number;
  definitions: number;
  skills: number;
  agent: string;
}
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function getToken() {
  return sessionStorage.getItem("osa-token") ?? "";
}
export function setToken(token: string) {
  if (token) sessionStorage.setItem("osa-token", token);
  else sessionStorage.removeItem("osa-token");
}
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(
      res.status,
      res.status === 401
        ? tr("api.tokenRequired")
        : body.error || tr("api.requestFailed", { v0: res.status }),
    );
  }
  return res.json() as Promise<T>;
}
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: "openai-compatible" | "anthropic";
  baseUrl: string;
  models: string[];
  maxTokens: number;
  apiKeyConfigured: boolean;
}
export interface ModelSelection {
  providerId: string;
  model: string;
}
export interface ModelRouting {
  router: ModelSelection | null;
  worker: ModelSelection | null;
  profiles: Record<string, ModelSelection>;
}
export interface RuntimeSettings {
  revision: number;
  providers: ProviderConfig[];
  routing: ModelRouting;
  adapters: Record<
    "github" | "feishu" | "webhook",
    Record<string, string | boolean | string[]>
  >;
}
export interface FeishuConnectionStatus {
  mode: "websocket" | "webhook";
  enabled: boolean;
  state:
    | "disabled"
    | "webhook"
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "failed";
  reconnectAttempts: number;
  lastConnectAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
  receivedEvents: number;
  ignoredEvents: number;
}
export const api = {
  resolveDelivery: (id: string, status: "sent" | "failed") =>
    req(`/api/deliveries/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  settings: () => req<RuntimeSettings>("/api/settings"),
  saveProvider: (
    provider: Omit<ProviderConfig, "apiKeyConfigured"> & {
      apiKey: string;
    },
  ) =>
    req<RuntimeSettings>("/api/settings/providers", {
      method: "PUT",
      body: JSON.stringify(provider),
    }),
  deleteProvider: (id: string) =>
    req<RuntimeSettings>(`/api/settings/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  saveRouting: (routing: ModelRouting) =>
    req<RuntimeSettings>("/api/settings/routing", {
      method: "PUT",
      body: JSON.stringify(routing),
    }),
  providerModels: (id: string) =>
    req<{
      models: string[];
    }>(`/api/settings/providers/${encodeURIComponent(id)}/models`, {
      method: "POST",
      body: "{}",
    }),
  testProvider: (id: string, model: string) =>
    req<{
      ok: boolean;
      latencyMs: number;
      model: string;
    }>(`/api/settings/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: JSON.stringify({ model }),
    }),
  saveAdapter: (id: string, config: Record<string, unknown>) =>
    req<RuntimeSettings>(`/api/settings/adapters/${id}`, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  testAdapter: (id: string) =>
    req<{
      ok: boolean;
      latencyMs: number;
      chats?: {
        id: string;
        name: string;
      }[];
      hasMore?: boolean;
      warning?: string;
    }>(`/api/settings/adapters/${id}/test`, { method: "POST", body: "{}" }),
  overview: () => req<Overview>("/api/overview"),
  routerTrace: (id: string, signal?: AbortSignal) => req<RouterTrace>(`/api/router/runs/${encodeURIComponent(id)}`, { signal }),
  flow: (id: string) =>
    req<TaskFlow>(`/api/tasks/${encodeURIComponent(id)}/flow`),
  skill: (name: string) =>
    req<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`),
  messages: (source = "", offset = 0) =>
    req<{
      total: number;
      messages: InboundMessage[];
    }>(`/api/messages?source=${encodeURIComponent(source)}&offset=${offset}`),
  feishuStatus: () =>
    req<FeishuConnectionStatus>("/api/settings/adapters/feishu/status"),
  reconnectFeishu: () =>
    req<FeishuConnectionStatus>("/api/settings/adapters/feishu/reconnect", {
      method: "POST",
      body: "{}",
    }),
  createTask: (text: string) =>
    req("/api/tasks", { method: "POST", body: JSON.stringify({ text }) }),
  routerMessage: (text: string) =>
    req("/api/router/messages", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  message: (id: string, text: string, steer = false) =>
    req(`/api/tasks/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, steer }),
    }),
  stop: (id: string) =>
    req(`/api/tasks/${id}/stop`, { method: "POST", body: "{}" }),
  system: () => req<SystemInfo>("/api/system"),
};
// Polling also covers state changes without journal events and authenticated deployments.
export function subscribeEvents(
  onEvent: () => void,
  onState: (connected: boolean) => void,
): () => void {
  if (getToken()) return () => {};
  const es = new EventSource("/api/events");
  es.addEventListener("ready", () => {
    onState(true);
    onEvent();
  });
  es.addEventListener("journal", onEvent);
  es.addEventListener("tasks", onEvent);
  es.onerror = () => onState(false);
  return () => es.close();
}
