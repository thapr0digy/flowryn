/**
 * Numbered, forward-only migrations. Each one runs in its own transaction
 * together with the meta.schema_version bump. Never edit a released migration;
 * add the next number instead.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Design section 13, verbatim apart from the append-only triggers on events. */
const INIT_SQL = /* sql */ `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY, ulid TEXT UNIQUE NOT NULL, ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT, task_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX events_run ON events(run_id, seq);
CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TABLE projects (
  id TEXT PRIMARY KEY, repo_url TEXT NOT NULL, path TEXT NOT NULL, default_branch TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('no-mistakes','direct-PR','local-only')),
  yolo INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 2,
  harness TEXT NOT NULL DEFAULT 'claude' CHECK (harness IN ('claude','pi')),
  workflow TEXT NOT NULL DEFAULT 'fix', autonomy TEXT NOT NULL DEFAULT 'plan');

CREATE TABLE task_policy (
  task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('ship','scout')),
  delivery_mode TEXT NOT NULL, yolo INTEGER NOT NULL, sensitive INTEGER NOT NULL DEFAULT 0,
  workflow TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0,
  reason TEXT, created_at INTEGER NOT NULL);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_policy(task_id),
  harness TEXT NOT NULL, harness_version TEXT NOT NULL, model TEXT, effort TEXT,
  state TEXT NOT NULL,
  liveness TEXT NOT NULL,
  workflow TEXT NOT NULL, stage TEXT NOT NULL,
  herdr_session TEXT, pane_id TEXT, agent_session TEXT,
  worktree_path TEXT NOT NULL, branch TEXT NOT NULL, base_sha TEXT NOT NULL,
  proc_pid INTEGER, proc_start INTEGER, proc_exe TEXT,
  token_hash TEXT NOT NULL, resume_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX one_open_run_per_task ON runs(task_id)
  WHERE state NOT IN ('cleaned','failed','cancelled');

CREATE TABLE run_evidence (
  run_id TEXT NOT NULL REFERENCES runs(id), source TEXT NOT NULL, rank INTEGER NOT NULL,
  value TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY (run_id, source));

CREATE TABLE divergences (
  id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, higher TEXT NOT NULL, lower TEXT NOT NULL,
  summary TEXT NOT NULL, opened_at INTEGER NOT NULL, resolved_at INTEGER, resolution TEXT);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, question TEXT NOT NULL,
  options TEXT NOT NULL, blocking INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered','dismissed')),
  answer TEXT, answered_via TEXT, answered_at INTEGER);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL REFERENCES events(seq),
  class TEXT NOT NULL CHECK (class IN ('actionable','info')),
  lane TEXT NOT NULL CHECK (lane IN ('P0','P1','P2')),
  kind TEXT NOT NULL, task_id TEXT, run_id TEXT, decision_id TEXT,
  line TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT, opened_at INTEGER NOT NULL, resolved_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_notified_at INTEGER);
CREATE INDEX items_open ON items(lane, state) WHERE state IN ('open','presented');

CREATE TABLE presentations (
  item_id TEXT NOT NULL REFERENCES items(id), session_id TEXT NOT NULL, turn_no INTEGER NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  carried_at INTEGER NOT NULL, confirmed_at INTEGER,
  PRIMARY KEY (item_id, session_id, turn_no));
CREATE UNIQUE INDEX one_p0_path ON presentations(item_id)
  WHERE state = 'carried' AND path IN ('continuation','waiter','trigger');

CREATE TABLE leader_sessions (
  session_id TEXT PRIMARY KEY, harness TEXT NOT NULL, pane_id TEXT, turn_no INTEGER NOT NULL DEFAULT 0,
  busy INTEGER NOT NULL DEFAULT 0, busy_until INTEGER, user_inactive_since INTEGER,
  waiter_id TEXT, triggered_turns_hour INTEGER NOT NULL DEFAULT 0, last_event_at INTEGER);

CREATE TABLE leader_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT, harness TEXT, pane_id TEXT,
  epoch INTEGER NOT NULL, token_hash TEXT, approval_key_hash TEXT,
  claimed_at INTEGER, heartbeat_at INTEGER);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL,
  created_at INTEGER NOT NULL, rings INTEGER NOT NULL DEFAULT 0, last_rung_at INTEGER,
  carried_at INTEGER, acked_at INTEGER);

CREATE TABLE approval_attempts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
  args_hash TEXT NOT NULL, permission_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL, matched_at INTEGER);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('claude-ask','pi-confirm','cli-tty','board','yolo')),
  actor TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'merge',
  allow_red_check TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER);

CREATE TABLE merges (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approvals(id), requested_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  merge_sha TEXT, proven_at INTEGER);

CREATE TABLE gates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), stage TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('review','merge')), review_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','passed','changes')),
  approval_id TEXT REFERENCES approvals(id), feedback TEXT,
  opened_at INTEGER NOT NULL, closed_at INTEGER);

CREATE TABLE pool_leases (
  pool TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), stage TEXT NOT NULL,
  granted_at INTEGER NOT NULL, released_at INTEGER,
  PRIMARY KEY (pool, run_id, stage));
CREATE INDEX pool_live ON pool_leases(pool) WHERE released_at IS NULL;

CREATE TABLE intents (
  id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, file TEXT NOT NULL,
  verb TEXT NOT NULL, args TEXT NOT NULL, task_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, applied_at INTEGER);

CREATE TABLE backlog_snapshot (file TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
  parsed TEXT NOT NULL, read_at INTEGER NOT NULL);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pr','report','file')), ref TEXT NOT NULL,
  head_sha TEXT, created_at INTEGER NOT NULL);
CREATE TABLE idempotency (ulid TEXT PRIMARY KEY, verb TEXT NOT NULL,
  reply TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE spool_ingested (ulid TEXT PRIMARY KEY, run_id TEXT, ingested_at INTEGER NOT NULL);
CREATE TABLE notifications (id TEXT PRIMARY KEY, item_ids TEXT NOT NULL,
  channel TEXT NOT NULL, sent_at INTEGER NOT NULL);
CREATE TABLE harness_contracts (harness TEXT NOT NULL, version TEXT NOT NULL,
  passed_at INTEGER NOT NULL, report_path TEXT, PRIMARY KEY (harness, version));
`;

