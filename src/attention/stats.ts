import { FlowrynError } from "../api/errors.ts";
import { stringArg, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { upkeepConfig } from "../config/upkeep.ts";
import { isValidIsoDate, localDate } from "../lifecycle/dates.ts";
import { getProject } from "../lifecycle/projects.ts";
import { isTerminal, TERMINAL_STATES, type RunState } from "../lifecycle/runs.ts";
import { POLICY_EVENT } from "../upkeep/policy-follow.ts";
import { storeStats, type StoreSection } from "./store-stats.ts";

/**
 * `flowryn stats` (docs/notes/2026-10-13-measure-waiting-time-na.md): how long
 * things waited, who intervened and which interventions three fixed rules
 * call unneeded, and how the store grows. Read only, from what Flowryn already
 * records; every query is bounded by the window and a row limit, and a limit
 * that is hit, like any fact the records lack, is a line in `gaps`.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEFAULT_SINCE = "7d";
/** Rows read per wait source (decisions, gates, items, explanations, nudges). */
export const MAX_WAIT_ROWS = 5_000;
/** Event rows read per event query (interventions, steers). */
export const MAX_EVENT_ROWS = 20_000;
/** U1: a dismissal followed by no other action on its task within this long needed nothing. */
export const DISMISS_ALONE_MS = 10 * MINUTE;
const TERMINAL = `(${TERMINAL_STATES.map((s) => `'${s}'`).join(",")})`;

export interface Scope {
  since: number;
  now: number;
  project: string | null;
  /** The first event seq at or after `since` (firstSeqAtOrAfter). */
  firstSeq: number;
}

/** `--since`: `<n>m`, `<n>h`, `<n>d` back from now, or `YYYY-MM-DD` (local midnight). */
export function parseSince(text: string, now: number): number {
  const rel = /^(\d+)([mhd])$/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    if (n > 0) return now - n * { m: MINUTE, h: HOUR, d: DAY }[rel[2] as "m" | "h" | "d"];
  }
  if (isValidIsoDate(text)) {
    const [y, m, d] = text.split("-").map(Number);
    const t = new Date(y!, m! - 1, d!).getTime();
    if (t <= now) return t;
    throw new FlowrynError("bad_args", `--since ${text} is in the future`);
  }
  throw new FlowrynError("bad_args", `--since ${text} is not a window`, "7d, 24h, 90m or YYYY-MM-DD");
}

/**
 * The first event seq whose ts is at or after `ts`, by binary search on the
 * primary key: events has no time index. Assumes ts does not decrease as seq
 * grows (the daemon appends with its own clock). MAX(seq) + 1 when none is.
 */
