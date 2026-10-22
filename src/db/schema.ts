/**
 * Numbered, forward-only migrations. Each one runs in its own transaction
 * together with the meta.schema_version bump and, from migration 29, its row
 * in schema_migrations. Never edit a released migration; add the next number
 * instead. Two branches that both add the same number collide: migrate()
 * refuses a database whose recorded name for a number differs from this
 * binary's, and a unit test requires the numbers to run 1..N with unique names.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * The migration rebuilds a table other tables reference (SQLite cannot alter a CHECK): it runs
   * with foreign keys off, SQLite's documented table-rebuild procedure, and must leave
   * `PRAGMA foreign_key_check` clean before it commits.
   */
  rebuildsReferencedTable?: boolean;
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

/**
 * M5: workflows, capacity and autonomy (design section 11). A run's stage
 * gains its state: waiting (for a capacity grant), active, review (a review
 * gate is open) or done (the last stage delivered); waiting_since orders the
 * queue and times its alert; pending_launch is the launch a grant must start
 * (fresh, resume or a fresh stage worker); stage_note is the steer the stage
 * start carries. pool_leases is rebuilt with its own id, so a stage granted
 * again after a release (changes requested, a declined delivery) gets a new
 * row; one live lease per pool and run. Every open run already has a live
 * worker, so each gets its worker lease. plans and plan_phases hold a phased
 * feature (design section 11): the phases reach the backlog only once the plan
 * is approved. runs.workflow_def freezes the workflow a run already open
 * before M5 finishes under, the contract its worker was given: a ship builds
 * then ships (the ship stage holds a validation slot and ends at the merge
 * gate) and a scout investigates, whatever its workflow id names today. Both
 * are marked legacy_m4: such a ship's slot is granted at delivery time.
 */
/** The workflow migration 5 freezes for a ship already open before M5 (marked legacy_m4). */
export const M4_SHIP_WORKFLOW = JSON.stringify({
  id: "fix",
  stages: [
    { id: "build", skill: null, gate: "none", pools: [], fresh: false },
    { id: "ship", skill: null, gate: "merge", pools: ["validation"], fresh: false },
  ],
  legacy_m4: true,
});

/** The workflow migration 5 freezes for a scout already open before M5. */
const M4_SCOUT_WORKFLOW = JSON.stringify({ id: "scout", stages: [{ id: "investigate", skill: null, gate: "none", pools: [], fresh: false }], legacy_m4: true });

const WORKFLOW_SQL = /* sql */ `
ALTER TABLE runs ADD COLUMN workflow_def TEXT;
UPDATE runs SET workflow_def = CASE
    WHEN (SELECT kind FROM task_policy tp WHERE tp.task_id = runs.task_id) = 'scout'
      THEN '${M4_SCOUT_WORKFLOW}'
    ELSE '${M4_SHIP_WORKFLOW}'
  END
  WHERE state NOT IN ('cleaned','failed','cancelled');
ALTER TABLE runs ADD COLUMN stage_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE runs ADD COLUMN stage_started_at INTEGER;
ALTER TABLE runs ADD COLUMN waiting_since INTEGER;
ALTER TABLE runs ADD COLUMN pending_launch TEXT;
ALTER TABLE runs ADD COLUMN stage_note TEXT;
CREATE TABLE pool_leases_m5 (
  id INTEGER PRIMARY KEY, pool TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), stage TEXT NOT NULL,
  granted_at INTEGER NOT NULL, released_at INTEGER, released_by TEXT);
INSERT INTO pool_leases_m5 (pool, run_id, stage, granted_at, released_at) SELECT pool, run_id, stage, granted_at, released_at FROM pool_leases;
DROP TABLE pool_leases;
ALTER TABLE pool_leases_m5 RENAME TO pool_leases;
CREATE UNIQUE INDEX pool_one_live ON pool_leases(pool, run_id) WHERE released_at IS NULL;
CREATE INDEX pool_live ON pool_leases(pool) WHERE released_at IS NULL;
INSERT INTO pool_leases (pool, run_id, stage, granted_at)
  SELECT 'worker', id, stage, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM runs WHERE state NOT IN ('cleaned','failed','cancelled');
CREATE INDEX runs_waiting ON runs(waiting_since) WHERE stage_state = 'waiting' OR pending_launch IS NOT NULL;
CREATE INDEX gates_open ON gates(run_id) WHERE state = 'open';
CREATE TABLE plans (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','discarded')),
  source_task TEXT, gate_id TEXT, filed_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT);
CREATE TABLE plan_phases (
  plan_id TEXT NOT NULL REFERENCES plans(id), phase_no INTEGER NOT NULL, task_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, body TEXT NOT NULL, workflow TEXT NOT NULL, harness TEXT, blocked_by TEXT NOT NULL,
  PRIMARY KEY (plan_id, phase_no));
`;