/**
 * M2: what the runtime and the reconciler need on a run beyond section 13.
 * workspace_id is the Herdr workspace holding the run's pane; busy_until is
 * the busy lease hooks refresh (an interrupt fires no hook, so busy expires);
 * launched_at is the latest launch or resume, and worker_started_at the
 * worker-start report (none within 30 s of a launch is the trust wedge); transcript_path lets an interrupt be verified from
 * Claude's own transcript. messages gains the decision an answer steer closes.
 */
const RUNTIME_SQL = /* sql */ `
ALTER TABLE runs ADD COLUMN workspace_id TEXT;
ALTER TABLE runs ADD COLUMN busy_until INTEGER;
ALTER TABLE runs ADD COLUMN last_hook_at INTEGER;
ALTER TABLE runs ADD COLUMN idle_since INTEGER;
ALTER TABLE runs ADD COLUMN worker_started_at INTEGER;
ALTER TABLE runs ADD COLUMN launched_at INTEGER;
ALTER TABLE runs ADD COLUMN transcript_path TEXT;
ALTER TABLE messages ADD COLUMN decision_id TEXT;
CREATE INDEX runs_open ON runs(state) WHERE state NOT IN ('cleaned','failed','cancelled');
CREATE INDEX messages_open ON messages(run_id) WHERE acked_at IS NULL;
`;

