import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { localDate } from "../lifecycle/dates.ts";
import { openDecisions } from "../lifecycle/decision-verbs.ts";
import { todoViews } from "../lifecycle/todos.ts";
import { queuedSummary, queuedWork } from "../lifecycle/queue-view.ts";
import { taskTitle } from "../lifecycle/runs.ts";
import { allLeases, describeSession, getLease, getSession, UNCONFIRMED_SCOPE } from "../lease/lease.ts";
import { otherScopeCounts, SEES_ALL, sessionLens, type ScopeLens } from "../leader/scope.ts";
import { wakeLineFor } from "../leader/wake-state.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { AUTO_REQUESTER, restartsSince } from "../daemon/restart.ts";
import { autoRecordLine, leaderRecordLine } from "../contracts/grant.ts";
import { activeAutoAttempt } from "../lifecycle/harness-gate.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { HARNESS_IDS } from "../harness/types.ts";
import { awayLine, clockLabel, getAway, type AwayEndReason } from "./away.ts";
import { RUN_HOLD_KINDS, waitingPointer, waitingRuns } from "./explanations.ts";
import { openActionable, type RankedItem } from "./router.ts";

/**
 * The SessionStart briefing (design section 9): facts, not instructions,
 * under 1.5k tokens and 10,000 characters. It re-lists every open actionable
 * item, so it re-grounds the leader after a compaction too, and the first
 * briefing after the morning hour adds the morning section.
 */

export const BRIEFING_MAX_CHARS = 6_000;
const MAX_NEEDS_LINES = 20;
const MAX_DUE_NAMES = 5;
export const COMMANDS_LINE = "Commands: flowryn fleet · flowryn show <id> · flowryn decide <id> <choice> --rationale <why> · flowryn decision list";
const MAX_DECISION_LINES = 8;
const MAX_WAITING_LINES = 8;

export interface BriefingInput {
  /** The session the briefing is for; null for your own terminal (`flowryn brief`). */
  session: string | null;
  now: number;
  morningHour: number;
  ageMs: number;
  /** Record that today's morning section was shown (a session start does; a read cannot). */
  markMorning: boolean;
  /** The config, so an automatic contract check is listed only while checks are on; without it none is. */
  config?: FlowrynConfig;
  /** What the reader may see: the session's scope (src/leader/scope.ts); default, the session's own lens. */
  lens?: ScopeLens;
}