/**
 * Cutover C1: decisions stand on their own (docs/cutover-notes.md). A
 * standalone decision (k<N>) owns a backlog task of kind decision, held for
 * the user; run-scoped questions (q<N>) keep their run. origin and key name
 * where it came from (unique together), context and recommendation what the
 * source said, reserved_reason why only the user may answer (null: the
 * leader may), defer_until a date before which the briefing leaves it out,
 * answered_by who decided (answered_via keeps the channel) and rationale the
 * leader's reason or the user's words verbatim. run_id was already nullable.
 */
const DECISIONS_SQL = /* sql */ `
ALTER TABLE decisions ADD COLUMN origin TEXT;
ALTER TABLE decisions ADD COLUMN key TEXT;
ALTER TABLE decisions ADD COLUMN context TEXT;
ALTER TABLE decisions ADD COLUMN recommendation TEXT;
ALTER TABLE decisions ADD COLUMN reserved_reason TEXT;
ALTER TABLE decisions ADD COLUMN defer_until TEXT;
ALTER TABLE decisions ADD COLUMN answered_by TEXT;
ALTER TABLE decisions ADD COLUMN rationale TEXT;
ALTER TABLE decisions ADD COLUMN created_at INTEGER;
CREATE UNIQUE INDEX decisions_origin_key ON decisions(origin, key) WHERE origin IS NOT NULL AND key IS NOT NULL;
CREATE INDEX decisions_open ON decisions(state) WHERE state = 'open';
`;

/**
 * Cutover C3: what an import created carries its source (<prefix>:<id>), so a
 * second import changes nothing; a dispatch may override its project's
 * delivery mode for one task, with the reason kept beside it.
 */
const IMPORT_SQL = /* sql */ `
ALTER TABLE projects ADD COLUMN import_source TEXT;
ALTER TABLE task_policy ADD COLUMN import_source TEXT;
ALTER TABLE task_policy ADD COLUMN mode_reason TEXT;
ALTER TABLE decisions ADD COLUMN import_source TEXT;
CREATE UNIQUE INDEX projects_import ON projects(import_source) WHERE import_source IS NOT NULL;
CREATE UNIQUE INDEX decisions_import ON decisions(import_source) WHERE import_source IS NOT NULL;
`;

/**
 * Steer latency: when a carried steer was provably in a model request
 * (seen_at, the first time), and the latest ring's state: carried, seen or
 * lost (a known-lost carry rings again at once). ring_idle marks a carry to an
 * idle worker, which must be seen within seconds or it rings again. seen_via
 * names what marked the latest ring seen (a Claude hook, Pi's context event).
 */
const STEER_SEEN_SQL = /* sql */ `
ALTER TABLE messages ADD COLUMN seen_at INTEGER;
ALTER TABLE messages ADD COLUMN ring_state TEXT;
ALTER TABLE messages ADD COLUMN ring_idle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN seen_via TEXT;
UPDATE messages SET ring_state = 'carried' WHERE rings > 0;
`;

