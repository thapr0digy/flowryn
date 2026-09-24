import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { localDate } from "../lifecycle/dates.ts";
import { todoViews } from "../lifecycle/todos.ts";
import { describeSession, getLease, getSession } from "../lease/lease.ts";
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
export const COMMANDS_LINE = "Commands: flowryn fleet · flowryn show <id> · flowryn answer <id> <choice>";

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
  const queued = (readSnapshot(db, "backlog")?.tasks ?? []).filter((t) => t.state === "queued").length;
  return `In flight: ${plural(ships, "ship")}, ${plural(scouts, "scout")}. Queued: ${queued}.`;
}

interface TodoFacts {
  dueToday: string[];
  overdue: number;
}

function todoFacts(db: Db, today: string): TodoFacts {
  const open = todoViews(db).filter((t) => t.state !== "done" && t.due !== null);
  return { dueToday: open.filter((t) => t.due === today).map((t) => t.title), overdue: open.filter((t) => t.due! < today).length };
}

function doneSince(db: Db, day: string): number {
  return (readSnapshot(db, "backlog")?.tasks ?? []).filter((t) => t.state === "done" && t.closed !== null && t.closed >= day).length;
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
  const needs = openActionable(db, input.now, input.ageMs);
  const listed = needs.slice(0, MAX_NEEDS_LINES);
  if (needs.length === 0) lines.push("Needs you: nothing.");
  else {
    lines.push(`Needs you (${needs.length}):`);
    for (const item of listed) lines.push(`- [${item.id}] ${item.lane === "P0" ? "P0 · " : ""}${item.line}`);
    if (needs.length > listed.length) lines.push(`+${needs.length - listed.length} more: flowryn fleet`);
  }
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
