/** Schema migrations embedded as strings so dist needs no extra asset copy. */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_initial",
    sql: `
CREATE TABLE IF NOT EXISTS worker_definitions (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_name TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  mode INTEGER NOT NULL,
  PRIMARY KEY (skill_name, path)
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id TEXT,
  actor_id TEXT,
  payload_ref TEXT NOT NULL,
  preview TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  origin_trigger_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  thread_id TEXT NOT NULL,
  PRIMARY KEY (task_id, thread_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL UNIQUE,
  events_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_run
  ON runs(session_id)
  WHERE status IN ('pending', 'submitted');

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  trigger_id TEXT NOT NULL REFERENCES triggers(id),
  steer INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (target, trigger_id)
);

CREATE TABLE IF NOT EXISTS tool_actions (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  cmd TEXT NOT NULL,
  status TEXT NOT NULL,
  pgid INTEGER,
  proc_start_time TEXT,
  deadline_at TEXT,
  log_path TEXT,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_command_per_task
  ON operations(task_id)
  WHERE status IN ('pending', 'running', 'unknown');

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  external_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "002_journal",
    sql: `
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_scope_created
  ON journal(scope, created_at DESC);
`,
  },
  {
    version: 3,
    name: "003_channel_routes",
    sql: `CREATE TABLE IF NOT EXISTS channel_routes (
      channel TEXT NOT NULL, thread_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (json_valid(target)), updated_at TEXT NOT NULL,
      PRIMARY KEY (channel, thread_id)
    );`,
  },
  {
    version: 4,
    name: "004_worker_model",
    sql: `
UPDATE worker_definitions
SET spec = json_remove(
  json_set(spec, '$.model', coalesce(json_extract(spec, '$.model'), json_extract(spec, '$.modelProfile'))),
  '$.modelProfile'
)
WHERE json_type(spec, '$.modelProfile') IS NOT NULL;

UPDATE tasks
SET definition = json_remove(
  json_set(definition, '$.model', coalesce(json_extract(definition, '$.model'), json_extract(definition, '$.modelProfile'))),
  '$.modelProfile'
)
WHERE json_type(definition, '$.modelProfile') IS NOT NULL;
`,
  },
  {
    version: 5,
    name: "005_threads",
    sql: `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  owner_task_id TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS threads_owner
  ON threads(owner_task_id);

CREATE TABLE IF NOT EXISTS thread_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  trigger_id TEXT REFERENCES triggers(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);

CREATE INDEX IF NOT EXISTS thread_events_thread_seq
  ON thread_events(thread_id, seq);

-- Backfill Threads from routed triggers so existing data remains visible.
INSERT OR IGNORE INTO threads
  (id, source, external_key, status, owner_task_id, last_seq, created_at, updated_at)
SELECT thread_id, MIN(source), thread_id, 'active', NULL, 0,
       MIN(created_at), MAX(created_at)
FROM triggers
WHERE thread_id IS NOT NULL AND status = 'routed'
GROUP BY thread_id;

INSERT INTO thread_events
  (id, thread_id, seq, trigger_id, kind, summary, payload_ref, created_at)
SELECT 'tev_' || lower(hex(randomblob(16))),
       thread_id,
       ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at, id),
       id, 'trigger', substr(preview, 1, 240), payload_ref, created_at
FROM triggers
WHERE thread_id IS NOT NULL AND status = 'routed';

UPDATE threads
SET last_seq = (
  SELECT COALESCE(MAX(seq), 0)
  FROM thread_events
  WHERE thread_events.thread_id = threads.id
)
WHERE EXISTS (
  SELECT 1 FROM thread_events WHERE thread_events.thread_id = threads.id
);

-- A subscription may predate any routed trigger; keep the Thread addressable.
INSERT OR IGNORE INTO threads
  (id, source, external_key, status, owner_task_id, last_seq, created_at, updated_at)
SELECT s.thread_id, 'system', s.thread_id, 'active', NULL, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM subscriptions s
WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = s.thread_id);
`,
  },
  {
    version: 6,
    name: "006_subscription_roles",
    sql: `
ALTER TABLE subscriptions
  ADD COLUMN role TEXT NOT NULL DEFAULT 'observer';

ALTER TABLE subscriptions
  ADD COLUMN cursor_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE inbox
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'execute';

CREATE INDEX IF NOT EXISTS subscriptions_thread_role
  ON subscriptions(thread_id, role);

-- Legacy Threads keep one executor: the earliest Task on that Thread.
-- Additional subscriptions become observers unless later explicitly promoted.
UPDATE subscriptions AS s
SET role = 'executor'
WHERE s.rowid = (
  SELECT s2.rowid
  FROM subscriptions s2
  JOIN tasks t2 ON t2.id = s2.task_id
  WHERE s2.thread_id = s.thread_id
  ORDER BY t2.created_at, s2.task_id
  LIMIT 1
);

UPDATE threads
SET owner_task_id = (
  SELECT s.task_id
  FROM subscriptions s
  JOIN tasks t ON t.id = s.task_id
  WHERE s.thread_id = threads.id AND s.role = 'executor'
  ORDER BY CASE WHEN t.status IN ('pending', 'active', 'waiting') THEN 0 ELSE 1 END,
           t.created_at, s.task_id
  LIMIT 1
)
WHERE owner_task_id IS NULL
  AND EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.thread_id = threads.id AND s.role = 'executor'
  );
`,
  },
  {
    version: 7,
    name: "007_github_poll_cursors",
    sql: `CREATE TABLE github_poll_cursors (
      api_url TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (api_url, repo)
    );`,
  },
];