/**
 * The cutover import is retired: every source it recorded, whatever the old
 * orchestrator's prefix, becomes legacy:<id>. Only that import ever wrote the
 * column, so "not yet legacy" is exactly its rows. The swap is one-to-one, so
 * the unique import indexes still hold.
 */
const LEGACY_SOURCE_SQL = /* sql */ `
UPDATE projects SET import_source = 'legacy:' || substr(import_source, instr(import_source, ':') + 1)
  WHERE import_source IS NOT NULL AND import_source NOT LIKE 'legacy:%';
UPDATE task_policy SET import_source = 'legacy:' || substr(import_source, instr(import_source, ':') + 1)
  WHERE import_source IS NOT NULL AND import_source NOT LIKE 'legacy:%';
UPDATE decisions SET import_source = 'legacy:' || substr(import_source, instr(import_source, ':') + 1)
  WHERE import_source IS NOT NULL AND import_source NOT LIKE 'legacy:%';
`;

/**
 * Urgent steers (steer latency Tier 2): an urgent steer blocks the worker's
 * next tool call and cancels a tool that has run past steer_preempt_after_ms;
 * preempted_at is when Flowryn cancelled a tool for it (at most once).
 */
const STEER_URGENT_SQL = /* sql */ `
ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN preempted_at INTEGER;
`;

/**
 * Gate questions: a review gate may carry the worker's questions for the user
 * (`stage done --questions-file`), each a run-scoped decision bound to the
 * gate (gate_id) with its kind (single, multi or text; NULL is a plain
 * single choice), the choice it blocks and the worker's why (note). The gate
 * keeps the page Flowryn writes the question widget beside (page_path), the
 * worker's own decisions (decided, JSON), whether the user ended the Lavish
 * session (lavish_ended) and where the Lavish notes the poll took went
 * (notes_path). A worker's `ask` records what it blocks too.
 */
const GATE_QUESTIONS_SQL = /* sql */ `
ALTER TABLE decisions ADD COLUMN kind TEXT;
ALTER TABLE decisions ADD COLUMN gate_id TEXT;
ALTER TABLE decisions ADD COLUMN note TEXT;
ALTER TABLE decisions ADD COLUMN blocks TEXT;
CREATE INDEX decisions_gate ON decisions(gate_id) WHERE gate_id IS NOT NULL;
ALTER TABLE gates ADD COLUMN page_path TEXT;
ALTER TABLE gates ADD COLUMN decided TEXT;
ALTER TABLE gates ADD COLUMN lavish_ended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gates ADD COLUMN notes_path TEXT;
`;

/**
 * Gate comment: what the user wrote in the review page's "anything else for
 * the worker" box, verbatim, each Send appended (the verdict steer carries it).
 */
const GATE_COMMENT_SQL = /* sql */ `
ALTER TABLE gates ADD COLUMN comment TEXT;
`;

/**
 * A Claude prompt can carry a red-check waiver: the attempt names the one
 * check the prompt showed, and only a merge naming that same check matches it.
 */
const ATTEMPT_WAIVER_SQL = /* sql */ `
ALTER TABLE approval_attempts ADD COLUMN allow_red_check TEXT;
`;

/**
 * A steer the leader sent with --end-turn tells the worker to end its turn
 * (to wait, or because it only informs): the turn-end guard stands aside for
 * that episode.
 */
const STEER_END_TURN_SQL = /* sql */ `
ALTER TABLE messages ADD COLUMN end_turn INTEGER NOT NULL DEFAULT 0;
`;

/**
 * An item's line is cut to one digest line (200 characters); full_line keeps
 * the whole sanitized line when it was cut, for `flowryn show <item> --full`.
 */
const ITEM_FULL_LINE_SQL = /* sql */ `
ALTER TABLE items ADD COLUMN full_line TEXT;
`;