/**
 * M3: leaders and attention. A leader session is one `flowryn lead` launch,
 * named by Flowryn (`L<n>`), so a Claude /clear or a Pi session switch inside
 * the same process stays the same leader. token_hash is the session's CLI and
 * hook credential; it carries the leader role only while the lease names this
 * session. harness_session is the harness's own session id, proc_* the
 * harness process (a holder is stale only once its process is gone),
 * continuations the Stop continuations since the last prompt, banner a
 * one-line notice for the next hook (leadership moved), has_ui whether a Pi
 * leader has its TUI (without one a P0 never starts a turn), brief_pending that
 * a session took the lease mid-conversation and gets the full briefing with its
 * next prompt. items.due orders overdue to-dos within their lane. A P0 handed
 * to a Pi extension is `offered` until the extension reports how it delivered
 * it; the per-item lease covers offers as well as carries.
 */
const LEADER_SQL = /* sql */ `
ALTER TABLE leader_sessions ADD COLUMN token_hash TEXT;
ALTER TABLE leader_sessions ADD COLUMN harness_session TEXT;
ALTER TABLE leader_sessions ADD COLUMN transcript_path TEXT;
ALTER TABLE leader_sessions ADD COLUMN cwd TEXT;
ALTER TABLE leader_sessions ADD COLUMN proc_pid INTEGER;
ALTER TABLE leader_sessions ADD COLUMN proc_start INTEGER;
ALTER TABLE leader_sessions ADD COLUMN proc_exe TEXT;
ALTER TABLE leader_sessions ADD COLUMN continuations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leader_sessions ADD COLUMN banner TEXT;
ALTER TABLE leader_sessions ADD COLUMN has_ui INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leader_sessions ADD COLUMN brief_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leader_sessions ADD COLUMN started_at INTEGER;
ALTER TABLE leader_sessions ADD COLUMN ended_at INTEGER;
CREATE UNIQUE INDEX leader_sessions_token ON leader_sessions(token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE items ADD COLUMN due TEXT;
CREATE INDEX presentations_session ON presentations(session_id, state);
CREATE UNIQUE INDEX one_p0_offer ON presentations(item_id)
  WHERE state IN ('carried','offered') AND path IN ('continuation','waiter','trigger');
`;

/**
 * M4: delivery and policy. artifacts gains the kind `local`, a local-only
 * ship's delivered branch head (SQLite cannot alter a CHECK, so the table is
 * rebuilt; nothing references it). approval_attempts records what the Claude
 * PreToolUse hook showed you: the task, the action and the PR and head the
 * prompt named, so the merge binds to what you saw. merges keeps the merge
 * method, the forge's answer and when the proof was last checked. runs gains
 * the cleanup outcome after landing (null, refused or done) and why.
 */
const DELIVERY_SQL = /* sql */ `
CREATE TABLE artifacts_m4 (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pr','report','file','local')), ref TEXT NOT NULL,
  head_sha TEXT, created_at INTEGER NOT NULL);
INSERT INTO artifacts_m4 (id, task_id, kind, ref, head_sha, created_at) SELECT id, task_id, kind, ref, head_sha, created_at FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_m4 RENAME TO artifacts;
CREATE INDEX artifacts_task ON artifacts(task_id, kind);
ALTER TABLE approval_attempts ADD COLUMN task_id TEXT;
ALTER TABLE approval_attempts ADD COLUMN action TEXT NOT NULL DEFAULT 'merge';
ALTER TABLE approval_attempts ADD COLUMN pr_url TEXT;
ALTER TABLE approval_attempts ADD COLUMN head_sha TEXT;
ALTER TABLE merges ADD COLUMN method TEXT;
ALTER TABLE merges ADD COLUMN detail TEXT;
ALTER TABLE merges ADD COLUMN checked_at INTEGER;
ALTER TABLE runs ADD COLUMN cleanup TEXT;
ALTER TABLE runs ADD COLUMN cleanup_detail TEXT;
CREATE INDEX approvals_open ON approvals(task_id) WHERE consumed_at IS NULL;
CREATE INDEX merges_open ON merges(state) WHERE state IN ('requested','unproven');
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: INIT_SQL },
  { version: 2, name: "runtime", sql: RUNTIME_SQL },
  { version: 3, name: "leader", sql: LEADER_SQL },
  { version: 4, name: "delivery", sql: DELIVERY_SQL },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
