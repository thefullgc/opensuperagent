import { t as tr, useLocale } from "../i18n";
import { useState, useEffect, type FormEvent } from "react";
import {
  CheckCircleIcon,
  FloppyDiskIcon,
  ShieldCheckIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { api, type RuntimeSettings, type FeishuConnectionStatus } from "../api";
import { Button } from "./ui/button";
import { SourceIcon } from "./shared";
import { sourceName, time } from "../lib/presentation";
type AdapterId = "github" | "feishu" | "webhook";
type Field = {
  id: string;
  label: string;
  secret?: boolean;
  list?: boolean;
  placeholder?: string;
  help?: string;
};
const fields: Record<AdapterId, Field[]> = {
  github: [
    {
      id: "apiBaseUrl",
      label: "GitHub API URL",
      placeholder: "https://api.github.com",
    },
    {
      id: "token",
      label: "GitHub Token",
      secret: true,
      help: "adapter.field.githubTokenHelp",
    },
    { id: "webhookSecret", label: "Webhook Secret", secret: true },
    {
      id: "repos",
      label: "adapter.field.githubRepos",
      list: true,
      placeholder: "owner/repo",
    },
    {
      id: "actors",
      label: "adapter.field.githubActors",
      list: true,
      placeholder: "adapter.field.githubActorsPlaceholder",
    },
    {
      id: "mention",
      label: "adapter.field.githubMention",
      placeholder: "@opensuperagent",
    },
    {
      id: "botLogin",
      label: "adapter.field.githubBotLogin",
      help: "adapter.field.githubBotLoginHelp",
    },
  ],
  feishu: [
    {
      id: "apiBaseUrl",
      label: "adapter.field.feishuApiUrl",
      placeholder: "https://open.feishu.cn/open-apis",
    },
    { id: "appId", label: "App ID" },
    { id: "appSecret", label: "App Secret", secret: true },
    { id: "verificationToken", label: "Verification Token", secret: true },
    {
      id: "encryptKey",
      label: "Encrypt Key",
      secret: true,
      help: "adapter.field.feishuEncryptHelp",
    },
    {
      id: "chats",
      label: "adapter.field.feishuChats",
      list: true,
      placeholder: "oc_...",
    },
    {
      id: "actors",
      label: "adapter.field.feishuActors",
      list: true,
      help: "adapter.field.feishuActorsHelp",
    },
    {
      id: "botOpenId",
      label: "adapter.field.feishuBotOpenId",
      help: "adapter.field.feishuBotOpenIdHelp",
    },
  ],
  webhook: [
    { id: "secret", label: "adapter.field.webhookSecret", secret: true },
    {
      id: "callbackUrl",
      label: "adapter.field.webhookCallback",
      placeholder: "https://your-service.example/agent/replies",
      help: "adapter.field.webhookCallbackHelp",
    },
    { id: "outboundSecret", label: "adapter.field.webhookOutbound", secret: true },
    {
      id: "actors",
      label: "adapter.field.webhookActors",
      list: true,
      help: "adapter.field.webhookActorsHelp",
    },
  ],
};
export function AdapterSettings({
  settings,
  onSaved,
}: {
  settings: RuntimeSettings;
  onSaved: (s: RuntimeSettings) => void;
}) {
  useLocale();
  const [selected, setSelected] = useState<AdapterId>("github");
  return (
    <section className="panel adapter-section">
      <div className="section-title">
        <div>
          <h2>{tr("adapter.title")}</h2>
          <span>{tr("adapter.meta")}</span>
        </div>
        <ShieldCheckIcon size={18} />
      </div>
      <div className="tab-bar">
        {(["github", "feishu", "webhook"] as const).map((id) => (
          <button
            key={id}
            className={selected === id ? "active" : ""}
            onClick={() => setSelected(id)}
          >
            <SourceIcon source={id} size={16} />
            {sourceName(id)}
            <span>
              {settings.adapters[id].enabled ? tr("common.enabled") : tr("common.disabled")}
            </span>
          </button>
        ))}
      </div>
      <AdapterEditor
        key={selected}
        id={selected}
        config={settings.adapters[selected]}
        onSaved={onSaved}
      />
    </section>
  );
}
function AdapterEditor({
  id,
  config,
  onSaved,
}: {
  id: AdapterId;
  config: Record<string, string | boolean | string[]>;
  onSaved: (s: RuntimeSettings) => void;
}) {
  useLocale();
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => ({
    enabled: !!config.enabled,
    ...(id === "webhook" ? {} : {
      receiveMode: String(config.receiveMode ?? (id === "github" ? "webhook" : "websocket")),
    }),
    ...Object.fromEntries(
      fields[id].map((f) => [
        f.id,
        f.secret
          ? ""
          : Array.isArray(config[f.id])
            ? (config[f.id] as string[]).join("\n")
            : String(config[f.id] ?? ""),
      ]),
    ),
  }));
  const [savedConfig, setSavedConfig] = useState(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const [chats, setChats] = useState<
    {
      id: string;
      name: string;
    }[]
  >([]);
  const [connection, setConnection] = useState<FeishuConnectionStatus | null>(
    null,
  );
  useEffect(() => {
    if (id !== "feishu") return;
    let active = true;
    const update = () => {
      void api
        .feishuStatus()
        .then((status) => {
          if (active) setConnection(status);
        })
        .catch(() => {});
    };
    update();
    const timer = setInterval(update, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, savedConfig]);
  const polling = id === "github" && draft.receiveMode === "polling";
  const websocket = id === "feishu" && draft.receiveMode !== "webhook";
  const connectionLabels: Record<string, string> = {
    disabled: tr("common.disabled"),
    webhook: tr("adapter.webhookMode"),
    idle: tr("adapter.notConnected"),
    connecting: tr("adapter.connecting"),
    connected: tr("adapter.connected"),
    reconnecting: tr("adapter.reconnecting"),
    failed: tr("adapter.connectFailed"),
  };
  async function reconnect() {
    setTesting(true);
    setError("");
    try {
      setConnection(await api.reconnectFeishu());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }
  async function testCredentials() {
    setTesting(true);
    setError("");
    setNotice("");
    setChats([]);
    try {
      const result = await api.testAdapter(id);
      setChats(result.chats ?? []);
      setNotice(
        tr("adapter.verifyOk", {
          v0: result.latencyMs,
          v1:
            result.chats?.length === 0 && !result.warning
              ? ` ${tr("adapter.noChats")}`
              : "",
          v2: result.warning ? ` · ${result.warning}` : "",
          v3: result.hasMore ? ` ${tr("adapter.chatsTruncated")}` : "",
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body: Record<string, unknown> = { ...draft };
      for (const f of fields[id])
        if (f.list)
          body[f.id] = String(draft[f.id])
            .split(/[\n,]/)
            .map((v) => v.trim())
            .filter(Boolean);
      const result = await api.saveAdapter(id, body);
      setSavedConfig(result.adapters[id]);
      setDraft((d) => ({
        ...d,
        ...Object.fromEntries(
          fields[id].filter((f) => f.secret).map((f) => [f.id, ""]),
        ),
      }));
      onSaved(result);
      setNotice(
        tr("adapter.configSaved", {
          v0: sourceName(id),
          v1: draft.enabled ? tr("adapter.andEnabled") : tr("adapter.andDisabled"),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const hookUrl = `${location.origin}/hooks/${id}`;
  return (
    <div className="adapter-editor">
      <div className="adapter-endpoint">
        {polling ? (
          <small>{tr("adapter.pollScope")}</small>
        ) : websocket ? (
          <>
            <span>{tr("adapter.feishuWs")}</span>
            <b role="status">
              {connection
                ? connectionLabels[connection.state]
                : tr("adapter.readingStatus")}
            </b>
            <small>
              {tr("adapter.wsNote")}{" "}
            </small>
            {connection && (
              <small>
                {tr("adapter.receivedPrefix")}{" "}
                {connection.receivedEvents}
                {" "}{tr("adapter.countEvents")}{" "}
                {connection.lastEventAt
                  ? ` ${tr("adapter.lastEvent", {
                      v0: time(connection.lastEventAt),
                    })}`
                  : ""}
                {connection.reconnectAttempts
                  ? ` ${tr("adapter.reconnectAttempts", {
                      v0: connection.reconnectAttempts,
                    })}`
                  : ""}
              </small>
            )}
            {connection?.lastError && (
              <small role="alert">{connection.lastError}</small>
            )}
          </>
        ) : (
          <>
            <span>{tr("adapter.callbackUrl")}</span>
            <code>{hookUrl}</code>
            <small>
              {tr("adapter.callbackNote")}{" "}
            </small>
          </>
        )}
      </div>
      <form className="settings-form" onSubmit={(e) => void save(e)}>
        <label className="enable-adapter">
          <input
            type="checkbox"
            aria-label={tr("adapter.enableAria", { v0: sourceName(id) })}
            checked={!!draft.enabled}
            onChange={(e) =>
              setDraft((d) => ({ ...d, enabled: e.target.checked }))
            }
          />
          <span>
            <b>
              {tr("common.enable")}{" "}
              {sourceName(id)}
              {" "}{tr("adapter.messaging")}
            </b>
            <small>{tr("adapter.saveNote")}</small>
          </span>
        </label>
        {(id === "github" || id === "feishu") && (
          <label>
            {tr("adapter.eventMode")}{" "}
            <select
              aria-label={id === "github" ? tr("adapter.eventMode") : tr("adapter.feishuEventMode")}
              value={String(draft.receiveMode)}
              onChange={(e) =>
                setDraft((d) => ({ ...d, receiveMode: e.target.value }))
              }
            >
              {id === "github" ? (
                <option value="polling">{tr("adapter.pollOption")}</option>
              ) : (
                <option value="websocket">{tr("adapter.wsOption")}</option>
              )}
              <option value="webhook">{tr("adapter.webhookOption")}</option>
            </select>
            <small>
              {id === "feishu"
                ? tr("adapter.modeNote")
                : polling ? tr("adapter.pollStartHint") : tr("adapter.githubDeliveryHint")}
            </small>
          </label>
        )}
        <div className="adapter-fields">
          {fields[id]
            .filter(field => !polling || field.id !== "webhookSecret")
            .filter(
              (field) =>
                !websocket ||
                !["verificationToken", "encryptKey"].includes(field.id),
            )
            .map((field) => (
              <label key={field.id}>
                {tr(field.label)}
                {field.secret && (
                  <span className="secret-state">
                    {savedConfig[`${field.id}Configured`]
                      ? tr("adapter.saved")
                      : tr("common.notConfigured")}
                  </span>
                )}
                {field.list ? (
                  <textarea
                    aria-label={`${id} ${tr(field.label)}`}
                    rows={3}
                    value={String(draft[field.id] ?? "")}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [field.id]: e.target.value }))
                    }
                    placeholder={
                      (field.placeholder ? tr(field.placeholder) : undefined) ??
                      tr("adapter.listPlaceholder")
                    }
                  />
                ) : (
                  <input
                    type={field.secret ? "password" : "text"}
                    aria-label={`${id} ${tr(field.label)}`}
                    value={String(draft[field.id] ?? "")}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [field.id]: e.target.value }))
                    }
                    autoComplete={field.secret ? "new-password" : "off"}
                    placeholder={
                      field.secret && savedConfig[`${field.id}Configured`]
                        ? tr("adapter.secretKeep")
                        : field.placeholder
                          ? tr(field.placeholder)
                          : undefined
                    }
                  />
                )}{" "}
                {field.help && <small>{tr(field.help)}</small>}
              </label>
            ))}
        </div>
        <div className="form-action-row">
          <Button type="submit" disabled={busy || testing}>
            <FloppyDiskIcon />
            {busy
              ? tr("common.saving")
              : tr("adapter.save", { v0: sourceName(id) })}
          </Button>
          {id !== "webhook" && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || testing}
              onClick={() => void testCredentials()}
            >
              <ShieldCheckIcon />
              {testing ? tr("adapter.verifying") : tr("adapter.verify")}
            </Button>
          )}
          {websocket &&
            connection?.enabled &&
            connection.mode === "websocket" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || testing}
                onClick={() => void reconnect()}
              >
                {tr("adapter.reconnect")}{" "}
              </Button>
            )}
        </div>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="save-notice">
            <CheckCircleIcon size={15} />
            {notice}
          </div>
        )}
        {chats.length > 0 && (
          <div className="adapter-protocol">
            <h3>{tr("adapter.botChats")}</h3>
            {chats.map((chat) => (
              <p key={chat.id}>
                {chat.name} <code>{chat.id}</code>
              </p>
            ))}
          </div>
        )}
      </form>
      <div className="adapter-protocol">
        <h3>{tr("adapter.protocol")}</h3>
        {id === "github" ? (
          <>
            <p>
              {polling ? tr("adapter.pollPermissions") : tr("adapter.githubNote")}{" "}
            </p>
            {!polling && <p>{tr("adapter.githubWebhook")}</p>}
            <a
              href={polling ? "https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository" : "https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries"}
              target="_blank"
              rel="noreferrer"
            >
              {tr("adapter.githubDocs")}{" "}
              <ArrowSquareOutIcon size={12} />
            </a>
          </>
        ) : id === "feishu" ? (
          <>
            <p>
              {tr("adapter.feishuSetup")}{" "}
              {websocket
                ? tr("adapter.feishuWsOption")
                : tr("adapter.feishuHookOption")}
              {tr("adapter.feishuSetupTail")}{" "}
            </p>
            <p>
              {websocket
                ? tr(
                    "adapter.wsProtocol",
                  )
                : tr(
                    "adapter.hookProtocol",
                  )}
              {tr("adapter.replyNote")}{" "}
            </p>
            <a
              href="https://open.feishu.cn/document/server-docs/im-v1/message/reply"
              target="_blank"
              rel="noreferrer"
            >
              {tr("adapter.feishuDocs")}{" "}
              <ArrowSquareOutIcon size={12} />
            </a>
          </>
        ) : (
          <>
            <p>
              {tr("adapter.inboundNote")}{" "}
            </p>
            <pre>
              {tr(
                "adapter.signatureExample",
              )}
            </pre>
            <p>
              {tr("adapter.outboundNote")}{" "}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