/**
 * `flowryn verify`: one row per local run of a project's verify steps at a
 * PR head, in a clean worktree. A project with verify steps merges only on a
 * passing one at the merge head (src/policy/merge.ts).
 */
const VERIFICATIONS_SQL = /* sql */ `
CREATE TABLE verifications (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pr_url TEXT NOT NULL, task_id TEXT,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','passed','failed','error')),
  steps TEXT NOT NULL, tests TEXT, detail TEXT, binary_path TEXT,
  dir TEXT NOT NULL, worktree_path TEXT NOT NULL, project_path TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX verifications_pr ON verifications(pr_url, started_at);
`;

/**
 * Chat-answer grants (docs/notes/2026-10-10-chat-answers-authorise-5g.md): a leader
 * AskUserQuestion answer authorises the one action it names. chat_questions holds each binding
 * question the Claude leader's PreToolUse hook let through (one row per tool use, so a replayed or
 * forged hook call for a tool use id already seen records nothing); captain_grants the grant each
 * answer made, single use and short-lived. approvals is rebuilt for the new channel claude-chat
 * (merges and gates reference it, so foreign keys are off while it is swapped).
 */
const CHAT_GRANTS_SQL = /* sql */ `
CREATE TABLE approvals_v17 (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('claude-ask','claude-chat','pi-confirm','cli-tty','board','yolo')),
  actor TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'merge',
  allow_red_check TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER);
INSERT INTO approvals_v17 (id, task_id, pr_url, head_sha, channel, actor, action, allow_red_check, created_at, expires_at, consumed_at)
  SELECT id, task_id, pr_url, head_sha, channel, actor, action, allow_red_check, created_at, expires_at, consumed_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_v17 RENAME TO approvals;
CREATE INDEX approvals_open ON approvals(task_id) WHERE consumed_at IS NULL;
CREATE TABLE chat_questions (
  tool_use_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  refs TEXT NOT NULL, created_at INTEGER NOT NULL, answered_at INTEGER);
CREATE TABLE captain_grants (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
  item TEXT NOT NULL, action TEXT NOT NULL, task_id TEXT, choice TEXT NOT NULL,
  words TEXT, question TEXT NOT NULL, answer TEXT NOT NULL, binds TEXT, transcript_path TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, verified_at INTEGER,
  consumed_at INTEGER, consumed_by TEXT, voided_at INTEGER, void_reason TEXT,
  UNIQUE (tool_use_id, item));
CREATE INDEX captain_grants_live ON captain_grants(session_id, item) WHERE consumed_at IS NULL AND voided_at IS NULL;
CREATE INDEX captain_grants_task ON captain_grants(task_id);
`;

/**
 * Review pages open in your browser (docs/notes/2026-10-10-review-pages-open-4b.md): a review
 * gate's open_state (pending, opening once claimed, then opened or failed; off when the setting or
 * the environment turns it off; skipped when the page was already opened for the run, or the gate
 * was open before this), what happened (open_detail) and when (open_at). A gate open at upgrade
 * is skipped: no burst of tabs for pages you may already have open.
 */
const GATE_BROWSER_OPEN_SQL = /* sql */ `
ALTER TABLE gates ADD COLUMN open_state TEXT CHECK (open_state IN ('pending','opening','opened','failed','off','skipped'));
ALTER TABLE gates ADD COLUMN open_detail TEXT;
ALTER TABLE gates ADD COLUMN open_at INTEGER;
UPDATE gates SET open_state = 'skipped', open_detail = 'open before Flowryn opened review pages' WHERE kind = 'review' AND state = 'open';
`;

/**
 * Leader repin (docs/notes/2026-10-11-flowryn-leader-repin-xv.md): when you last moved the
 * session's pinned directory from your terminal; every chat-answer grant, question and answer
 * from before it is refused.
 */
const LEADER_REPIN_SQL = /* sql */ `
ALTER TABLE leader_sessions ADD COLUMN pinned_at INTEGER;
`;

