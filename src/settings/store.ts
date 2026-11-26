import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { LlmConfig } from "../llm/types.js";

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        ["https:", "http:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  }, "Use an HTTP(S) URL without credentials, query or fragment")
  .transform((s) => s.replace(/\/+$/, ""));
const names = z.array(z.string().trim().min(1).max(200)).max(200);
export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  name: z.string().trim().min(1).max(100),
  protocol: z
    .enum(["openai-compatible", "anthropic"])
    .default("openai-compatible"),
  baseUrl: httpUrl,
  apiKey: z.string().max(4096).default(""),
  models: names.default([]),
  maxTokens: z.number().int().min(64).max(262144).default(8192),
});
export type Provider = z.infer<typeof ProviderSchema>;
const selection = z.object({
  providerId: z.string(),
  model: z.string().trim().min(1).max(200),
});
export const RoutingSchema = z.object({
  router: selection.nullable(),
  worker: selection.nullable(),
  profiles: z.record(z.string(), selection).default({}),
});
export type ModelRouting = z.infer<typeof RoutingSchema>;
const GithubSchema = z.object({
  receiveMode: z.enum(["webhook", "polling"]).default("webhook"),
  enabled: z.boolean().default(false),
  apiBaseUrl: httpUrl.default("https://api.github.com"),
  token: z.string().max(4096).default(""),
  webhookSecret: z.string().max(4096).default(""),
  repos: names.default([]),
  actors: names.default([]),
  botLogin: z.string().max(200).default(""),
  mention: z.string().min(1).max(100).default("@opensuperagent"),
});
const FeishuSchema = z.object({
  enabled: z.boolean().default(false),
  receiveMode: z.enum(["websocket", "webhook"]).default("websocket"),
  apiBaseUrl: httpUrl.default("https://open.feishu.cn/open-apis"),
  appId: z.string().max(200).default(""),
  appSecret: z.string().max(4096).default(""),
  verificationToken: z.string().max(4096).default(""),
  encryptKey: z.string().max(4096).default(""),
  chats: names.default([]),
  actors: names.default([]),
  botOpenId: z.string().max(200).default(""),
});
const WebhookSchema = z.object({
  enabled: z.boolean().default(false),
  secret: z.string().max(4096).default(""),
  callbackUrl: z.union([httpUrl, z.literal("")]).default(""),
  outboundSecret: z.string().max(4096).default(""),
  actors: names.default([]),
});
export const AdaptersSchema = z.object({
  github: GithubSchema.prefault({}),
  feishu: FeishuSchema.prefault({}),
  webhook: WebhookSchema.prefault({}),
});
export type AdaptersConfig = z.infer<typeof AdaptersSchema>;
const Schema = z.object({
  version: z.literal(1).default(1),
  revision: z.number().int().default(0),
  providers: z.array(ProviderSchema).default([]),
  routing: RoutingSchema.default({ router: null, worker: null, profiles: {} }),
  adapters: AdaptersSchema.prefault({}),
});
type Settings = z.infer<typeof Schema>;
const secretFields = {
  github: ["token", "webhookSecret"],
  feishu: ["appSecret", "verificationToken", "encryptKey"],
  webhook: ["secret", "outboundSecret"],
} as const;
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Secrets are never returned to the browser. Writes are synchronous, atomic and 0600. */
export class SettingsStore {
  private state: Settings;
  readonly file: string;
  constructor(dataRoot: string, legacy: LlmConfig | null = null) {
    this.file = join(dataRoot, "secrets", "runtime.json");
    this.state = existsSync(this.file)
      ? Schema.parse(JSON.parse(readFileSync(this.file, "utf8")))
      : Schema.parse({});
    if (!existsSync(this.file) && legacy) {
      const provider = ProviderSchema.parse({
        id: legacy.provider.replace(/[^a-zA-Z0-9_-]/g, "-") || "legacy",
        name: legacy.provider,
        protocol: legacy.protocol ?? "openai-compatible",
        baseUrl: legacy.baseUrl,
        apiKey: legacy.apiKey,
        models: [...new Set([legacy.routerModel, legacy.workerModel])],
        maxTokens: legacy.maxTokens,
      });
      this.state.providers = [provider];
      this.state.routing = {
        router: { providerId: provider.id, model: legacy.routerModel },
        worker: { providerId: provider.id, model: legacy.workerModel },
        profiles: {},
      };
    }
    if (existsSync(this.file)) chmodSync(this.file, 0o600);
  }
  get adapters(): AdaptersConfig {
    return structuredClone(this.state.adapters);
  }
  get routing(): ModelRouting {
    return structuredClone(this.state.routing);
  }
  get ready(): boolean {
    return !!this.state.routing.router && !!this.state.routing.worker;
  }
  snapshot() {
    const adapters = structuredClone(this.state.adapters) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    for (const [name, fields] of Object.entries(secretFields))
      for (const key of fields) {
        adapters[name]![`${key}Configured`] = !!adapters[name]![key];
        delete adapters[name]![key];
      }
    return {
      revision: this.state.revision,
      providers: this.state.providers.map(({ apiKey, ...provider }) => ({
        ...provider,
        apiKeyConfigured: !!apiKey,
      })),
      routing: this.routing,
      adapters,
    };
  }
  provider(id: string): Provider {
    const p = this.state.providers.find((p) => p.id === id);
    if (!p) throw new SettingsError("Provider not found", 404);
    return structuredClone(p);
  }
  saveProvider(input: unknown) {
    const incoming = ProviderSchema.parse(input);
    const existing = this.state.providers.find((p) => p.id === incoming.id);
    const provider = {
      ...incoming,
      apiKey: incoming.apiKey || existing?.apiKey || "",
    };
    const next = structuredClone(this.state);
    next.providers = [
      ...next.providers.filter((p) => p.id !== provider.id),
      provider,
    ];
    this.commit(next);
    return this.snapshot();
  }
  removeProvider(id: string) {
    if (
      [
        this.state.routing.router,
        this.state.routing.worker,
        ...Object.values(this.state.routing.profiles),
      ].some((s) => s?.providerId === id)
    )
      throw new SettingsError("Provider is in use by a model route", 409);
    const next = structuredClone(this.state);
    next.providers = next.providers.filter((p) => p.id !== id);
    this.commit(next);
    return this.snapshot();
  }
  saveRouting(input: unknown) {
    const routing = RoutingSchema.parse(input);
    if (!!routing.router !== !!routing.worker)
      throw new SettingsError(
        "Configure both Router and default Worker models",
      );
    for (const s of [
      routing.router,
      routing.worker,
      ...Object.values(routing.profiles),
    ])
      if (s) this.provider(s.providerId);
    this.commit({ ...structuredClone(this.state), routing });
    return this.snapshot();
  }
  saveAdapter(name: string, input: unknown) {
    if (!["github", "feishu", "webhook"].includes(name))
      throw new SettingsError("Unknown adapter", 404);
    const patch = input as Record<string, unknown>;
    const current = this.state.adapters[name as keyof AdaptersConfig];
    const merged = { ...current, ...patch } as Record<string, unknown>;
    for (const key of secretFields[name as keyof typeof secretFields])
      if (patch[key] === "" || patch[key] == null)
        merged[key] = (current as Record<string, unknown>)[key];
    const adapters = AdaptersSchema.parse({
      ...this.state.adapters,
      [name]: merged,
    });
    const g = adapters.github,
      f = adapters.feishu,
      w = adapters.webhook;
    if (
      f.enabled &&
      f.receiveMode === "websocket" &&
      !/^cli_[0-9a-fA-F]{16}$/.test(f.appId)
    )
      throw new SettingsError(
        "Feishu SDK long connections require a self-built App ID (cli_ followed by 16 hex characters)",
      );
    if (
      g.enabled &&
      g.receiveMode === "polling" &&
      g.repos.some(
        (repo) =>
          !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
          repo.split("/").some((part) => part === "." || part === ".."),
      )
    )
      throw new SettingsError("GitHub repositories must use owner/repo names");
    if (
      g.enabled &&
      (!g.token ||
        !g.repos.length ||
        !g.actors.length ||
        (g.receiveMode === "webhook" && !g.webhookSecret))
    )
      throw new SettingsError(
        "GitHub requires a token and repository and actor allowlists. Webhook mode also requires a signing secret.",
      );
    if (
      f.enabled &&
      (!f.appId ||
        !f.appSecret ||
        !f.chats.length ||
        (f.receiveMode === "webhook" && !f.verificationToken))
    )
      throw new SettingsError(
        "Feishu requires app credentials and allowed chat IDs; Webhook mode also requires a verification token",
      );
    if (w.enabled && (!w.secret || !w.callbackUrl || !w.outboundSecret))
      throw new SettingsError(
        "Webhook requires inbound secret, callback URL and outbound secret",
      );
    this.commit({ ...structuredClone(this.state), adapters });
    return this.snapshot();
  }
  resolve(owner: "router" | "worker", profile?: string): LlmConfig {
    const route =
      owner === "router"
        ? this.state.routing.router
        : (profile && this.state.routing.profiles[profile]) ||
          this.state.routing.worker;
    if (!route) throw new SettingsError(`No model configured for ${owner}`);
    const provider = this.provider(route.providerId);
    return {
      provider: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      routerModel: route.model,
      workerModel: route.model,
      maxTokens: provider.maxTokens,
    };
  }
  redact(message: string): string {
    let result = message;
    const secrets = [
      ...this.state.providers.map((p) => p.apiKey),
      ...Object.entries(secretFields).flatMap(([name, keys]) =>
        keys.map(
          (key) =>
            (
              this.state.adapters[name as keyof AdaptersConfig] as Record<
                string,
                unknown
              >
            )[key] as string,
        ),
      ),
    ];
    for (const secret of secrets
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[REDACTED]");
    return result;
  }
  private commit(next: Settings) {
    next.revision = this.state.revision + 1;
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(next, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    this.state = next;
  }
}