export interface Briefing {
  text: string;
  /** Actionable items the briefing lists, so a session start can record them as carried. */
  listed: RankedItem[];
  morning: boolean;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Sep 20" for an overdue to-do's line. */
export function dueLabel(iso: string): string {
  return shortDate(iso);
}

function yesterday(now: number): string {
  const d = new Date(now);
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

function leaderLine(db: Db, session: string | null): string | null {
  if (session === null) {
    const held = allLeases(db).filter((l) => l.session_id !== null);
    if (held.length === 0) return "Leader: none (no session holds the lease).";
    const scoped = held.length > 1 || held[0]!.scope !== "default";
    return `Leader: ${held
      .map((lease) => {
        const holder = getSession(db, lease.session_id!);
        return `${holder ? describeSession(holder) : lease.session_id} (${scoped ? `${lease.scope}, ` : ""}lease ${lease.epoch})`;
      })
      .join("; ")}.`;
  }
  const own = getSession(db, session);
  const lease = own && own.scope !== UNCONFIRMED_SCOPE ? getLease(db, own.scope) : null;
  return `Leader: this session (${own?.harness ?? "unknown"}, lease ${lease?.epoch ?? 0}).`;
}

function fleetLine(db: Db, lens: ScopeLens): string {
  const kinds = db
    .query(
      `SELECT p.kind AS kind, r.task_id AS task_id FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE r.state NOT IN ('cleaned','failed','cancelled')`,
    )
    .all() as { kind: string; task_id: string }[];
  const seen = kinds.filter((k) => lens.task(k.task_id));
  const ships = seen.filter((k) => k.kind === "ship").length;
  const scouts = seen.filter((k) => k.kind === "scout").length;
  // The same set `flowryn fleet` lists under queued, so the count can be traced to a list.
  return `In flight: ${plural(ships, "ship")}, ${plural(scouts, "scout")}. Queued: ${queuedSummary(queuedWork(db).filter((q) => lens.task(q.id)))}.`;
}

interface TodoFacts {
  dueToday: string[];
  overdue: number;
}

function todoFacts(db: Db, today: string, lens: ScopeLens): TodoFacts {
  const open = todoViews(db).filter((t) => t.state !== "done" && t.due !== null && lens.task(t.id));
  return { dueToday: open.filter((t) => t.due === today).map((t) => t.title), overdue: open.filter((t) => t.due! < today).length };
}

/** Reserved decisions waiting on you (cutover C1). */
function reservedLines(db: Db, now: number, lens: ScopeLens): string[] {
  const reserved = openDecisions({ db, now }, "reserved").filter((d) => lens.task(d.task_id));
  if (reserved.length === 0) return [];
  const lines = [`Decisions for you (${reserved.length}):`];
  for (const d of reserved.slice(0, MAX_DECISION_LINES)) lines.push(`- [${d.id}] ${sanitizeLine(d.question, 120)} (${d.reserved_reason})`);
  if (reserved.length > MAX_DECISION_LINES) lines.push(`+${reserved.length - MAX_DECISION_LINES} more: flowryn decision list --reserved`);
  return lines;
}

/** What the leader decided after `since` (and up to `until`), under `heading`. */
function decidedLines(db: Db, since: number, until: number, heading: string, lens: ScopeLens): string[] {
  const decided = (
    db
      .query("SELECT id, task_id, question, answer, rationale FROM decisions WHERE answered_by = 'leader' AND answered_at > ?1 AND answered_at <= ?2 ORDER BY answered_at")
      .all(since, until) as { id: string; task_id: string; question: string; answer: string; rationale: string | null }[]
  ).filter((d) => lens.task(d.task_id));
  if (decided.length === 0) return [];
  const lines = [`${heading} (${decided.length}):`];
  for (const d of decided.slice(0, MAX_DECISION_LINES)) lines.push(`- [${d.id}] ${sanitizeLine(d.question, 80)} → ${d.answer}: ${sanitizeLine(d.rationale ?? "", 80)}`);
  if (decided.length > MAX_DECISION_LINES) lines.push(`+${decided.length - MAX_DECISION_LINES} more: flowryn decision list --all`);
  return lines;
}

/**
 * What a `[decisions] nomistakes_rules` rule settled after `since` (and up to `until`), with the
 * undo the user may still take while the run is live (docs/notes/2026-10-22-settle-routine-no-2r.md).
 */
function ruleLines(db: Db, since: number, until: number, heading: string, lens: ScopeLens): string[] {
  const settled = (
    db
      .query("SELECT id, task_id, question, answer, answered_via FROM decisions WHERE answered_by = 'policy' AND answered_at > ?1 AND answered_at <= ?2 ORDER BY answered_at")
      .all(since, until) as { id: string; task_id: string; question: string; answer: string; answered_via: string | null }[]
  ).filter((d) => lens.task(d.task_id));
  if (settled.length === 0) return [];
  const lines = [`${heading} (${settled.length}; undo: flowryn decide <id> <choice> --by captain):`];
  for (const d of settled.slice(0, MAX_DECISION_LINES)) lines.push(`- [${d.id}] ${sanitizeLine(d.question, 80)} → ${d.answer} (${d.answered_via ?? "rule"})`);
  if (settled.length > MAX_DECISION_LINES) lines.push(`+${settled.length - MAX_DECISION_LINES} more: flowryn decision list --all`);
  return lines;
}

/** Every open actionable item, P0 first, at most MAX_NEEDS_LINES, under `heading`. */
function needsLines(db: Db, now: number, ageMs: number, heading: string, lens: ScopeLens): { lines: string[]; listed: RankedItem[] } {
  const needs = openActionable(db, now, ageMs)
    .filter((i) => lens.item(i))
    .map((i) => lens.redact(i));
  const listed = needs.slice(0, MAX_NEEDS_LINES);
  if (needs.length === 0) return { lines: [`${heading}: nothing.`], listed };
  const lines = [`${heading} (${needs.length}):`];
  for (const item of listed) lines.push(`- [${item.id}] ${item.lane === "P0" ? "P0 · " : ""}${item.line}`);
  if (needs.length > listed.length) lines.push(`+${needs.length - listed.length} more: flowryn fleet`);
  return { lines, listed };
}

/** Why each waiting run waits, from its recorded explanation; no section when nothing waits (docs/notes/2026-10-13-next-steps-md-wq.md). */
function waitingLines(db: Db, lens: ScopeLens): string[] {
  // Reviews, decisions and merges are left out: "Needs you" lists them already (docs/notes/2026-10-29-why-waiting-covers-fy.md).
  const held = waitingRuns(db, RUN_HOLD_KINDS).filter((w) => lens.task(w.task_id));
  if (held.length === 0) return [];
  const lines = [`Waiting (${held.length}):`];
  for (const w of held.slice(0, MAX_WAITING_LINES)) {
    const p = waitingPointer(w);
    lines.push(`- [${w.task_id}] waiting: ${p.waiting} · next: ${p.next}`);
  }
  if (held.length > MAX_WAITING_LINES) lines.push(`+${held.length - MAX_WAITING_LINES} more: flowryn fleet`);
  return lines;
}

/** Reserved decisions waiting on you, and what the leader decided since the last briefing (cutover C1). */
function decisionLines(db: Db, now: number, mark: boolean, lens: ScopeLens): string[] {
  const lines = reservedLines(db, now, lens);
  // Open decisions the leader itself may still decide (exit criterion 1): not deferred, not reserved.
  const openForLeader = openDecisions({ db, now }, "open").filter((d) => d.reserved_reason === null && lens.task(d.task_id));
  if (openForLeader.length > 0) lines.push(`Open decisions to decide: ${openForLeader.length} (flowryn decision list)`);
  const since = Number(getMeta(db, "last_briefing_at") ?? "0");
  lines.push(...decidedLines(db, since, Number.MAX_SAFE_INTEGER, "Decided for you since the last briefing", lens));
  lines.push(...ruleLines(db, since, Number.MAX_SAFE_INTEGER, "Settled by rule since the last briefing", lens));
  if (getMeta(db, "import_triage") === "1") {
    const open = (db.query("SELECT COUNT(*) AS n FROM decisions WHERE state = 'open' AND import_source IS NOT NULL AND reserved_reason IS NULL").get() as { n: number }).n;
    if (open > 0) lines.push(`Imported earlier: ${plural(open, "open decision")}. Decide each one you may with flowryn decide <id> <choice> --rationale <why>; leave reserved ones for the user.`);
    if (mark) setMeta(db, "import_triage", "0");
  }
  if (mark) setMeta(db, "last_briefing_at", String(now));
  return lines;
}

function doneSince(db: Db, day: string, lens: ScopeLens): number {
  return (readSnapshot(db, "backlog")?.tasks ?? []).filter((t) => t.state === "done" && t.closed !== null && t.closed >= day && lens.task(t.id)).length;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Daemon restarts since the last briefing, each shown once: who asked, and the build before and after. */
function restartLines(db: Db): string[] {
  const since = Number(getMeta(db, "last_briefing_at") ?? "0");
  return restartsSince(db, since).map((r) => {
    const who = r.by === "leader" ? ` by the leader${r.session ? ` (${r.session})` : ""}` : r.by === "human" ? " by you" : r.by === AUTO_REQUESTER ? " automatically" : ` by ${r.by}`;
    const proto = r.old.proto === r.new.proto ? `proto ${r.new.proto}` : `proto ${r.old.proto}→${r.new.proto}`;
    const commit = r.new.commit ? ` (commit ${r.new.commit.slice(0, 7)})` : "";
    return `Daemon restarted ${hhmm(r.ts)}${who}: build ${r.old.build ?? "dev"}→${r.new.build ?? "dev"}${commit}, ${r.new.version}, ${proto}.`;
  });
}

/**
 * Contract passes the leader or the daemon's automatic check recorded since
 * the last briefing, each shown once (src/contracts/verbs.ts, auto.ts).
 */
function recordLines(db: Db): string[] {
  const since = Number(getMeta(db, "last_briefing_at") ?? "0");
  const rows = db.query("SELECT ts, payload FROM events WHERE kind = 'contract.passed' AND ts > ?1 ORDER BY seq").all(since) as { ts: number; payload: string }[];
  return rows
    .map((r) => ({ ts: r.ts, ...(JSON.parse(r.payload) as { harness: string; version: string; by: string; build?: string | null }) }))
    .filter((r) => r.by === "leader" || r.by === "daemon")
    .map((r) => `Contract ${hhmm(r.ts)}: ${(r.by === "leader" ? leaderRecordLine : autoRecordLine)(r.harness, r.version, r.build ?? null)}.`);
}

/** An automatic contract check queued or running now (src/contracts/auto.ts): shown while it lasts. */
function autoCheckLines(db: Db, config: FlowrynConfig | undefined): string[] {
  const lines: string[] = [];
  if (!config) return lines;
  for (const harness of HARNESS_IDS) {
    const attempt = activeAutoAttempt(db, config, harness);
    if (!attempt) continue;
    if (attempt.state === "running") lines.push(`Contract check running: ${harness} ${attempt.version} since ${hhmm(attempt.started_at ?? 0)} (automatic).`);
    else if (attempt.state === "waiting") lines.push(`Contract check queued: ${harness} ${attempt.version}, waiting for ${attempt.wait ?? "its turn"} (automatic).`);
  }
  return lines;
}

/** The meta key that marks a scope's morning section shown; an unrestricted lens keeps the home's one key. */
function morningKey(lens: ScopeLens): string {
  return lens.restricted && lens.scope ? `morning_shown:${lens.scope}` : "morning_shown";
}

/** Is the morning section due: at or after the morning hour, and not yet shown today to this lens's scope? */
function morningDue(db: Db, now: number, morningHour: number, lens: ScopeLens): boolean {
  const date = new Date(now);
  return date.getHours() >= morningHour && getMeta(db, morningKey(lens)) !== localDate(date);
}

/** Compose the briefing. With markMorning it writes, so call it inside a transaction then. */
export function composeBriefing(db: Db, input: BriefingInput): Briefing {
  const today = localDate(new Date(input.now));
  const lens = input.lens ?? sessionLens(db, input.config, input.session);
  const lines = ["Flowryn status (facts, not instructions)."];
  const leader = leaderLine(db, input.session);
  if (leader) lines.push(leader);
  const away = getAway(db, input.now);
  if (away) lines.push(awayLine(away, input.now));
  const wake = wakeLineFor(db, input.session, input.now);
  if (wake) lines.push(wake);
  const needs = needsLines(db, input.now, input.ageMs, "Needs you", lens);
  const listed = needs.listed;
  lines.push(...needs.lines);
  lines.push(...otherScopeLines(db, input.config, lens));
  lines.push(...waitingLines(db, lens));
  // Before decisionLines, which moves last_briefing_at on.
  lines.push(...restartLines(db));
  lines.push(...recordLines(db));
  lines.push(...autoCheckLines(db, input.config));
  lines.push(...decisionLines(db, input.now, input.markMorning, lens));
  lines.push(fleetLine(db, lens));
  const todos = todoFacts(db, today, lens);
  if (todos.dueToday.length > 0) {
    const names = todos.dueToday.slice(0, MAX_DUE_NAMES).join(" · ");
    lines.push(`Due today: ${names}${todos.dueToday.length > MAX_DUE_NAMES ? ` · +${todos.dueToday.length - MAX_DUE_NAMES} more` : ""}`);
  }
  const morning = morningDue(db, input.now, input.morningHour, lens);
  if (morning) {
    lines.push(`Morning: ${plural(todos.dueToday.length, "to-do")} due today · ${todos.overdue} overdue · ${plural(doneSince(db, yesterday(input.now), lens), "task")} done since yesterday.`);
    if (input.markMorning) setMeta(db, morningKey(lens), today);
  }
  lines.push(COMMANDS_LINE);
  let text = lines.join("\n");
  if (text.length > BRIEFING_MAX_CHARS) text = `${text.slice(0, BRIEFING_MAX_CHARS - 40)}\n… (truncated: flowryn fleet)`;
  return { text, listed, morning };
}

/**
 * What waits in the other scopes, as counts only (docs/notes/2026-10-24-leader-scoping-and-vj.md):
 * enough to say a leader is missing, never what the work is.
 */
function otherScopeLines(db: Db, config: FlowrynConfig | undefined, lens: ScopeLens): string[] {
  if (!config || !lens.restricted) return [];
  return otherScopeCounts(db, config, lens.scope).map((c) => `Other scope ${c.scope}: ${plural(c.items, "item")} wait for its leader (not shown here).`);
}

/** A read-only session's whole briefing: one banner line (design section 10). */
export function readOnlyBanner(db: Db, session: string): string {
  const own = getSession(db, session);
  if (!own || own.scope === UNCONFIRMED_SCOPE) return "Flowryn: this session's login is not confirmed, so it leads no scope and sees nothing. Start the leader again with: flowryn lead";
  const lease = getLease(db, own.scope);
  const holder = lease.session_id ? getSession(db, lease.session_id) : null;
  if (!holder) return "Flowryn: read-only; no session holds the lease. Take it with: flowryn leader claim";
  return `Flowryn: read-only: leader is ${describeSession(holder)}. Take over with: flowryn leader claim`;
}

export interface ReturnBriefInput {
  since: number;
  until: number;
  now: number;
  ageMs: number;
  reason: AwayEndReason;
  /** What the reader may see (src/leader/scope.ts); default all. */
  lens?: ScopeLens;
}

interface WindowEvent {
  kind: string;
  task_id: string | null;
  payload: string;
}

function windowEvents(db: Db, kinds: string[], since: number, until: number): WindowEvent[] {
  return db
    .query(`SELECT kind, task_id, payload FROM events WHERE kind IN (${kinds.map(() => "?").join(", ")}) AND ts > ? AND ts <= ? ORDER BY seq`)
    .all(...kinds, since, until) as WindowEvent[];
}

function countEvents(db: Db, kind: string, since: number, until: number, where = ""): number {
  return (db.query(`SELECT COUNT(*) AS n FROM events WHERE kind = ?1 AND ts > ?2 AND ts <= ?3 ${where}`).get(kind, since, until) as { n: number }).n;
}

function taskNames(db: Db, events: WindowEvent[], suffix: (e: WindowEvent) => string): string {
  return events
    .slice(0, MAX_DECISION_LINES)
    .map((e) => {
      if (!e.task_id) return `?${suffix(e)}`;
      const title = taskTitle(db, e.task_id);
      return `${sanitizeLine(title, 60)}${title === e.task_id ? "" : ` (${e.task_id})`}${suffix(e)}`;
    })
    .join(" · ")
    .concat(events.length > MAX_DECISION_LINES ? ` · +${events.length - MAX_DECISION_LINES} more` : "");
}

/**
 * The return brief (away mode): one fixed template in a fixed order, from
 * the briefing's own sections and the event log, so it can be recomputed:
 * waiting on you; decided for you; landed; failed; spend.
 */
const RETURN_HOW: Record<AwayEndReason, string> = { back: "back", expired: "away expired", returned: "automatic away, the user returned" };

export function composeReturnBrief(db: Db, input: ReturnBriefInput): string {
  const { since, until } = input;
  const how = RETURN_HOW[input.reason];
  const lens = input.lens ?? SEES_ALL;
  const lines = [`Flowryn return brief ${clockLabel(since, input.now)}–${clockLabel(until, input.now)}, ${how} (facts, not instructions).`];
  lines.push(...needsLines(db, input.now, input.ageMs, "Waiting on you", lens).lines);
  lines.push(...reservedLines(db, input.now, lens));
  const decided = decidedLines(db, since, until, "Decided for you", lens);
  lines.push(...(decided.length > 0 ? decided : ["Decided for you: nothing."]));
  lines.push(...ruleLines(db, since, until, "Settled by rule", lens));
  const landed = windowEvents(db, ["run.landed"], since, until).filter((e) => lens.task(e.task_id));
  lines.push(landed.length > 0 ? `Landed (${landed.length}): ${taskNames(db, landed, () => "")}` : "Landed: nothing.");
  const failed = windowEvents(db, ["run.failed", "run.cancelled"], since, until).filter((e) => lens.task(e.task_id));
  lines.push(failed.length > 0 ? `Failed (${failed.length}): ${taskNames(db, failed, (e) => (e.kind === "run.cancelled" ? " cancelled" : " failed"))}` : "Failed: nothing.");
  const runs = countEvents(db, "run.dispatched", since, until);
  const stages = countEvents(db, "stage.started", since, until);
  const turns = countEvents(db, "leader.turn_started", since, until);
  const wakes =
    countEvents(db, "leader.p0_pushed", since, until, "AND json_extract(payload, '$.path') IN ('waiter','trigger')") +
    countEvents(db, "leader.questions_pushed", since, until, "AND json_extract(payload, '$.path') IN ('waiter','trigger')") +
    countEvents(db, "leader.follow_ups_pushed", since, until, "AND json_extract(payload, '$.path') IN ('waiter','trigger')");
  lines.push(`Spend: ${plural(runs, "run")} dispatched, ${plural(stages, "stage")} started, ${plural(turns, "leader turn")} (${plural(wakes, "wake")}).`);
  let text = lines.join("\n");
  if (text.length > BRIEFING_MAX_CHARS) text = `${text.slice(0, BRIEFING_MAX_CHARS - 40)}\n… (truncated: flowryn fleet)`;
  return text;
}