/**
 * Review-channel health (docs/notes/2026-10-12-next-steps-md-7b.md): whether the daemon's Lavish
 * poll of a gate's page delivers. When it last turned healthy, since when it fails, how many polls
 * in a row, why, when it tries again, and the review_channel item the failing episode opened.
 * Gates from before carry nothing: an upgrade says nothing about a channel it never watched.
 */
const GATE_CHANNEL_SQL = /* sql */ `
ALTER TABLE gates ADD COLUMN channel_ok_at INTEGER;
ALTER TABLE gates ADD COLUMN channel_failing_since INTEGER;
ALTER TABLE gates ADD COLUMN channel_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gates ADD COLUMN channel_reason TEXT;
ALTER TABLE gates ADD COLUMN channel_retry_at INTEGER;
ALTER TABLE gates ADD COLUMN channel_item TEXT;
`;

/**
 * Job leases (docs/notes/2026-10-12-next-steps-md-64.md): a capacity slot held by
 * heavy work that is not a run (a `flowryn verify`), counted with pool_leases
 * against the same caps, so no run is fabricated for it. One live row per pool
 * and job; proc_* is the identity of the job's running step (its process group
 * leader), so a daemon that restarts can end it before it frees the slot.
 * A verification running at upgrade has no lease: startup recovery handles it as before.
 */
const JOB_LEASES_SQL = /* sql */ `
CREATE TABLE job_leases (
  id INTEGER PRIMARY KEY, pool TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('verify')), job_id TEXT NOT NULL,
  task_id TEXT, granted_at INTEGER NOT NULL, released_at INTEGER, released_by TEXT,
  proc_pid INTEGER, proc_start INTEGER, proc_exe TEXT);
CREATE UNIQUE INDEX job_one_live ON job_leases(pool, kind, job_id) WHERE released_at IS NULL;
CREATE INDEX job_live ON job_leases(pool) WHERE released_at IS NULL;
`;

/**
 * Wait explanations (docs/notes/2026-10-12-next-steps-md-wz.md): one row per decision that holds,
 * refuses or resumes a run (a dialog, a capacity refusal, a resume), with the rule, its reason, the
 * facts it decided on and when each was observed, and who or what can end the wait. Written only
 * when the explanation changes; open while the wait lasts. `operation` names the launch, resume or
 * cancel the explanation belongs to (migration 25), when it belongs to one. Databases from before start empty.
 */
const EXPLANATIONS_SQL = /* sql */ `
CREATE TABLE explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, task_id TEXT NOT NULL, stage TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dialog','capacity','resume')),
  rule TEXT NOT NULL, reason TEXT NOT NULL, facts TEXT NOT NULL, unblock TEXT NOT NULL,
  signature TEXT NOT NULL, item_id TEXT, operation TEXT, event_seq INTEGER NOT NULL,
  opened_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT);
CREATE INDEX explanations_open ON explanations(run_id) WHERE closed_at IS NULL;
CREATE INDEX explanations_task ON explanations(task_id, id);
`;

/**
 * Contract revision (docs/notes/2026-10-12-next-steps-md-ez.md): a pass is identified by harness,
 * version and the adapter/contract compatibility revision it proved, with the platform, Herdr version
 * and launch profile it ran on. Passes recorded before this carry over as revision 1, the baseline:
 * revision 1 is defined as the adapter behaviour when revisions were introduced, which is what they
 * proved (this migration's change proves no new behaviour), so an upgrade refuses nothing. Only a
 * later bump of CONTRACT_REVISIONS makes them stale.
 */
const CONTRACT_REVISION_SQL = /* sql */ `
CREATE TABLE harness_contracts_v23 (harness TEXT NOT NULL, version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  passed_at INTEGER NOT NULL, report_path TEXT,
  platform TEXT, herdr_version TEXT, launch_profile TEXT,
  PRIMARY KEY (harness, version, revision));
INSERT INTO harness_contracts_v23 (harness, version, revision, passed_at, report_path)
  SELECT harness, version, 1, passed_at, report_path FROM harness_contracts;
DROP TABLE harness_contracts;
ALTER TABLE harness_contracts_v23 RENAME TO harness_contracts;
`;

