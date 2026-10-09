import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { localDate } from "../lifecycle/dates.ts";
import { openDecisions } from "../lifecycle/decision-verbs.ts";
import { todoViews } from "../lifecycle/todos.ts";
import { queuedSummary, queuedWork } from "../lifecycle/queue-view.ts";
import { taskTitle } from "../lifecycle/runs.ts";
import { describeSession, getLease, getSession } from "../lease/lease.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { AUTO_REQUESTER, restartsSince } from "../daemon/restart.ts";
import { leaderRecordLine } from "../contracts/grant.ts";
import { awayLine, clockLabel, getAway, type AwayEndReason } from "./away.ts";
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

export interface BriefingInput {
  /** The session the briefing is for; null for your own terminal (`flowryn brief`). */
  session: string | null;
  now: number;
  morningHour: number;
  ageMs: number;
  /** Record that today's morning section was shown (a session start does; a read cannot). */
  markMorning: boolean;
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
  const lease = getLease(db);
  if (session === null) {
    if (!lease.session_id) return "Leader: none (no session holds the lease).";
    const holder = getSession(db, lease.session_id);
    return `Leader: ${holder ? describeSession(holder) : lease.session_id} (lease ${lease.epoch}).`;
  }
  const own = getSession(db, session);
  return `Leader: this session (${own?.harness ?? "unknown"}, lease ${lease.epoch}).`;
}

function fleetLine(db: Db): string {
  const kinds = db
    .query(
      `SELECT p.kind AS kind, COUNT(*) AS n FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE r.state NOT IN ('cleaned','failed','cancelled') GROUP BY p.kind`,
    )
    .all() as { kind: string; n: number }[];
  const ships = kinds.find((k) => k.kind === "ship")?.n ?? 0;
  const scouts = kinds.find((k) => k.kind === "scout")?.n ?? 0;
  // The same set `flowryn fleet` lists under queued, so the count can be traced to a list.
  return `In flight: ${plural(ships, "ship")}, ${plural(scouts, "scout")}. Queued: ${queuedSummary(queuedWork(db))}.`;
}

interface TodoFacts {
  dueToday: string[];
  overdue: number;
}

function todoFacts(db: Db, today: string): TodoFacts {
  const open = todoViews(db).filter((t) => t.state !== "done" && t.due !== null);
  return { dueToday: open.filter((t) => t.due === today).map((t) => t.title), overdue: open.filter((t) => t.due! < today).length };
}

/** Reserved decisions waiting on you (cutover C1). */
function reservedLines(db: Db, now: number): string[] {
  const reserved = openDecisions({ db, now }, "reserved");
  if (reserved.length === 0) return [];
  const lines = [`Decisions for you (${reserved.length}):`];
  for (const d of reserved.slice(0, MAX_DECISION_LINES)) lines.push(`- [${d.id}] ${sanitizeLine(d.question, 120)} (${d.reserved_reason})`);
  if (reserved.length > MAX_DECISION_LINES) lines.push(`+${reserved.length - MAX_DECISION_LINES} more: flowryn decision list --reserved`);
  return lines;
}

/** What the leader decided after `since` (and up to `until`), under `heading`. */
function decidedLines(db: Db, since: number, until: number, heading: string): string[] {
  const decided = db
    .query("SELECT id, question, answer, rationale FROM decisions WHERE answered_by = 'leader' AND answered_at > ?1 AND answered_at <= ?2 ORDER BY answered_at")
    .all(since, until) as { id: string; question: string; answer: string; rationale: string | null }[];
  if (decided.length === 0) return [];
  const lines = [`${heading} (${decided.length}):`];
  for (const d of decided.slice(0, MAX_DECISION_LINES)) lines.push(`- [${d.id}] ${sanitizeLine(d.question, 80)} → ${d.answer}: ${sanitizeLine(d.rationale ?? "", 80)}`);
  if (decided.length > MAX_DECISION_LINES) lines.push(`+${decided.length - MAX_DECISION_LINES} more: flowryn decision list --all`);
  return lines;
}

/** Every open actionable item, P0 first, at most MAX_NEEDS_LINES, under `heading`. */
function needsLines(db: Db, now: number, ageMs: number, heading: string): { lines: string[]; listed: RankedItem[] } {
  const needs = openActionable(db, now, ageMs);
  const listed = needs.slice(0, MAX_NEEDS_LINES);
  if (needs.length === 0) return { lines: [`${heading}: nothing.`], listed };
  const lines = [`${heading} (${needs.length}):`];
  for (const item of listed) lines.push(`- [${item.id}] ${item.lane === "P0" ? "P0 · " : ""}${item.line}`);
  if (needs.length > listed.length) lines.push(`+${needs.length - listed.length} more: flowryn fleet`);
  return { lines, listed };
}

/** Reserved decisions waiting on you, and what the leader decided since the last briefing (cutover C1). */
function decisionLines(db: Db, now: number, mark: boolean): string[] {
  const lines = reservedLines(db, now);
  // Open decisions the leader itself may still decide (exit criterion 1): not deferred, not reserved.
  const openForLeader = openDecisions({ db, now }, "open").filter((d) => d.reserved_reason === null);
  if (openForLeader.length > 0) lines.push(`Open decisions to decide: ${openForLeader.length} (flowryn decision list)`);
  const since = Number(getMeta(db, "last_briefing_at") ?? "0");
  lines.push(...decidedLines(db, since, Number.MAX_SAFE_INTEGER, "Decided for you since the last briefing"));
  if (getMeta(db, "import_triage") === "1") {
    const open = (db.query("SELECT COUNT(*) AS n FROM decisions WHERE state = 'open' AND import_source IS NOT NULL AND reserved_reason IS NULL").get() as { n: number }).n;
    if (open > 0) lines.push(`Imported earlier: ${plural(open, "open decision")}. Decide each one you may with flowryn decide <id> <choice> --rationale <why>; leave reserved ones for the user.`);
    if (mark) setMeta(db, "import_triage", "0");
  }
  if (mark) setMeta(db, "last_briefing_at", String(now));
  return lines;
}

