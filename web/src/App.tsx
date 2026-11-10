import { t as tr, useLocale } from "./i18n";
import { LanguageSelector } from "./components/LanguageSelector";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { TasksPage } from "./pages/TasksPage";
import { TaskList } from "./components/TaskList";
import { shortId, time } from "./lib/presentation";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ActivityIcon,
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  ArrowsSplitIcon,
  BooksIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CommandIcon,
  CpuIcon,
  GearSixIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  PlugsConnectedIcon,
  RobotIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
  StackIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  api,
  ApiError,
  getToken,
  setToken,
  subscribeEvents,
  type Overview,
} from "./api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { DetailPanel, type Selection } from "./components/Details";
const SystemPage = lazy(() =>
  import("./pages/SystemPage").then((module) => ({
    default: module.SystemPage,
  })),
);
const RouterPage = lazy(() =>
  import("./pages/RouterPage").then((module) => ({ default: module.RouterPage })),
);
const FlowCanvas = lazy(() =>
  import("./components/FlowCanvas").then((module) => ({
    default: module.FlowCanvas,
  })),
);
import {
  EventFeed,
  PageHeading,
  SectionTitle,
  EmptyState,
  Status,
} from "./components/shared";
type Page =
  | "overview"
  | "tasks"
  | "router"
  | "workers"
  | "skills"
  | "connections"
  | "system";