/** Each verification's verify policy identity (docs/notes/2026-10-13-next-steps-md-y4.md); NULL on a row from before it. */
const VERIFY_POLICY_SQL = /* sql */ `
ALTER TABLE verifications ADD COLUMN policy_id TEXT;
`;

/**
 * Lifecycle operations (docs/notes/2026-10-13-next-steps-md-rz.md): one row per launch, resume or
 * cancel Flowryn was asked for, with the phase it reached (requested, effect_issued, then confirmed,
 * failed or escalated), the candidate committed before Herdr's agent.start (pane, agent name, when)
 * and the worker identity it confirmed. At most one open (requested or effect_issued) row per run.
 * Databases from before start empty; recovery reads a run left mid-launch from its own row.
 */
const OPERATIONS_SQL = /* sql */ `
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('launch','resume','cancel')),
  mode TEXT CHECK (mode IN ('fresh','resume','stage','relaunch')),
  generation INTEGER NOT NULL,
  desired TEXT NOT NULL CHECK (desired IN ('worker_running','run_cancelled')),
  phase TEXT NOT NULL CHECK (phase IN ('requested','effect_issued','confirmed','failed','escalated')),
  requested_by TEXT NOT NULL, reason TEXT,
  pane_id TEXT, agent_name TEXT, issued_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  proc_pid INTEGER, proc_start INTEGER, detail TEXT, item_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER);
CREATE UNIQUE INDEX operations_one_open ON operations(run_id) WHERE phase IN ('requested','effect_issued');
CREATE INDEX operations_run ON operations(run_id, created_at);
`;

/**
 * `flowryn drop` (docs/notes/2026-10-15-add-flowryn-drop-mv.md): a plan may be dropped, so plans
 * is rebuilt with that state; drops keeps one row per task dropped (the backlog no longer holds it):
 * its plan, title, the reason given, who dropped it, the tasks it unblocked and when.
 */
const DROPS_SQL = /* sql */ `
CREATE TABLE plans_v26 (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','discarded','dropped')),
  source_task TEXT, gate_id TEXT, filed_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT);
INSERT INTO plans_v26 (id, project_id, title, state, source_task, gate_id, filed_by, created_at, approved_at, approved_via)
  SELECT id, project_id, title, state, source_task, gate_id, filed_by, created_at, approved_at, approved_via FROM plans;
DROP TABLE plans;
ALTER TABLE plans_v26 RENAME TO plans;
CREATE TABLE drops (
  task_id TEXT PRIMARY KEY, plan_id TEXT, title TEXT NOT NULL, reason TEXT NOT NULL,
  dropped_by TEXT NOT NULL, unblocked TEXT NOT NULL DEFAULT '[]', dropped_at INTEGER NOT NULL);
`;

/**
 * Migration 27: the verify that let a merge through (docs/notes/2026-10-15-merge-gate-require-bf.md),
 * in its own column so a waiver beside it or an unproven result's detail never hides it. Older rows
 * keep it in detail ("local green v<n>") or have none.
 */
const MERGE_LOCAL_GREEN_SQL = /* sql */ `
ALTER TABLE merges ADD COLUMN local_green TEXT;
`;

/**
 * Migration 28 (docs/notes/2026-10-17-p1-lane-means-8v.md): the informational items left open before
 * they closed by themselves. A contract_recorded item with a newer one for its harness (the line's
 * first word) is superseded; the newest one per harness gets its key (task_id `harness:<id>`), so the
 * next record supersedes it; then any info item opened over a day ago is resolved.
 */