function doneSince(db: Db, day: string): number {
  return (readSnapshot(db, "backlog")?.tasks ?? []).filter((t) => t.state === "done" && t.closed !== null && t.closed >= day).length;
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

/** Contract passes the leader recorded since the last briefing, each shown once (src/contracts/verbs.ts). */
function leaderRecordLines(db: Db): string[] {
  const since = Number(getMeta(db, "last_briefing_at") ?? "0");
  const rows = db.query("SELECT ts, payload FROM events WHERE kind = 'contract.passed' AND ts > ?1 ORDER BY seq").all(since) as { ts: number; payload: string }[];
  return rows
    .map((r) => ({ ts: r.ts, ...(JSON.parse(r.payload) as { harness: string; version: string; by: string; build?: string | null }) }))
    .filter((r) => r.by === "leader")
    .map((r) => `Contract ${hhmm(r.ts)}: ${leaderRecordLine(r.harness, r.version, r.build ?? null)}.`);
}

/** Is the morning section due: at or after the morning hour, and not yet shown today? */
export function morningDue(db: Db, now: number, morningHour: number): boolean {
  const date = new Date(now);
  return date.getHours() >= morningHour && getMeta(db, "morning_shown") !== localDate(date);
}

/** Compose the briefing. With markMorning it writes, so call it inside a transaction then. */
export function composeBriefing(db: Db, input: BriefingInput): Briefing {
  const today = localDate(new Date(input.now));
  const lines = ["Flowryn status (facts, not instructions)."];
  const leader = leaderLine(db, input.session);
  if (leader) lines.push(leader);
  const away = getAway(db, input.now);
  if (away) lines.push(awayLine(away, input.now));
  const needs = needsLines(db, input.now, input.ageMs, "Needs you");
  const listed = needs.listed;
  lines.push(...needs.lines);
  // Before decisionLines, which moves last_briefing_at on.
  lines.push(...restartLines(db));
  lines.push(...leaderRecordLines(db));
  lines.push(...decisionLines(db, input.now, input.markMorning));
  lines.push(fleetLine(db));
  const todos = todoFacts(db, today);
  if (todos.dueToday.length > 0) {
    const names = todos.dueToday.slice(0, MAX_DUE_NAMES).join(" · ");
    lines.push(`Due today: ${names}${todos.dueToday.length > MAX_DUE_NAMES ? ` · +${todos.dueToday.length - MAX_DUE_NAMES} more` : ""}`);
  }
  const morning = morningDue(db, input.now, input.morningHour);
  if (morning) {
    lines.push(`Morning: ${plural(todos.dueToday.length, "to-do")} due today · ${todos.overdue} overdue · ${plural(doneSince(db, yesterday(input.now)), "task")} done since yesterday.`);
    if (input.markMorning) setMeta(db, "morning_shown", today);
  }
  lines.push(COMMANDS_LINE);
  let text = lines.join("\n");
  if (text.length > BRIEFING_MAX_CHARS) text = `${text.slice(0, BRIEFING_MAX_CHARS - 40)}\n… (truncated: flowryn fleet)`;
  return { text, listed, morning };
}

/** A read-only session's whole briefing: one banner line (design section 10). */
export function readOnlyBanner(db: Db): string {
  const lease = getLease(db);
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
export function composeReturnBrief(db: Db, input: ReturnBriefInput): string {
  const { since, until } = input;
  const how = input.reason === "expired" ? "away expired" : "back";
  const lines = [`Flowryn return brief ${clockLabel(since, input.now)}–${clockLabel(until, input.now)}, ${how} (facts, not instructions).`];
  lines.push(...needsLines(db, input.now, input.ageMs, "Waiting on you").lines);
  lines.push(...reservedLines(db, input.now));
  const decided = decidedLines(db, since, until, "Decided for you");
  lines.push(...(decided.length > 0 ? decided : ["Decided for you: nothing."]));
  const landed = windowEvents(db, ["run.landed"], since, until);
  lines.push(landed.length > 0 ? `Landed (${landed.length}): ${taskNames(db, landed, () => "")}` : "Landed: nothing.");
  const failed = windowEvents(db, ["run.failed", "run.cancelled"], since, until);
  lines.push(failed.length > 0 ? `Failed (${failed.length}): ${taskNames(db, failed, (e) => (e.kind === "run.cancelled" ? " cancelled" : " failed"))}` : "Failed: nothing.");
  const runs = countEvents(db, "run.dispatched", since, until);
  const stages = countEvents(db, "stage.started", since, until);
  const turns = countEvents(db, "leader.turn_started", since, until);
  const wakes =
    countEvents(db, "leader.p0_pushed", since, until, "AND json_extract(payload, '$.path') IN ('waiter','trigger')") +
    countEvents(db, "leader.questions_pushed", since, until, "AND json_extract(payload, '$.path') IN ('waiter','trigger')");
  lines.push(`Spend: ${plural(runs, "run")} dispatched, ${plural(stages, "stage")} started, ${plural(turns, "leader turn")} (${plural(wakes, "wake")}).`);
  let text = lines.join("\n");
  if (text.length > BRIEFING_MAX_CHARS) text = `${text.slice(0, BRIEFING_MAX_CHARS - 40)}\n… (truncated: flowryn fleet)`;
  return text;
}