const pages: {
  id: Page;
  label: string;
  icon: typeof ActivityIcon;
  group: string;
}[] = [
  {
    id: "overview",
    label: "nav.overview",
    icon: SquaresFourIcon,
    group: "nav.groupWorkspace",
  },
  {
    id: "tasks",
    label: "nav.tasks",
    icon: StackIcon,
    group: "nav.groupWorkspace",
  },
  {
    id: "router",
    label: "nav.router",
    icon: ArrowsSplitIcon,
    group: "nav.groupWorkspace",
  },
  {
    id: "workers",
    label: "nav.workers",
    icon: RobotIcon,
    group: "nav.groupCapabilities",
  },
  {
    id: "skills",
    label: "nav.skills",
    icon: BooksIcon,
    group: "nav.groupCapabilities",
  },
  {
    id: "connections",
    label: "nav.connections",
    icon: PlugsConnectedIcon,
    group: "nav.groupCapabilities",
  },
];
function initialPage(): Page {
  const hash = location.hash.slice(1);
  return [...pages.map((p) => p.id), "system"].includes(hash)
    ? (hash as Page)
    : "overview";
}
export default function App() {
  useLocale();
  const [page, setPage] = useState<Page>(initialPage);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [newRequest, setNewRequest] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [requestText, setRequestText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken);
  const [authVersion, setAuthVersion] = useState(0);
  const [toast, setToast] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fetching = useRef(false);
  const mounted = useRef(true);
  const notify = useCallback(
    (text: string, isError = false) => setToast({ text, error: isError }),
    [],
  );
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const result = await api.overview();
      if (mounted.current) {
        setData(result);
        setError("");
        if (getToken()) setConnected(true);
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e));
        setConnected(false);
        if (e instanceof ApiError && e.status === 401) setTokenOpen(true);
      }
    } finally {
      fetching.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(refresh);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeEvents(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => void refresh(), 250);
    }, setConnected);
    const interval = setInterval(() => void refresh(), 5000);
    return () => {
      mounted.current = false;
      unsubscribe();
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [refresh, authVersion]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    const onHash = () => {
      setPage(initialPage());
      setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  const navigate = useCallback((next: string) => {
    const valid = [...pages.map((p) => p.id), "system"].includes(next);
    if (valid) {
      location.hash = next;
      setPage(next as Page);
      setSidebarOpen(false);
    }
  }, []);
  const openWorker = useCallback(
    (id: string) => setSelection({ kind: "worker", id }),
    [],
  );
  const openSkill = useCallback(
    (id: string) => setSelection({ kind: "skill", id }),
    [],
  );
  const openTask = useCallback(
    (id: string) => setSelection({ kind: "task", id }),
    [],
  );
  async function submitRequest(e: FormEvent) {
    e.preventDefault();
    if (!requestText.trim() || busy) return;
    setBusy(true);
    try {
      await api.createTask(requestText.trim());
      setRequestText("");
      setNewRequest(false);
      notify(tr("shell.requestQueued"));
      await refresh();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  }
  const title = tr(pages.find((p) => p.id === page)?.label ?? "nav.system");
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {tr("shell.skipToContent")}{" "}
      </a>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label={tr("nav.close")}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        className={`sidebar ${sidebarOpen ? "open" : ""}`}
      >
        <a className="brand" href="#overview">
          <span className="brand-mark">
            <CommandIcon size={22} weight="bold" />
          </span>
          <span>
            <strong>OpenSuperAgent</strong>
            <small>{tr("nav.tagline")}</small>
          </span>
        </a>
        <nav aria-label={tr("nav.main")}>
          {["nav.groupWorkspace", "nav.groupCapabilities"].map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-group-label">{tr(group)}</div>
              {pages
                .filter((p) => p.group === group)
                .map((item) => (
                  <a
                    key={item.id}
                    className={`nav-item ${page === item.id ? "active" : ""}`}
                    href={`#${item.id}`}
                    aria-current={page === item.id ? "page" : undefined}
                  >
                    <item.icon size={19} />
                    <span>{tr(item.label)}</span>
                    {item.id === "tasks" && !!data?.stats.open && (
                      <b className="nav-count">{data.stats.open}</b>
                    )}
                    {item.id === "skills" && (
                      <span className="nav-number">
                        {data?.skills.length ?? 0}
                      </span>
                    )}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            href="#system"
            className={`nav-item ${page === "system" ? "active" : ""}`}
          >
            <GearSixIcon size={19} />
            {tr("nav.system")}{" "}
          </a>
          <div className="sidebar-user">
            <span className="user-avatar">T</span>
            <span>
              <b>{tr("nav.owner")}</b>
              <small>{tr("nav.localAdmin")}</small>
            </span>
            <ShieldCheckIcon size={17} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              aria-label={tr("nav.open")}
              aria-expanded={sidebarOpen}
              aria-controls="workspace-sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <ListIcon />
            </Button>
            <span>{tr("nav.groupWorkspace")}</span>
            <CaretRightIcon size={12} />
            <b>{title}</b>
          </div>
          <div className="topbar-actions">
            <LanguageSelector />
            <button
              className="search-trigger"
              onClick={() => setSearchOpen(true)}
            >
              <MagnifyingGlassIcon size={16} />
              <span>{tr("shell.searchPlaceholder")}</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className="topbar-divider" />
            <Button
              variant="ghost"
              size="icon"
              aria-label={tr("shell.refresh")}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh();
              }}
            >
              <ArrowClockwiseIcon className={refreshing ? "spin" : ""} />
            </Button>
            <span className="user-avatar small">T</span>
          </div>
        </header>
        <main id="main" className="main-content">
          {error && (
            <div className="error-banner" role="alert">
              <WarningCircleIcon />
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                {tr("shell.retry")}{" "}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTokenOpen(true)}
              >
                {tr("shell.tokenSet")}{" "}
              </Button>
            </div>
          )}
          {!data && !error && (
            <div className="page-loading">
              <CircleNotchIcon className="spin" size={26} />
              <p>{tr("shell.connectingWorkspace")}</p>
            </div>
          )}
          {data && (
            <>
              {page === "overview" && (
                <>
                  <PageHeading
                    eyebrow="WORKSPACE OVERVIEW"
                    title={tr("overview.title")}
                    description={tr(
                      "overview.description",
                    )}
                    action={
                      <Button
                        onClick={() => setNewRequest(true)}
                        className="primary-action"
                      >
                        <PlusIcon />
                        {tr("common.newGoal")}{" "}
                      </Button>
                    }
                  />
                  <div className="stats-strip">
                    <Stat
                      label={tr("overview.statOpen")}
                      value={data.stats.open}
                      detail={tr("overview.statOpenDetail", {
                        v0: data.stats.active,
                      })}
                      icon={StackIcon}
                    />
                    <Stat
                      label="Workers"
                      value={data.definitions.length}
                      detail={tr("overview.statWorkersDetail", {
                        v0: data.stats.capacity,
                      })}
                      icon={RobotIcon}
                    />
                    <Stat
                      label={tr("overview.statSkills")}
                      value={data.skills.length}
                      detail={tr("overview.statSkillsDetail")}
                      icon={BooksIcon}
                    />
                    <Stat
                      label={tr("overview.statRuns")}
                      value={data.stats.runs}
                      detail={tr("overview.statRunsDetail", {
                        v0: data.stats.completed,
                      })}
                      icon={ArrowClockwiseIcon}
                    />
                  </div>
                  <section className="flow-panel">
                    <SectionTitle
                      title={tr("overview.flowTitle")}
                      meta={
                        <>
                          <span className="live-label">
                            <i />
                            {tr("overview.liveStatus")}{" "}
                          </span>
                          <span className="dot-separator">·</span>
                          {tr("overview.flowHint")}{" "}
                        </>
                      }
                      action={
                        <span className="subtle-tag">
                          <ArrowsSplitIcon size={14} />
                          {tr("overview.flowTag")}{" "}
                        </span>
                      }
                    />
                    <Suspense
                      fallback={
                        <div className="flow-canvas loading-state">
                          {tr("overview.flowLoading")}{" "}
                        </div>
                      }
                    >
                      <FlowCanvas
                        data={data}
                        onNavigate={navigate}
                        onWorker={openWorker}
                      />
                    </Suspense>
                  </section>
                  <div className="overview-bottom">
                    <section className="panel recent-tasks">
                      <SectionTitle
                        title={tr("overview.recentTasks")}
                        meta={tr("overview.recentTasksMeta", { v0: data.tasks.length })}
                        action={
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate("tasks")}
                          >
                            {tr("common.allTasks")}{" "}
                            <ArrowRightIcon />
                          </Button>
                        }
                      />
                      <TaskList
                        tasks={data.tasks.slice(0, 5)}
                        onTask={openTask}
                        compact
                        onCreate={() => setNewRequest(true)}
                      />
                    </section>
                    <section className="panel recent-events">
                      <SectionTitle
                        title={tr("overview.liveFeed")}
                        meta={
                          <span className="live-label">
                            <i />
                            LIVE
                          </span>
                        }
                      />
                      <EventFeed
                        events={data.events}
                        onTask={openTask}
                        compact
                      />
                    </section>
                  </div>
                </>
              )}
              {page === "tasks" && (
                <TasksPage
                  data={data}
                  onTask={openTask}
                  onCreate={() => setNewRequest(true)}
                />
              )}
              {page === "router" && (
                <Suspense fallback={<div className="page-loading"><CircleNotchIcon className="spin" size={26} /></div>}>
                  <RouterPage
                    data={data}
                    onTask={openTask}
                    onWorker={openWorker}
                    refresh={refresh}
                    notify={notify}
                  />
                </Suspense>
              )}
              {page === "workers" && (
                <>
                  <PageHeading
                    eyebrow="WORKERS"
                    title={tr("workers.title")}
                    description={tr(
                      "workers.description",
                    )}
                    action={
                      <span className="subtle-tag">
                        <RobotIcon size={15} />
                        {data.definitions.length}
                        {" "}{tr("workers.countDefinitions")}{" "}
                      </span>
                    }
                  />
                  <div className="catalog-grid">
                    {data.definitions.map((d) => {
                      const tasks = data.tasks.filter(
                        (t) => t.definition.id === d.id,
                      );
                      return (
                        <button
                          className="worker-card"
                          key={d.id}
                          onClick={() => openWorker(d.id)}
                        >
                          <div className="worker-card-top">
                            <span className="object-icon teal">
                              <RobotIcon size={26} />
                            </span>
                            <ArrowUpRightIcon size={19} />
                          </div>
                          <h2>{d.id}</h2>
                          <p>{tr(d.description)}</p>
                          <div className="worker-model">
                            <CpuIcon size={15} />
                            <span>{d.model}</span>
                          </div>
                          <div className="worker-capabilities">
                            <span>
                              {d.tools.length}
                              {" "}{tr("workers.countTools")}
                            </span>
                            <span>
                              {d.skills.length}
                              {" "}{tr("workers.countSkillRefs")}
                            </span>
                          </div>
                          <div className="worker-skills">
                            {d.skills.map((s) => (
                              <span key={s}>{s}</span>
                            ))}
                          </div>
                          <div className="worker-card-footer">
                            <span>
                              <i className="state-dot running" />
                              {tr("common.enabled")}{" "}
                            </span>
                            <span>
                              {
                                tasks.filter((t) =>
                                  ["active", "waiting", "pending"].includes(
                                    t.status,
                                  ),
                                ).length
                              }{" "}
                              {tr("workers.tasksActive")}{" "}
                              {tasks.length}
                              {" "}{tr("common.count.tasks")}{" "}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {!data.definitions.length && (
                    <EmptyState title={tr("workers.empty")}>
                      {tr("workers.emptyHint")}{" "}
                    </EmptyState>
                  )}
                  <div className="architecture-note">
                    <ShieldCheckIcon size={22} />
                    <div>
                      <h3>{tr("workers.noteTitle")}</h3>
                      <p>
                        {tr("workers.noteBody")}{" "}
                      </p>
                    </div>
                  </div>
                </>
              )}
              {page === "skills" && (
                <SkillsPage
                  data={data}
                  onSkill={openSkill}
                  onWorker={openWorker}
                />
              )}
              {page === "connections" && (
                <ConnectionsPage
                  data={data}
                  onSelect={setSelection}
                  onTask={openTask}
                />
              )}
              {page === "system" && (
                <Suspense
                  fallback={
                    <div className="loading-state">{tr("shell.loading")}</div>
                  }
                >
                  <SystemPage
                    data={data}
                    openToken={() => setTokenOpen(true)}
                  />
                </Suspense>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              OpenSuperAgent <span> / </span>
              {" "}{tr("shell.footerTagline")}{" "}
            </span>
            <span>
              <span
                className={`state-dot ${!error && connected ? "running" : ""}`}
              />
              {data
                ? tr("shell.updatedAt", { v0: time(data.generatedAt) })
                : tr("shell.waitingRuntime")}
            </span>
          </footer>
        </main>
      </div>
      {data && selection && (
        <DetailPanel
          key={`${selection.kind}:${selection.id}`}
          selection={selection}
          onClose={() => setSelection(null)}
          data={data}
          onSelect={setSelection}
          onRefresh={() => void refresh()}
          notify={notify}
        />
      )}
      <Dialog open={newRequest} onOpenChange={setNewRequest}>
        <DialogContent className="request-dialog">
          <DialogHeader>
            <div className="object-icon orange">
              <PlusIcon size={24} />
            </div>
            <DialogTitle>{tr("shell.requestTitle")}</DialogTitle>
            <DialogDescription>
              {tr("shell.requestDescription")}{" "}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submitRequest(e)}>
            <textarea
              autoFocus
              aria-label={tr("shell.requestGoal")}
              placeholder={tr(
                "shell.requestPlaceholder",
              )}
              value={requestText}
              onChange={(e) => setRequestText(e.target.value)}
              required
            />
            <div className="request-route">
              <span>
                <TerminalWindowIcon size={16} />
                Console
              </span>
              <ArrowRightIcon size={14} />
              <span>
                <ArrowsSplitIcon size={16} />
                Router
              </span>
              <ArrowRightIcon size={14} />
              <span>
                <RobotIcon size={16} />
                Worker
              </span>
            </div>
            <div className="dialog-actions">
              <Button
                variant="outline"
                type="button"
                onClick={() => setNewRequest(false)}
              >
                {tr("shell.cancel")}{" "}
              </Button>
              <Button disabled={busy || !requestText.trim()} type="submit">
                {busy ? (
                  <CircleNotchIcon className="spin" />
                ) : (
                  <PaperPlaneTiltIcon />
                )}
                {tr("shell.requestSubmit")}{" "}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="search-dialog">
          <DialogHeader>
            <DialogTitle>{tr("shell.searchTitle")}</DialogTitle>
            <DialogDescription>
              {tr("shell.searchDescription")}{" "}
            </DialogDescription>
          </DialogHeader>
          <div className="search-input">
            <MagnifyingGlassIcon />
            <input
              autoFocus
              placeholder={tr("shell.searchInputPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={tr("shell.searchTitle")}
            />
          </div>
          <div className="search-results">
            {data && (
              <>
                {data.tasks
                  .filter((t) =>
                    `${t.id} ${t.objective}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .slice(0, 8)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        openTask(t.id);
                        setSearchOpen(false);
                      }}
                    >
                      <StackIcon />
                      <span>
                        <b>{t.objective}</b>
                        <small>
                          {tr("shell.taskPrefix")}
                          {shortId(t.id)}
                        </small>
                      </span>
                      <Status status={t.status} />
                    </button>
                  ))}
                {data.definitions
                  .filter((d) =>
                    `${d.id} ${tr(d.description)}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((d) => (
                    <button
                      key={d.id}
                      onClick={() => {
                        openWorker(d.id);
                        setSearchOpen(false);
                      }}
                    >
                      <RobotIcon />
                      <span>
                        <b>{d.id}</b>
                        <small>{tr("common.workerDefinition")}</small>
                      </span>
                      <ArrowUpRightIcon />
                    </button>
                  ))}
                {data.skills
                  .filter((s) =>
                    `${s.name} ${s.description}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((s) => (
                    <button
                      key={s.name}
                      onClick={() => {
                        openSkill(s.name);
                        setSearchOpen(false);
                      }}
                    >
                      <BooksIcon />
                      <span>
                        <b>{s.name}</b>
                        <small>Skill</small>
                      </span>
                      <ArrowUpRightIcon />
                    </button>
                  ))}
              </>
            )}
            <p className="search-hint">
              {query ? tr("shell.searchEnd") : tr("shell.searchNarrow")}
              {" "}{tr("shell.searchEsc")}{" "}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={tokenOpen} onOpenChange={setTokenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("shell.tokenTitle")}</DialogTitle>
            <DialogDescription>
              {tr("shell.tokenDescription")}{" "}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setToken(tokenInput.trim());
              setTokenOpen(false);
              setAuthVersion((v) => v + 1);
            }}
          >
            <label className="field-label" htmlFor="admin-token">
              Admin Token
            </label>
            <input
              className="text-input"
              id="admin-token"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="off"
            />
            <div className="dialog-actions">
              <Button type="submit">{tr("shell.tokenSubmit")}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <WarningCircleIcon /> : <CheckCircleIcon />}
          <span>{toast.text}</span>
          <button aria-label={tr("shell.closeToast")} onClick={() => setToast(null)}>
            <XIcon />
          </button>
        </div>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: number;
  detail: string;
  icon: typeof ActivityIcon;
}) {
  useLocale();
  return (
    <div className="stat">
      <div>
        <span>{tr(label)}</span>
        <Icon size={18} />
      </div>
      <strong>{value.toString().padStart(2, "0")}</strong>
      <p>{detail}</p>
    </div>
  );
}
