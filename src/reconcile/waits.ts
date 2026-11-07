import { LANE_TABLE, openItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { capacityConfig } from "../config/workflows.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { getProject } from "../lifecycle/projects.ts";
import { deliveredOf, prEvidence } from "../lifecycle/delivery.ts";
import { taskTitle } from "../lifecycle/runs.ts";
import { phaseReadiness } from "../lifecycle/stacks.ts";
import { hostState } from "../sched/scheduler.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { autoMergeProgress, CHECKS_WAIT_MS, checksPending, evidenceHead, HEAD_MOVED_WAIT_MS, headMovedSeenAt, liveAutoMerges, NO_CI_CHECKS_WAIT_MS, type AutoMergeRow } from "../verify/auto-merge.ts";
import { verifyConfig } from "../verify/config.ts";
import { getRequest, queuedRequests, type VerifyRequest } from "../verify/queue.ts";
import { ownWaitCause, waitingOn } from "../verify/start.ts";
import { getVerification, runningVerifications } from "../verify/store.ts";
import { forgeDownSince } from "./forge-health.ts";
import { waitDeadlines, type WaitKind } from "./wait-deadlines.ts";

/**
 * The wait registry (docs/notes/2026-11-06-no-silent-waits-vj.md): every
 * waiting state Flowryn shows gets a deadline from one table, and the
 * reconciler checks them each pass. Past its deadline a wait gets its
 * deterministic recovery first (the scheduler or the auto-merger kicked, which
 * re-queues a lost verify, re-reads the host, re-evaluates a phase's
 * blockers); one still there on a later pass opens one wait_expired item (P1,
 * a leader wake) naming the wait, its age, the cause in plain words and the
 * command that ends it. A wait that ends resolves its item. Plain code: a
 * table, timers and the reconciler; no model. Recovery never passes a gate,
 * answers a decision or merges.
 */

export { MAX_WAIT_MIN, MIN_WAIT_MIN, WAIT_DEADLINES_MS, WAIT_KINDS, waitDeadlines, type WaitKind } from "./wait-deadlines.ts";

/** A recovery gets this long to act before the same wait is itemized (a later pass, never the one that recovered). */
export const RECOVERY_GRACE_MS = 30_000;

/** One waiting state as the registry sees it now. */
export interface Wait {
  /** Stable for the thing waiting: `verify:vq12`, `run:r3`, `phase:t5`, `auto_merge:am4`, `landing:lq5`. */
  key: string;
  kind: WaitKind;
  task_id: string | null;
  run_id: string | null;
  /** When the wait began (its age counts from here). */
  since: number;
  /** When it is overdue. */
  due: number;
  /** What waits: "verify vq12 of t5", "phase 2 of \"Plan\" (t6)". */
  what: string;
  /** Why, in plain words, with any measured value against its limit. */
  cause: string;
  /** The command that ends it. */
  fix: string;
}

/** What the recovery of an expired wait kicks. */
const RECOVERY: Readonly<Record<WaitKind, "scheduler" | "auto_merger">> = {
  verify_queue: "scheduler",
  capacity: "scheduler",
  host: "scheduler",
  harness_check: "scheduler",
  phase_start: "scheduler",
  auto_merge: "auto_merger",
  landing: "auto_merger",
};

/** Items that already carry a wait of this rule to the leader: the wait is recovered, never itemized twice. */
const COVERING_ITEMS: Readonly<Record<string, string>> = {
  "capacity.usage_limit": "usage_limit",
  "capacity.quota_floor": "quota_low",
  "capacity.account_signed_out": "account_signed_out",
  "capacity.harness_unverified": "harness_unverified",
};

const MIN = 60_000;

const ENDED = "('cleaned','failed','cancelled')";

/** The item_id prefix of a wait another open item carries (usage_limit, quota_low, ...). */
const COVERED = "covered:";

/** Whether a project's default branch declares no_ci, as the auto-merger last read it (unknown: no). */
export type NoCiReading = (projectId: string) => boolean;

/** Every wait there is now, oldest first. */
export function collectWaits(db: Db, config: FlowrynConfig, now: number, noCi: NoCiReading = () => false): Wait[] {
  const deadlines = waitDeadlines(config);
  return [...verifyQueueWaits(db, config, deadlines, now), ...runWaits(db, config, deadlines), ...phaseWaits(db, deadlines), ...autoMergeWaits(db, deadlines, noCi), ...landingWaits(db, deadlines)].toSorted(
    (a, b) => a.since - b.since || a.key.localeCompare(b.key),
  );
}

// --- the verify queue --------------------------------------------------------------------------

/** How long a project's verify usually runs: its slowest of the last few passes, else its timeout. */
function usualVerifyMs(db: Db, config: FlowrynConfig, projectId: string): number {
  const row = db
    .query("SELECT MAX(finished_at - started_at) AS ms FROM (SELECT finished_at, started_at FROM verifications WHERE project_id = ?1 AND state = 'passed' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 5)")
    .get(projectId) as { ms: number | null };
  if (row.ms !== null) return row.ms;
  try {
    return verifyConfig(config, projectId)?.timeout_ms ?? 60 * MIN;
  } catch {
    return 60 * MIN;
  }
}

/**
 * The verify queue's waits: each request the drain recorded as waiting on its
 * own PR (it steps aside for the ones behind) gets its own, from when it began
 * waiting; and the first request in line that does not step aside should start
 * once the queue ahead of it last moved, or the verifies running ahead of it
 * are expected to end; requests that went past it never reset its clock.
 */
function verifyQueueWaits(db: Db, config: FlowrynConfig, deadlines: Record<WaitKind, number>, now: number): Wait[] {
  const queued = queuedRequests(db);
  const waits = queued.filter((r) => r.wait_reason !== null).map((r) => ownVerifyWait(config, r, deadlines));
  const first = queued.find((r) => r.wait_reason === null);
  return first ? [...waits, lineVerifyWait(db, config, deadlines, now, first, queued[0] !== first)] : waits;
}

/** What waits, for both kinds of verify wait. */
function verifyWhat(r: VerifyRequest): string {
  return `verify ${r.id}${r.task_id ? ` of ${r.task_id}` : ""} at ${r.head_sha.slice(0, 8)}`;
}

/** A request waiting on its own PR: its recorded cause, due a deadline after it began waiting. */
function ownVerifyWait(config: FlowrynConfig, r: VerifyRequest, deadlines: Record<WaitKind, number>): Wait {
  const since = r.wait_since ?? r.requested_at;
  let detail: string | undefined;
  if (r.wait_reason === "config_invalid") {
    try {
      verifyConfig(config, r.project_id);
    } catch (error) {
      detail = (error as Error).message;
    }
  }
  const show = `flowryn verify show ${r.id}`;
  return {
    key: `verify:${r.id}`,
    kind: "verify_queue",
    task_id: r.task_id,
    run_id: null,
    since,
    due: since + deadlines.verify_queue,
    what: verifyWhat(r),
    cause: `waits on its own PR, so the requests behind it go first: ${ownWaitCause(r, detail)}`,
    fix: r.wait_reason === "config_invalid" ? `flowryn config; ${show}` : show,
  };
}

/** The first request in line that does not step aside (`behindOwn`: requests waiting on their own PR are ahead of it). */
function lineVerifyWait(db: Db, config: FlowrynConfig, deadlines: Record<WaitKind, number>, now: number, first: VerifyRequest, behindOwn: boolean): Wait {
  const ahead = (t: string) => `(${t}.rank, ${t}.requested_at, CAST(substr(${t}.id, 3) AS INTEGER)) < (?1, ?2, ?3)`;
  const place = [first.rank, first.requested_at, Number(first.id.slice(2))] as const;
  const moved = (db.query(`SELECT MAX(q.ended_at) AS t FROM verify_queue q WHERE q.ended_at IS NOT NULL AND ${ahead("q")}`).get(...place) as { t: number | null }).t ?? 0;
  const startedBehind = new Set(
    (
      db
        .query(`SELECT q.verification_id FROM verify_queue q WHERE q.state = 'started' AND q.verification_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM verify_queue a WHERE a.verification_id = q.verification_id AND a.state = 'started' AND ${ahead("a")})`)
        .all(...place) as { verification_id: string }[]
    ).map((r) => r.verification_id),
  );
  const ends = runningVerifications(db)
    .filter((v) => !startedBehind.has(v.id))
    .map((v) => v.started_at + usualVerifyMs(db, config, v.project_id));
  const expected = Math.max(first.requested_at, moved, ...ends);
  let caps: Record<string, number>;
  try {
    caps = capacityConfig(config).pools;
  } catch {
    caps = {};
  }
  const { cause, fix } = verifyWaitCause(db, config, first, caps, now);
  return {
    key: `verify:${first.id}`,
    kind: "verify_queue",
    task_id: first.task_id,
    run_id: null,
    since: first.requested_at,
    due: expected + deadlines.verify_queue,
    what: verifyWhat(first),
    cause: `${behindOwn ? "first in the verify queue behind requests waiting on their own PR" : "first in the verify queue"} and not started: ${cause}`,
    fix,
  };
}

/** Why the first request has not started: the drain's own checks that make it wait (its project's config, GitHub's outage), else what it waits on in the queue. */
function verifyWaitCause(db: Db, config: FlowrynConfig, first: VerifyRequest, caps: Record<string, number>, now: number): { cause: string; fix: string } {
  const show = `flowryn verify show ${first.id}`;
  try {
    verifyConfig(config, first.project_id);
  } catch (error) {
    return { cause: `the [projects.${first.project_id}] config is invalid: ${(error as Error).message}`, fix: `flowryn config; ${show}` };
  }
  const down = first.pr_number !== null ? forgeDownSince(db) : null;
  if (down !== null) return { cause: `GitHub has not answered for ${shortDuration(now - down)}, so its PR cannot be read`, fix: show };
  return { cause: waitingOn(db, first, caps, now), fix: show };
}

// --- runs waiting for a grant ------------------------------------------------------------------

interface WaitingRunRow {
  id: string;
  task_id: string;
  stage: string;
  waiting_since: number;
}

interface CapacityExplanation {
  rule: string;
  reason: string;
  unblock: string;
}

/** "phase 2 of \"Plan\" " when the task is a plan phase. */
function phaseLabel(db: Db, taskId: string): string | null {
  const phase = db.query("SELECT ph.phase_no, pl.title, pl.source_task FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1").get(taskId) as { phase_no: number; title: string; source_task: string | null } | null;
  return phase ? `phase ${phase.phase_no + (phase.source_task ? 1 : 0)} of "${phase.title}"` : null;
}

/** The host check's cause: the measured value, the floor and the key that sets it. */
export function hostCause(db: Db, config: FlowrynConfig): { cause: string; fix: string } {
  const host = hostState(db);
  let floors: { min_free_mem_gb: number; max_load_per_core: number } | null = null;
  try {
    floors = capacityConfig(config).host;
  } catch {
    floors = null;
  }
  const parts: string[] = [];
  const keys: string[] = [];
  if (host?.free_mem_gb != null && floors && host.free_mem_gb < floors.min_free_mem_gb) {
    parts.push(`${host.free_mem_gb} GB free memory, under the ${floors.min_free_mem_gb} GB floor ([capacity.host] min_free_mem_gb)`);
    keys.push("min_free_mem_gb");
  }
  if (host?.load_per_core != null && floors && host.load_per_core > floors.max_load_per_core) {
    parts.push(`load ${host.load_per_core} per core, over the ${floors.max_load_per_core} limit ([capacity.host] max_load_per_core)`);
    keys.push("max_load_per_core");
  }
  const cause = `the host check fails: ${parts.length > 0 ? parts.join("; ") : (host?.reason ?? "no reading yet")}`;
  const fix = keys.length > 0 ? `free the host, or change [capacity.host] ${keys.join(" / ")} in config.toml, then reload it (SIGHUP to the daemon, or flowryn daemon restart); flowryn capacity` : "flowryn capacity";
  return { cause, fix };
}

function kindOfRule(rule: string | undefined): WaitKind {
  if (rule === "capacity.host_check") return "host";
  if (rule === "capacity.harness_unverified") return "harness_check";
  return "capacity";
}

/** Runs waiting for the scheduler's grant (a launch, a resume, a stage start), each with the rule its latest refusal recorded. */
function runWaits(db: Db, config: FlowrynConfig, deadlines: Record<WaitKind, number>): Wait[] {
  const rows = db
    .query(
      `SELECT id, task_id, stage, waiting_since FROM runs WHERE state NOT IN ${ENDED}
         AND (stage_state = 'waiting' OR pending_launch IS NOT NULL) AND (pending_launch IS NOT NULL OR liveness != 'dead')
         AND waiting_since IS NOT NULL ORDER BY waiting_since`,
    )
    .all() as WaitingRunRow[];
  return rows.map((run) => {
    const why = db
      .query("SELECT rule, reason, unblock FROM explanations WHERE run_id = ?1 AND kind = 'capacity' AND closed_at IS NULL ORDER BY opened_at DESC, id DESC LIMIT 1")
      .get(run.id) as CapacityExplanation | null;
    const kind = kindOfRule(why?.rule);
    const phase = phaseLabel(db, run.task_id);
    const what = `${phase ? `${phase} (${run.task_id})` : run.task_id}, stage ${run.stage}`;
    if (kind === "host") return { key: `run:${run.id}`, kind, task_id: run.task_id, run_id: run.id, since: run.waiting_since, due: run.waiting_since + deadlines.host, what, ...hostCause(db, config) };
    let captain: string | null = null;
    try {
      captain = (JSON.parse(why?.unblock ?? "[]") as { by: string; action: string }[]).find((u) => u.by === "captain")?.action ?? null;
    } catch {
      captain = null;
    }
    return {
      key: `run:${run.id}`,
      kind,
      task_id: run.task_id,
      run_id: run.id,
      since: run.waiting_since,
      due: run.waiting_since + deadlines[kind],
      what,
      cause: why ? `no grant: ${why.reason}` : "no grant yet, and no refusal recorded",
      fix: captain ?? "flowryn capacity",
    };
  });
}

/** The rule of a run wait's latest refusal, for the covering-item check. */
function ruleOf(db: Db, runId: string): string | null {
  return (db.query("SELECT rule FROM explanations WHERE run_id = ?1 AND kind = 'capacity' AND closed_at IS NULL ORDER BY opened_at DESC, id DESC LIMIT 1").get(runId) as { rule: string } | null)?.rule ?? null;
}

// --- plan phases -------------------------------------------------------------------------------

interface PhaseWaitRow {
  task_id: string;
  phase_no: number;
  blocked_by: string;
  plan_title: string;
  project_id: string;
  source_task: string | null;
  approved_at: number | null;
  created_at: number;
}

/**
 * An approved plan's automatic phase whose blockers have all landed and that
 * has no run yet: it should start by itself on the scheduler's next pass.
 */
function phaseWaits(db: Db, deadlines: Record<WaitKind, number>): Wait[] {
  const phases = db
    .query(
      `SELECT ph.task_id, ph.phase_no, ph.blocked_by, pl.title AS plan_title, pl.project_id, pl.source_task, pl.approved_at, pl.created_at
       FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id JOIN task_policy tp ON tp.task_id = ph.task_id
       WHERE pl.state = 'approved' AND tp.auto = 1 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ph.task_id)
       ORDER BY pl.created_at, ph.phase_no`,
    )
    .all() as PhaseWaitRow[];
  if (phases.length === 0) return [];
  const backlog = readSnapshot(db, "backlog")?.tasks ?? null;
  const waits: Wait[] = [];
  for (const phase of phases) {
    const project = getProject(db, phase.project_id);
    if (!project || project.autonomy !== "plan") continue;
    const deps = JSON.parse(phase.blocked_by) as string[];
    if (!phaseReadiness(db, phase.task_id, backlog, deps).ready) continue;
    const landed = deps.length === 0 ? null : (db.query(`SELECT MAX(ts) AS t FROM events WHERE kind IN ('run.landed', 'run.cleaned') AND task_id IN (${deps.map((_, i) => `?${i + 1}`).join(", ")})`).get(...deps) as { t: number | null }).t;
    const since = Math.max(landed ?? 0, phase.approved_at ?? phase.created_at);
    const task = backlog?.find((t) => t.id === phase.task_id);
    const blocked = db.query("SELECT line FROM items WHERE kind = 'phase_blocked' AND task_id = ?1 AND state IN ('open','presented') ORDER BY opened_at DESC LIMIT 1").get(phase.task_id) as { line: string } | null;
    const n = phase.phase_no + (phase.source_task ? 1 : 0);
    const cause = !task
      ? "its task is not in the backlog snapshot yet"
      : task.state !== "queued"
        ? `its backlog task is ${task.state}, not queued`
        : task.hold
          ? "it is held in the backlog"
          : blocked
            ? blocked.line
            : `its blockers landed${landed ? "" : " (it has none)"} and the scheduler has not started it (an account pause with no overflow, or a stacked base that moved)`;
    waits.push({
      key: `phase:${phase.task_id}`,
      kind: "phase_start",
      task_id: phase.task_id,
      run_id: null,
      since,
      due: since + deadlines.phase_start,
      what: `phase ${n} of "${phase.plan_title}" (${phase.task_id})`,
      cause,
      fix: `flowryn dispatch ${phase.project_id} --task ${phase.task_id}`,
    });
  }
  return waits;
}

// --- auto-merges and the landing queue ----------------------------------------------------------

/** A live auto-merge that waits on something no other wait covers (its queued verify is the queue's, a running verify has its own deadline). */
function autoMergeWaits(db: Db, deadlines: Record<WaitKind, number>, noCi: NoCiReading): Wait[] {
  const waits: Wait[] = [];
  for (const row of liveAutoMerges(db)) {
    if (row.state === "queued" && row.request_id && getRequest(db, row.request_id)?.state === "queued") continue;
    if (row.state === "verifying" && row.verification_id && getVerification(db, row.verification_id)?.state === "running") continue;
    waits.push({
      key: `auto_merge:${row.id}`,
      kind: "auto_merge",
      task_id: row.task_id,
      run_id: row.run_id,
      since: row.state_since,
      due: autoMergeDue(db, row, deadlines, noCi),
      what: `auto-merge ${row.id} of ${row.task_id}`,
      cause: `${autoMergeProgress(db, row) ?? row.state} since its last change${pendingChecks(db, row)}`,
      fix: row.state === "waiting_checks" ? `flowryn show ${row.task_id}; once its checks finish: flowryn merge ${row.task_id}` : `flowryn show ${row.task_id}`,
    });
  }
  return waits;
}

/**
 * When a live auto-merge is overdue: the table's deadline from its last change, except where the
 * auto-merger has a longer bound of its own on a PR waiting on checks (its checks limit, or
 * HEAD_MOVED_WAIT_MS from when it first saw the PR head move), which it holds at. Evidence still showing an
 * earlier delivered head (GitHub catching up) is not a move: the table's deadline.
 */
function autoMergeDue(db: Db, row: AutoMergeRow, deadlines: Record<WaitKind, number>, noCi: NoCiReading): number {
  const table = row.state_since + deadlines.auto_merge;
  if (row.state !== "waiting_checks" || deliveredOf(db, row.task_id)?.kind !== "pr") return table;
  const pr = prEvidence(db, row.run_id);
  const seen = pr ? evidenceHead(db, row, pr) : "delivered";
  if (seen === "stale") return table;
  if (seen === "moved") return Math.max(table, (headMovedSeenAt(db, row.id) ?? row.state_since) + HEAD_MOVED_WAIT_MS);
  if (checksPending(pr)) return row.state_since + (noCi(row.project_id) ? NO_CI_CHECKS_WAIT_MS : CHECKS_WAIT_MS);
  return table;
}

function pendingChecks(db: Db, row: AutoMergeRow): string {
  if (row.state !== "waiting_checks") return "";
  const raw = db.query("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'github' AND rank = 1").get(row.run_id) as { value: string } | null;
  if (!raw) return "";
  try {
    const pending = (JSON.parse(raw.value) as { checks?: { pending?: string[] } | null }).checks?.pending ?? [];
    return pending.length > 0 ? ` (GitHub checks pending: ${pending.join(", ")})` : "";
  } catch {
    return "";
  }
}

/** Each project's head of line while nothing of it is landing: the next auto-merger pass should bring it up to date. */
function landingWaits(db: Db, deadlines: Record<WaitKind, number>): Wait[] {
  const rows = db
    .query(
      `SELECT l.* FROM landing_queue l WHERE l.state = 'waiting'
         AND NOT EXISTS (SELECT 1 FROM landing_queue x WHERE x.project_id = l.project_id AND x.state = 'landing')
         AND NOT EXISTS (SELECT 1 FROM landing_queue y WHERE y.project_id = l.project_id AND y.state = 'waiting' AND (y.enqueued_at < l.enqueued_at OR (y.enqueued_at = l.enqueued_at AND y.rowid < l.rowid)))`,
    )
    .all() as { id: string; task_id: string; run_id: string; project_id: string; detail: string | null; state_since: number }[];
  return rows.map((row) => ({
    key: `landing:${row.id}`,
    kind: "landing",
    task_id: row.task_id,
    run_id: row.run_id,
    since: row.state_since,
    due: row.state_since + deadlines.landing,
    what: `landing ${row.id} of ${row.task_id} (first in project ${row.project_id}'s line)`,
    cause: row.detail ? `not started: ${row.detail}` : "not started: waiting to be brought up to date with its base",
    fix: `flowryn show ${row.task_id}`,
  }));
}

// --- the pass ----------------------------------------------------------------------------------

interface WaitRow {
  key: string;
  kind: WaitKind;
  task_id: string | null;
  run_id: string | null;
  since: number;
  due: number;
  recovered_at: number;
  item_id: string | null;
  updated_at: number;
}

export interface WaitPassDeps {
  db: Db;
  config(): FlowrynConfig;
  now(): number;
  kickScheduler(): void;
  kickAutoMerger(): void;
  /** The auto-merger's no_ci reading, for a PR's checks deadline. */
  noCi?: NoCiReading;
}

export interface WaitPassResult {
  recovered: string[];
  itemized: string[];
  cleared: string[];
}

/** "12m", "2h": a short duration. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** The deadline as `flowryn fleet` shows it: "in 8m", or "passed 2m ago". */
export function deadlineLabel(w: Pick<Wait, "due">, now: number): string {
  return w.due > now ? `in ${shortDuration(w.due - now)}` : `passed ${shortDuration(now - w.due)} ago`;
}

/** The wait_expired item's line: what waits and for how long, the fix, then why (the digest may cut the end; `show --full` has it whole). */
export function waitLine(db: Db, w: Wait, now: number): string {
  const title = w.task_id ? ` (${sanitizeLine(taskTitle(db, w.task_id), 60)})` : "";
  return `Waiting ${shortDuration(now - w.since)}, past its ${shortDuration(w.due - w.since)} deadline: ${w.what}${title}; ${w.fix}; why: ${w.cause}`;
}

function resolveItem(db: Db, itemId: string, by: string, now: number): void {
  db.query("UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE id = ?1 AND state IN ('open','presented')").run(itemId, by, now);
}

/** An open item that already tells the leader about this wait, if any. */
function coveringItem(db: Db, w: Wait): string | null {
  if (!w.run_id || (w.kind !== "capacity" && w.kind !== "harness_check")) return null;
  const rule = ruleOf(db, w.run_id);
  const kind = rule ? COVERING_ITEMS[rule] : undefined;
  if (!kind || !(kind in LANE_TABLE)) return null;
  return (db.query("SELECT id FROM items WHERE kind = ?1 AND state IN ('open','presented') ORDER BY opened_at LIMIT 1").get(kind) as { id: string } | null)?.id ?? null;
}

/**
 * One reconciler pass over the waits: recover each newly expired one (an
 * event, then the kick after the transaction), itemize one still expired a
 * pass later, and clear the rows (and resolve the items) of waits that ended.
 */
export function checkWaits(deps: WaitPassDeps): WaitPassResult {
  const { db } = deps;
  const now = deps.now();
  const config = deps.config();
  const result: WaitPassResult = { recovered: [], itemized: [], cleared: [] };
  const kicks = new Set<"scheduler" | "auto_merger">();
  tx(db, () => {
    const waits = collectWaits(db, config, now, deps.noCi);
    const expired = new Map(waits.filter((w) => now >= w.due).map((w) => [w.key, w]));
    for (const row of db.query("SELECT * FROM waits").all() as WaitRow[]) {
      const w = expired.get(row.key);
      if (w && w.since === row.since) continue;
      // Ended, back under its deadline, or a new episode of the same key: the old row goes.
      db.query("DELETE FROM waits WHERE key = ?1").run(row.key);
      if (row.item_id && !row.item_id.startsWith(COVERED)) resolveItem(db, row.item_id, "wait ended", now);
      appendEvent(db, { source: "reconciler", kind: "wait.cleared", runId: row.run_id, taskId: row.task_id, payload: { key: row.key, kind: row.kind, waited_ms: now - row.since, item: row.item_id }, ts: now });
      result.cleared.push(row.key);
    }
    for (const w of expired.values()) {
      const row = db.query("SELECT * FROM waits WHERE key = ?1").get(w.key) as WaitRow | null;
      if (!row) {
        db.query("INSERT INTO waits (key, kind, task_id, run_id, since, due, recovered_at, item_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?7)").run(w.key, w.kind, w.task_id, w.run_id, w.since, w.due, now);
        appendEvent(db, {
          source: "reconciler",
          kind: "wait.recovered",
          runId: w.run_id,
          taskId: w.task_id,
          payload: { key: w.key, kind: w.kind, waited_ms: now - w.since, deadline_ms: w.due - w.since, action: `kick the ${RECOVERY[w.kind] === "scheduler" ? "scheduler" : "auto-merger"}`, cause: w.cause },
          ts: now,
        });
        kicks.add(RECOVERY[w.kind]);
        result.recovered.push(w.key);
        continue;
      }
      if ((row.item_id && !row.item_id.startsWith(COVERED)) || now - row.recovered_at < RECOVERY_GRACE_MS) continue;
      const covering = coveringItem(db, w);
      if (covering && row.item_id === `${COVERED}${covering}`) continue;
      const event = appendEvent(db, {
        source: "reconciler",
        kind: "wait.expired",
        runId: w.run_id,
        taskId: w.task_id,
        payload: { key: w.key, kind: w.kind, waited_ms: now - w.since, deadline_ms: w.due - w.since, cause: w.cause, fix: w.fix, covered_by: covering },
        ts: now,
      });
      // A wait another open item already carries is marked with that item, never resolved by this registry.
      const itemId = covering ? `${COVERED}${covering}` : openItem(db, { kind: "wait_expired", eventSeq: event.seq, taskId: w.task_id, runId: w.run_id, line: waitLine(db, w, now), now });
      db.query("UPDATE waits SET item_id = ?2, updated_at = ?3 WHERE key = ?1").run(w.key, itemId, now);
      result.itemized.push(w.key);
    }
  });
  if (kicks.has("scheduler")) deps.kickScheduler();
  if (kicks.has("auto_merger")) deps.kickAutoMerger();
  return result;
}