export function firstSeqAtOrAfter(db: Db, ts: number): number {
  const bounds = db.query("SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM events").get() as { lo: number | null; hi: number | null };
  if (bounds.lo === null || bounds.hi === null) return 1;
  const at = db.query("SELECT ts FROM events WHERE seq >= ?1 ORDER BY seq LIMIT 1");
  let lo = bounds.lo;
  let hi = bounds.hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const row = at.get(mid) as { ts: number } | null;
    if (row === null || row.ts >= ts) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Nearest rank: the value at rank ⌈q·n⌉ of the ascending list (a median of an even count is the lower middle). */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** SQL that is true when `column` (a task id) belongs to the scope's project, or always without --project. */
function inProject(column: string): string {
  return `($project IS NULL OR ${column} IN (SELECT task_id FROM task_policy WHERE project_id = $project))`;
}

// --- waits ------------------------------------------------------------------------------------

export interface Wait {
  reason: string;
  id: string;
  start: number;
  /** null: still open. */
  end: number | null;
}

export interface WaitRow {
  reason: string;
  n: number;
  median: string;
  p90: string;
  max: string;
  open: number;
  oldest: string;
}

interface ExplanationSpan {
  id: number;
  run_id: string;
  rule: string;
  opened_at: number;
  closed_at: number | null;
  closed_by: string | null;
}

const SUPERSEDED = /^superseded by x(\d+)$/;

/**
 * Explanation rows as waits. A row superseded by one of the same rule
 * continues one wait (its facts changed, the wait did not); `resume.auto`
 * waits for nothing. Every row of each run with a row ending in the window
 * or open is read, so a chain begun before the window is joined whole.
 */
export function explanationWaits(db: Db, scope: Scope, gaps: string[]): Wait[] {
  const rows = db
    .query(
      `SELECT id, run_id, rule, opened_at, closed_at, closed_by FROM explanations
       WHERE run_id IN (SELECT run_id FROM explanations WHERE (closed_at IS NULL OR closed_at >= $since) AND ${inProject("task_id")})
       ORDER BY run_id IN (SELECT run_id FROM explanations WHERE closed_at IS NULL) DESC, run_id, id LIMIT $limit`,
    )
    .all({ since: scope.since, project: scope.project, limit: MAX_WAIT_ROWS }) as ExplanationSpan[];
  if (rows.length === MAX_WAIT_ROWS) gaps.push(`wait explanations: capped at ${MAX_WAIT_ROWS} rows`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = new Map<number, ExplanationSpan>();
  const continued = new Set<number>();
  for (const row of rows) {
    const successor = SUPERSEDED.exec(row.closed_by ?? "");
    const to = successor ? byId.get(Number(successor[1])) : undefined;
    if (to && to.rule === row.rule && to.run_id === row.run_id) {
      next.set(row.id, to);
      continued.add(to.id);
    }
  }
  const waits: Wait[] = [];
  for (const head of rows) {
    if (continued.has(head.id) || head.rule === "resume.auto") continue;
    let last = head;
    for (let step = next.get(last.id); step; step = next.get(last.id)) last = step;
    waits.push({ reason: head.rule, id: `x${head.id}`, start: head.opened_at, end: last.closed_at });
  }
  return waits;
}

/** Decisions: created → answered or dismissed. Only you answer a reserved one or a review gate's question. */
export function decisionWaits(db: Db, scope: Scope, gaps: string[]): Wait[] {
  const rows = db
    .query(
      `SELECT id, created_at, answered_at, state, reserved_reason, gate_id, answered_by FROM decisions
       WHERE (state = 'open' OR answered_at >= $since) AND ${inProject("task_id")}
       ORDER BY state = 'open' DESC, answered_at DESC LIMIT $limit`,
    )
    .all({ since: scope.since, project: scope.project, limit: MAX_WAIT_ROWS }) as {
    id: string;
    created_at: number | null;
    answered_at: number | null;
    state: string;
    reserved_reason: string | null;
    gate_id: string | null;
    answered_by: string | null;
  }[];
  if (rows.length === MAX_WAIT_ROWS) gaps.push(`decisions: capped at ${MAX_WAIT_ROWS} rows`);
  const undated = rows.filter((r) => r.created_at === null).length;
  if (undated > 0) gaps.push(`decisions: ${undated} without created_at (before migration 6) left out of waits`);
  return rows
    .filter((r) => r.created_at !== null)
    .map((r) => ({
      reason: r.answered_by === "policy" ? "decision (rule)" : r.reserved_reason || r.gate_id ? "decision (captain)" : "decision (leader)",
      id: r.id,
      start: r.created_at!,
      end: r.state === "open" ? null : r.answered_at,
    }));
}

/** Gates: opened → closed. An open gate of a run that ended waits for nothing. */
export function gateWaits(db: Db, scope: Scope, gaps: string[]): Wait[] {
  const rows = db
    .query(
      `SELECT g.id, g.kind, g.state, g.opened_at, g.closed_at FROM gates g JOIN runs r ON r.id = g.run_id
       WHERE ((g.state = 'open' AND r.state NOT IN ${TERMINAL}) OR g.closed_at >= $since) AND ${inProject("r.task_id")}
       ORDER BY g.state = 'open' DESC, g.closed_at DESC LIMIT $limit`,
    )
    .all({ since: scope.since, project: scope.project, limit: MAX_WAIT_ROWS }) as { id: string; kind: string; state: string; opened_at: number; closed_at: number | null }[];
  if (rows.length === MAX_WAIT_ROWS) gaps.push(`gates: capped at ${MAX_WAIT_ROWS} rows`);
  return rows.map((r) => ({ reason: `gate ${r.kind}`, id: r.id, start: r.opened_at, end: r.state === "open" ? null : r.closed_at }));
}

/** Actionable items: opened → resolved or dismissed. An item carrying a decision is the decision's wait. */
export function itemWaits(db: Db, scope: Scope, gaps: string[]): Wait[] {
  const rows = db
    .query(
      `SELECT id, kind, state, opened_at, resolved_at FROM items
       WHERE class = 'actionable' AND decision_id IS NULL AND (state IN ('open','presented') OR resolved_at >= $since) AND ${inProject("task_id")}
       ORDER BY state IN ('open','presented') DESC, resolved_at DESC LIMIT $limit`,
    )
    .all({ since: scope.since, project: scope.project, limit: MAX_WAIT_ROWS }) as { id: string; kind: string; state: string; opened_at: number; resolved_at: number | null }[];
  if (rows.length === MAX_WAIT_ROWS) gaps.push(`items: capped at ${MAX_WAIT_ROWS} rows`);
  return rows.map((r) => ({ reason: `item ${r.kind}`, id: r.id, start: r.opened_at, end: r.state === "open" || r.state === "presented" ? null : r.resolved_at }));
}

/**
 * Conflict nudges: the nudge → the run's next delivery, or the run's end; open
 * while the run lives. Both ends come no later than the run's end, so every
 * nudge of a run live now or ended in the window is read, whenever it was sent.
 */
export function nudgeWaits(db: Db, scope: Scope, gaps: string[]): Wait[] {
  const rows = db
    .query(
      `SELECT e.seq, e.ts, e.run_id, e.task_id, r.state NOT IN ${TERMINAL} AS live FROM runs r JOIN events e ON e.run_id = r.id
       WHERE (r.state NOT IN ${TERMINAL} OR COALESCE(r.ended_at, r.updated_at) >= $since) AND e.kind = 'run.conflict_nudged' AND ${inProject("r.task_id")}
       ORDER BY live DESC, e.seq DESC LIMIT $limit`,
    )
    .all({ since: scope.since, project: scope.project, limit: MAX_WAIT_ROWS }) as { seq: number; ts: number; run_id: string; task_id: string }[];
  if (rows.length === MAX_WAIT_ROWS) gaps.push(`conflict nudges: capped at ${MAX_WAIT_ROWS} rows`);
  const delivered = db.query("SELECT ts FROM events WHERE run_id = ?1 AND seq > ?2 AND kind = 'run.delivered' ORDER BY seq LIMIT 1");
  const run = db.query("SELECT state, ended_at, updated_at FROM runs WHERE id = ?1");
  return rows.map((r) => {
    const again = delivered.get(r.run_id, r.seq) as { ts: number } | null;
    let end: number | null = again?.ts ?? null;
    if (end === null) {
      const state = run.get(r.run_id) as { state: RunState; ended_at: number | null; updated_at: number } | null;
      if (!state || isTerminal(state.state)) end = state?.ended_at ?? state?.updated_at ?? r.ts;
    }
    return { reason: "conflict nudge", id: r.task_id, start: r.ts, end };
  });
}

/** Per reason: the waits that ended in the window (count and percentiles) and the ones open now. */
export function summarizeWaits(waits: readonly Wait[], scope: Pick<Scope, "since" | "now">): WaitRow[] {
  const groups = new Map<string, Wait[]>();
  for (const w of waits) pushTo(groups, w.reason, w);
  const rows: (WaitRow & { order: [number, number] })[] = [];
  for (const [reason, list] of groups) {
    const ended = list.filter((w) => w.end !== null && w.end >= scope.since && w.end <= scope.now);
    const open = list.filter((w) => w.end === null).toSorted((a, b) => a.start - b.start);
    if (ended.length === 0 && open.length === 0) continue;
    const durations = ended.map((w) => w.end! - w.start).toSorted((a, b) => a - b);
    const oldest = open[0];
    rows.push({
      reason,
      n: ended.length,
      median: formatDuration(percentile(durations, 0.5)),
      p90: formatDuration(percentile(durations, 0.9)),
      max: formatDuration(durations.at(-1) ?? null),
      open: open.length,
      oldest: oldest ? `${formatDuration(scope.now - oldest.start)} ${oldest.id}` : "-",
      order: [open.length, ended.length],
    });
  }
  return rows
    .toSorted((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1] || a.reason.localeCompare(b.reason))
    .map(({ order: _order, ...row }) => row);
}

export function allWaits(db: Db, scope: Scope, gaps: string[]): Wait[] {
  return [...explanationWaits(db, scope, gaps), ...decisionWaits(db, scope, gaps), ...gateWaits(db, scope, gaps), ...itemWaits(db, scope, gaps), ...nudgeWaits(db, scope, gaps)];
}

// --- interventions ----------------------------------------------------------------------------

export interface Intervention {
  action: string;
  by: string;
  ts: number;
  seq: number | null;
  task_id: string | null;
  run_id: string | null;
  payload: Record<string, unknown>;
}

/** The events that are a person's or the leader's action (the design's table); steers are read apart. */
const ACTION_EVENTS = [
  "decision.answered",
  "decision.overridden",
  "item.dismissed",
  "gate.passed",
  "gate.changes",
  "run.declined",
  "operation.requested",
  "run.resume_requested",
  "run.interrupted",
  "divergence.resolved",
  "sched.usage_resumed",
  "sched.quota_override",
] as const;

/** The events that name Flowryn's own steers (payload `steer`): a stage start's and the policy follow-through's. */
const OWN_STEER_EVENTS = ["stage.started", POLICY_EVENT] as const;

/** The roles a verb records as its caller: anything else in a `by` is Flowryn's own doing. */
const CALLERS = new Set(["leader", "human", "captain"]);

function who(by: unknown): string {
  if (by === "captain" || by === "human") return "you";
  return typeof by === "string" && by.length > 0 ? by : "-";
}

function parse(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface EventLite {
  seq: number;
  ts: number;
  kind: string;
  source: string;
  run_id: string | null;
  task_id: string | null;
  payload: string;
}

/** One action event as an intervention, or null when it is Flowryn's own (a merge gate's pass, a daemon's resume). */
function asIntervention(e: EventLite): Intervention | null {
  const p = parse(e.payload);
  const base = { ts: e.ts, seq: e.seq, task_id: e.task_id, run_id: e.run_id, payload: p };
  switch (e.kind) {
    case "decision.answered":
    case "decision.overridden": {
      if (p.by === "policy") return null;
      const by = who(p.by);
      const via = typeof p.via === "string" && p.via !== p.by && p.via !== "leader" ? ` via ${p.via}` : "";
      return { ...base, action: "answer", by: `${by}${via}` };
    }
    case "item.dismissed":
      return { ...base, action: "dismiss", by: who(p.by) };
    case "gate.passed":
      return typeof p.channel === "string" ? { ...base, action: "gate pass", by: p.channel } : null;
    case "gate.changes":
      // A merge gate closed unpassed by a send-back records no caller: the decline or nudge is the action.
      return typeof p.by === "string" ? { ...base, action: "gate changes", by: who(p.by) } : null;
    case "run.declined":
      return { ...base, action: "decline", by: who(p.by) };
    case "operation.requested":
      return p.kind === "cancel" ? { ...base, action: "cancel", by: who(p.by) } : null;
    case "run.resume_requested":
      return { ...base, action: "resume", by: who(p.by) };
    case "run.interrupted":
      return { ...base, action: "interrupt", by: "-" };
    case "divergence.resolved":
      // Flowryn resolves some by itself and names the event that did (by: run.delivered).
      return CALLERS.has(String(p.by)) ? { ...base, action: "divergence resolve", by: who(p.by) } : null;
    case "sched.usage_resumed":
      return e.source === "cli" ? { ...base, action: "capacity resume", by: "you" } : null;
    case "sched.quota_override":
      return { ...base, action: "capacity resume", by: "you" };
    default:
      return null;
  }
}

/** The steer ids Flowryn sent itself in the window: the ones a stage start or a policy follow-through names. */
function ownSteers(db: Db, scope: Scope, gaps: string[]): Set<string> {
  const kinds = OWN_STEER_EVENTS.map((k) => `'${k}'`).join(", ");
  const rows = db
    .query(
      `SELECT json_extract(payload, '$.steer') AS steer FROM events
       WHERE seq >= $first AND kind IN (${kinds}) AND json_extract(payload, '$.steer') IS NOT NULL
       ORDER BY seq LIMIT $limit`,
    )
    .all({ first: scope.firstSeq, limit: MAX_EVENT_ROWS }) as { steer: unknown }[];
  if (rows.length === MAX_EVENT_ROWS) gaps.push(`stage-start and policy steer events: capped at ${MAX_EVENT_ROWS} rows`);
  return new Set(rows.map((r) => String(r.steer)));
}

/**
 * Every intervention in the window: the action events, the leader's and your
 * steers (not Flowryn's stage-start and policy-follow steers, nor an answer's
 * or a dismissal's, which carry their decision), and merge approvals that are
 * not yolo.
 */
export function interventions(db: Db, scope: Scope, gaps: string[]): Intervention[] {
  const kinds = ACTION_EVENTS.map((k) => `'${k}'`).join(", ");
  const events = db
    .query(
      `SELECT seq, ts, kind, source, run_id, task_id, payload FROM events
       WHERE seq >= $first AND ts >= $since AND kind IN (${kinds}) AND ${inProject("task_id")}
       ORDER BY seq LIMIT $limit`,
    )
    .all({ first: scope.firstSeq, since: scope.since, project: scope.project, limit: MAX_EVENT_ROWS }) as EventLite[];
  if (events.length === MAX_EVENT_ROWS) gaps.push(`intervention events: capped at ${MAX_EVENT_ROWS} rows`);
  const out = events.map(asIntervention).filter((i): i is Intervention => i !== null);
  const own = ownSteers(db, scope, gaps);
  const steers = db
    .query(
      `SELECT seq, ts, run_id, task_id, payload FROM events
       WHERE seq >= $first AND ts >= $since AND kind = 'steer.created' AND ${inProject("task_id")}
       ORDER BY seq LIMIT $limit`,
    )
    .all({ first: scope.firstSeq, since: scope.since, project: scope.project, limit: MAX_EVENT_ROWS }) as Omit<EventLite, "kind" | "source">[];
  if (steers.length === MAX_EVENT_ROWS) gaps.push(`steer events: capped at ${MAX_EVENT_ROWS} rows`);
  for (const s of steers) {
    const p = parse(s.payload);
    if (p.decision !== null && p.decision !== undefined) continue;
    if (typeof p.steer === "string" && own.has(p.steer)) continue;
    out.push({ action: "steer", by: "-", ts: s.ts, seq: s.seq, task_id: s.task_id, run_id: s.run_id, payload: p });
  }
  const approvals = db
    .query(
      `SELECT id, task_id, channel, created_at FROM approvals
       WHERE action = 'merge' AND channel != 'yolo' AND created_at >= $since AND ${inProject("task_id")}
       ORDER BY created_at LIMIT $limit`,
    )
    .all({ since: scope.since, project: scope.project, limit: MAX_WAIT_ROWS }) as { id: string; task_id: string; channel: string; created_at: number }[];
  if (approvals.length === MAX_WAIT_ROWS) gaps.push(`merge approvals: capped at ${MAX_WAIT_ROWS} rows`);
  for (const a of approvals) out.push({ action: "approve merge", by: a.channel, ts: a.created_at, seq: null, task_id: a.task_id, run_id: null, payload: { approval: a.id } });
  return out.toSorted((a, b) => a.ts - b.ts);
}

export interface InterventionRow {
  action: string;
  by: string;
  n: number;
}

export function summarizeInterventions(list: readonly Intervention[]): InterventionRow[] {
  const counts = new Map<string, InterventionRow>();
  for (const i of list) {
    const key = `${i.action}\u0000${i.by}`;
    const row = counts.get(key) ?? { action: i.action, by: i.by, n: 0 };
    row.n += 1;
    counts.set(key, row);
  }
  return [...counts.values()].toSorted((a, b) => b.n - a.n || a.action.localeCompare(b.action) || a.by.localeCompare(b.by));
}

// --- unneeded: three rules --------------------------------------------------------------------

export interface UnneededRow {
  rule: string;
  n: number;
  of: number;
  detail: string;
}

function tally(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ") || "-";
}

/**
 * U1: a dismissal after which nobody acted on the same task within
 * DISMISS_ALONE_MS. One whose window has not ended by `now` is not counted,
 * nor one of an item with no task (a system alert: its fix happens outside
 * Flowryn, so no recorded action can follow it); `taskless` counts those.
 */
export function dismissedAlone(list: readonly Intervention[], now: number): { matched: Intervention[]; of: number; taskless: number } {
  const settled = list.filter((i) => i.action === "dismiss" && i.ts + DISMISS_ALONE_MS <= now);
  const dismissals = settled.filter((d) => d.task_id !== null);
  const followUps = new Map<string, number[]>();
  for (const i of list) {
    if (i.action !== "dismiss" && i.task_id !== null) pushTo(followUps, i.task_id, i.ts);
  }
  const matched = dismissals.filter((d) => !(followUps.get(d.task_id!) ?? []).some((ts) => ts > d.ts && ts <= d.ts + DISMISS_ALONE_MS));
  return { matched, of: dismissals.length, taskless: settled.length - dismissals.length };
}

/** U2: a non-urgent steer to a run that was busy, with no open actionable item, when it was sent. */
export function steeredBusy(db: Db, scope: Scope, list: readonly Intervention[], gaps: string[]): { matched: Intervention[]; of: number } {
  const steers = list.filter((i) => i.action === "steer");
  const liveness = db.query("SELECT payload FROM events WHERE run_id = ?1 AND seq < ?2 AND kind = 'run.liveness' ORDER BY seq DESC LIMIT 1");
  const items = db
    .query(
      `SELECT run_id, opened_at, resolved_at FROM items
       WHERE class = 'actionable' AND run_id IS NOT NULL AND (resolved_at IS NULL OR resolved_at >= $since) LIMIT $limit`,
    )
    .all({ since: scope.since, limit: MAX_WAIT_ROWS }) as { run_id: string; opened_at: number; resolved_at: number | null }[];
  if (items.length === MAX_WAIT_ROWS && steers.length > 0) gaps.push(`steer to a busy run: items capped at ${MAX_WAIT_ROWS} rows`);
  const itemsByRun = new Map<string, typeof items>();
  for (const i of items) pushTo(itemsByRun, i.run_id, i);
  const matched = steers.filter((s) => {
    if (s.payload.urgent === true || s.run_id === null || s.seq === null) return false;
    const last = liveness.get(s.run_id, s.seq) as { payload: string } | null;
    if (!last || parse(last.payload).to !== "busy") return false;
    return !(itemsByRun.get(s.run_id) ?? []).some((i) => i.opened_at <= s.ts && (i.resolved_at === null || i.resolved_at > s.ts));
  });
  return { matched, of: steers.length };
}

/** U3: an answer equal to its decision's own recommendation. */
export function answeredAsRecommended(db: Db, list: readonly Intervention[]): { matched: { asked: string }[]; of: number } {
  const decision = db.query("SELECT recommendation, reserved_reason, gate_id FROM decisions WHERE id = ?1");
  let of = 0;
  const matched: { asked: string }[] = [];
  for (const a of list) {
    if (a.action !== "answer" || typeof a.payload.decision !== "string") continue;
    const d = decision.get(a.payload.decision) as { recommendation: string | null; reserved_reason: string | null; gate_id: string | null } | null;
    if (!d?.recommendation) continue;
    of += 1;
    if (a.payload.choice === d.recommendation) matched.push({ asked: d.reserved_reason || d.gate_id ? "captain" : "leader" });
  }
  return { matched, of };
}

/**
 * Items the leader's read closed in the window (`item.read`, src/attention/read-close.ts), by kind.
 * A read is not a dismissal and not an intervention, so U1 never counts it; its detail names them,
 * so the dismissals reading replaced show where they went.
 */
export function readClosures(db: Db, scope: Scope): string[] {
  const rows = db
    .query(
      `SELECT json_extract(payload, '$.kind') AS kind FROM events
       WHERE seq >= $first AND ts >= $since AND kind = 'item.read' AND ${inProject("task_id")}
       LIMIT $limit`,
    )
    .all({ first: scope.firstSeq, since: scope.since, project: scope.project, limit: MAX_EVENT_ROWS }) as { kind: string | null }[];
  return rows.map((r) => r.kind ?? "-");
}

export function unneeded(db: Db, scope: Scope, list: readonly Intervention[], gaps: string[]): UnneededRow[] {
  const u1 = dismissedAlone(list, scope.now);
  const reads = readClosures(db, scope);
  if (reads.length === MAX_EVENT_ROWS) gaps.push(`read closures: capped at ${MAX_EVENT_ROWS} rows`);
  const readDetail = reads.length > 0 ? `; closed on read, not dismissed: ${tally(reads)}` : "";
  if (u1.taskless > 0) gaps.push(`dismissed alone: ${u1.taskless} dismissals of items with no task (system alerts) left out: no recorded action can follow them`);
  const u2 = steeredBusy(db, scope, list, gaps);
  const u3 = answeredAsRecommended(db, list);
  return [
    { rule: "U1 dismissed alone", n: u1.matched.length, of: u1.of, detail: `${tally(u1.matched.map((d) => String(d.payload.kind ?? "-")))}${readDetail}` },
    { rule: "U2 steer to a busy run", n: u2.matched.length, of: u2.of, detail: tally(u2.matched.map((s) => s.task_id ?? "-")) },
    { rule: "U3 answered as recommended", n: u3.matched.length, of: u3.of, detail: tally(u3.matched.map((m) => `asked ${m.asked}`)) },
  ];
}

// --- the verb ---------------------------------------------------------------------------------

/** The facts the records never hold, said whenever they bear on the report. */
function standingGaps(ctx: ReadCtx, since: number): string[] {
  const gaps = [
    "steers and interrupts record no caller (by -); interrupts include urgent steers' preemption",
    "cancels before lifecycle operations (migration 25) record no caller and are not counted",
  ];
  const keepDays = upkeepConfig(ctx.config).explanations_keep_days;
  if (keepDays > 0 && since < ctx.now - keepDays * DAY) gaps.push(`wait explanations closed over ${keepDays} days ago are pruned ([upkeep] explanations_keep_days)`);
  return gaps;
}

function timed<T>(took: Record<string, string>, name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    took[name] = `${(performance.now() - start).toFixed(1)} ms`;
  }
}

function localStamp(t: number): string {
  const d = new Date(t);
  return `${localDate(d)} ${d.toTimeString().slice(0, 5)}`;
}

export interface StatsReport {
  window: { since: string; until: string; project: string };
  waits: WaitRow[];
  interventions: InterventionRow[];
  unneeded: UnneededRow[];
  store: StoreSection;
  gaps: string[];
  took: Record<string, string>;
}

export function statsReport(ctx: ReadCtx, sinceText: string, project: string | null): StatsReport {
  const since = parseSince(sinceText, ctx.now);
  if (project !== null && !getProject(ctx.db, project)) throw new FlowrynError("not_found", `no project ${project}`, "flowryn project list");
  const took: Record<string, string> = {};
  const gaps = standingGaps(ctx, since);
  const scope: Scope = { since, now: ctx.now, project, firstSeq: timed(took, "window", () => firstSeqAtOrAfter(ctx.db, since)) };
  const waits = timed(took, "waits", () => summarizeWaits(allWaits(ctx.db, scope, gaps), scope));
  const { rows, extra } = timed(took, "interventions", () => {
    const list = interventions(ctx.db, scope, gaps);
    return { rows: summarizeInterventions(list), extra: unneeded(ctx.db, scope, list, gaps) };
  });
  const store = timed(took, "store", () => storeStats(ctx, scope, gaps));
  return {
    window: { since: `${localStamp(since)} (${sinceText})`, until: localStamp(ctx.now), project: project ?? "all" },
    waits,
    interventions: rows,
    unneeded: extra,
    store,
    gaps,
    took,
  };
}

const stats: VerbSpec = {
  name: "stats",
  summary: "How long things waited, who intervened (and which looked unneeded), and how the store grows",
  positionals: [],
  flags: {
    since: { type: "string", help: "the window: 7d, 24h, 90m or YYYY-MM-DD (default 7d)", placeholder: "window" },
    project: { type: "string", help: "only this project's waits and interventions (the store is always the whole database)", placeholder: "id" },
  },
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    const report = statsReport(ctx, stringArg(args, "since") ?? DEFAULT_SINCE, stringArg(args, "project") ?? null);
    return { data: { ...report }, hints: ["flowryn capacity", "flowryn show <task> --timeline"] };
  },
};

export const STATS_VERBS: VerbSpec[] = [stats];