const INFO_ITEMS_CLOSE_SQL = /* sql */ `
UPDATE items SET state = 'resolved', resolved_by = 'superseded by a newer contract record', resolved_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE kind = 'contract_recorded' AND state IN ('open','presented')
  AND EXISTS (SELECT 1 FROM items n WHERE n.kind = 'contract_recorded'
    AND substr(n.line, 1, instr(n.line, ' ') - 1) = substr(items.line, 1, instr(items.line, ' ') - 1)
    AND (n.opened_at > items.opened_at OR (n.opened_at = items.opened_at AND n.rowid > items.rowid)));
UPDATE items SET task_id = 'harness:' || substr(line, 1, instr(line, ' ') - 1)
WHERE kind = 'contract_recorded' AND task_id IS NULL AND state IN ('open','presented') AND substr(line, 1, instr(line, ' ') - 1) IN ('claude','pi');
UPDATE items SET state = 'resolved', resolved_by = 'informational, open over a day before items closed by themselves', resolved_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE class = 'info' AND state IN ('open','presented') AND opened_at < CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000;
`;

/**
 * Migration 29: the name each applied migration had (docs/notes/2026-10-22-remove-conflict-hotspots-24.md),
 * so a database that ran another branch's migration under the same number is refused instead of
 * silently skipping this one. Rows for migrations applied before the table existed are backfilled by
 * migrate() from this binary's names, with no applied_at.
 */
const SCHEMA_MIGRATIONS_SQL = /* sql */ `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: INIT_SQL },
  { version: 2, name: "runtime", sql: RUNTIME_SQL },
  { version: 3, name: "leader", sql: LEADER_SQL },
  { version: 4, name: "delivery", sql: DELIVERY_SQL },
  { version: 5, name: "workflows", sql: WORKFLOW_SQL },
  { version: 6, name: "decisions", sql: DECISIONS_SQL },
  { version: 7, name: "import", sql: IMPORT_SQL },
  { version: 8, name: "steer-seen", sql: STEER_SEEN_SQL },
  { version: 9, name: "legacy-source", sql: LEGACY_SOURCE_SQL },
  { version: 10, name: "steer-urgent", sql: STEER_URGENT_SQL },
  { version: 11, name: "gate-questions", sql: GATE_QUESTIONS_SQL },
  { version: 12, name: "gate-comment", sql: GATE_COMMENT_SQL },
  { version: 13, name: "attempt-waiver", sql: ATTEMPT_WAIVER_SQL },
  { version: 14, name: "steer-end-turn", sql: STEER_END_TURN_SQL },
  { version: 15, name: "item-full-line", sql: ITEM_FULL_LINE_SQL },
  { version: 16, name: "verifications", sql: VERIFICATIONS_SQL },
  { version: 17, name: "chat-grants", sql: CHAT_GRANTS_SQL, rebuildsReferencedTable: true },
  { version: 18, name: "gate-browser-open", sql: GATE_BROWSER_OPEN_SQL },
  { version: 19, name: "leader-repin", sql: LEADER_REPIN_SQL },
  { version: 20, name: "gate-channel", sql: GATE_CHANNEL_SQL },
  { version: 21, name: "job-leases", sql: JOB_LEASES_SQL },
  { version: 22, name: "explanations", sql: EXPLANATIONS_SQL },
  { version: 23, name: "contract-revision", sql: CONTRACT_REVISION_SQL },
  { version: 24, name: "verify-policy", sql: VERIFY_POLICY_SQL },
  { version: 25, name: "operations", sql: OPERATIONS_SQL },
  { version: 26, name: "drops", sql: DROPS_SQL, rebuildsReferencedTable: true },
  { version: 27, name: "merge-local-green", sql: MERGE_LOCAL_GREEN_SQL },
  { version: 28, name: "info-items-close", sql: INFO_ITEMS_CLOSE_SQL },
  { version: 29, name: "migration-names", sql: SCHEMA_MIGRATIONS_SQL },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
