import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import { FlowrynError } from "../api/errors.ts";
import { getMeta, setMeta, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { canonicalPrUrl } from "../forge/github.ts";
import type { PrState, RepoRef } from "../forge/types.ts";
import { pendingIntents, recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { isDropped } from "./drop.ts";
import { mintTaskId } from "./ids.ts";
import { blockersOf, takenIds } from "./plans.ts";
import type { ProjectRow } from "./projects.ts";
import { holdReason } from "./runs.ts";

/**
 * Event waits (docs/notes/2026-10-25-when-x-then-yv.md): `dispatch --after
 * <event>` files a task Queued until an event happens. A task landing is an
 * ordinary blocked-by edge; a PR merging or a scout's report landing is a
 * watch: a held backlog task only Flowryn completes, which the queued task is
 * blocked by. The delivery watcher's pass settles open watches (fire when
 * the event happened, close when nothing waits for one any more); a fired
 * watch counts as landed (hasLanded), so the scheduler's auto-dispatch starts
 * the waiting task as it starts any phase whose blockers landed.
 */

export type WatchKind = "pr" | "report";

export type AfterEvent = { kind: "pr"; number: number } | { kind: "report"; task: string };

export interface AfterSpec {
  /** task:<id>: ordinary blockers. */
  tasks: string[];
  events: AfterEvent[];
}

export interface WatchRow {
  id: string;
  task_id: string;
  waiter_task: string;
  project_id: string;
  kind: WatchKind;
  target: string;
  state: "open" | "fired" | "closed";
  detail: string | null;
  checked_at: number | null;
  created_at: number;
  ended_at: number | null;
}

const AFTER_FORMS = "task:<id> (it lands), pr:<number> (it merges) or report:<scout task> (its report lands)";
const TASK_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The `--after` values, parsed; refuses an unknown form. Duplicates collapse. */
export function parseAfter(values: string[]): AfterSpec {
  const tasks: string[] = [];
  const events: AfterEvent[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const colon = value.indexOf(":");
    const [prefix, rest] = colon < 0 ? ["", value] : [value.slice(0, colon), value.slice(colon + 1).trim()];
    if (prefix === "task" && TASK_ID.test(rest)) {
      if (!tasks.includes(rest)) tasks.push(rest);
    } else if (prefix === "pr" && /^#?\d+$/.test(rest) && Number(rest.replace("#", "")) > 0) {
      const number = Number(rest.replace("#", ""));
      if (!events.some((e) => e.kind === "pr" && e.number === number)) events.push({ kind: "pr", number });
    } else if (prefix === "report" && TASK_ID.test(rest)) {
      if (!events.some((e) => e.kind === "report" && e.task === rest)) events.push({ kind: "report", task: rest });
    } else {
      throw new FlowrynError("bad_args", `--after ${raw}: expected ${AFTER_FORMS}`);
    }
  }
  return { tasks, events };
}

/** What a watch waits for, in words: "PR #112 to merge", "the report of scout-x". */
export function watchLabel(w: Pick<WatchRow, "kind" | "target">): string {
  return w.kind === "pr" ? `PR #${w.target} to merge` : `the report of ${w.target}`;
}

/** The event as a clause: "PR #112 merges", "the report of scout-x lands". */
export function eventPhrase(w: Pick<WatchRow, "kind" | "target">): string {
  return w.kind === "pr" ? `PR #${w.target} merges` : `the report of ${w.target} lands`;
}

export function watchOfTask(db: Db, taskId: string): WatchRow | null {
  return db.query("SELECT * FROM watches WHERE task_id = ?1").get(taskId) as WatchRow | null;
}

export function watchById(db: Db, id: string): WatchRow | null {
  return db.query("SELECT * FROM watches WHERE id = ?1").get(id) as WatchRow | null;
}

export function watchesOfWaiter(db: Db, waiter: string): WatchRow[] {
  return db.query("SELECT * FROM watches WHERE waiter_task = ?1 ORDER BY created_at, id").all(waiter) as WatchRow[];
}

/** A blocker id as the user reads it: a watch's description, else the task id. */
export function blockerLabel(db: Db, taskId: string): string {
  const watch = watchOfTask(db, taskId);
  return watch ? watchLabel(watch) : taskId;
}

function nextWatchId(db: Db): string {
  const next = Number(getMeta(db, "next_watch_no") ?? "1");
  setMeta(db, "next_watch_no", String(next + 1));
  return `w${next}`;
}

/**
 * A new watch and its held backlog task, before the waiting task is filed
 * (its add names the watch task in --blocked-by, so the watch task's add goes
 * first in the journal). The waiter is set by setWaiter once it has an id.
 * Call inside a transaction.
 */
export function openWatch(db: Db, w: { project: ProjectRow; event: AfterEvent; now: number }): WatchRow {
  const kind = w.event.kind;
  const target = w.event.kind === "pr" ? String(w.event.number) : w.event.task;
  const label = watchLabel({ kind, target });
  const id = nextWatchId(db);
  // Three words fit a task id's slug: after-pr-112-k3, after-report-scout-k3.
  const taskId = mintTaskId(`after ${kind} ${target}`, takenIds(db));
  db.query("INSERT INTO watches (id, task_id, waiter_task, project_id, kind, target, state, created_at) VALUES (?1, ?2, '', ?3, ?4, ?5, 'open', ?6)").run(id, taskId, w.project.id, kind, target, w.now);
  recordIntent(db, { file: "backlog", verb: "add", taskId, positional: [taskId, `Wait for ${label}`], flags: { kind: "watch", repo: w.project.id, body: `Flowryn completes this task when ${eventPhrase({ kind, target })} (watch ${id}).` }, now: w.now });
  recordIntent(db, { file: "backlog", verb: "hold", taskId, positional: [taskId], flags: { reason: holdReason(`watch ${id}`), kind: "captain" }, now: w.now });
  return { id, task_id: taskId, waiter_task: "", project_id: w.project.id, kind, target, state: "open", detail: null, checked_at: null, created_at: w.now, ended_at: null };
}

/** The waiting task's id, once it is minted, and the watch's opened event. Call inside the same transaction. */
export function setWaiter(db: Db, watch: WatchRow, waiter: string, source: EventSource, now: number): void {
  db.query("UPDATE watches SET waiter_task = ?2 WHERE id = ?1").run(watch.id, waiter);
  appendEvent(db, { source, kind: "watch.opened", taskId: watch.task_id, payload: { watch: watch.id, waiter, kind: watch.kind, target: watch.target }, ts: now });
}

/** The open watches. */
export function openWatches(db: Db): WatchRow[] {
  return db.query("SELECT * FROM watches WHERE state = 'open' ORDER BY created_at, id").all() as WatchRow[];
}

/**
 * The event happened: unhold and complete the watch's task (so it lands), and
 * close any stuck alert. Call inside a transaction.
 */
export function fireWatch(db: Db, watch: WatchRow, detail: string, source: EventSource, now: number): void {
  db.query("UPDATE watches SET state = 'fired', detail = ?2, checked_at = ?3, ended_at = ?3 WHERE id = ?1 AND state = 'open'").run(watch.id, detail, now);
  recordIntent(db, { file: "backlog", verb: "unhold", taskId: watch.task_id, positional: [watch.task_id], now });
  recordIntent(db, { file: "backlog", verb: "done", taskId: watch.task_id, positional: [watch.task_id], now });
  resolveItems(db, "watch_stuck", watch.task_id, "watch.fired", now);
  appendEvent(db, { source, kind: "watch.fired", taskId: watch.task_id, payload: { watch: watch.id, waiter: watch.waiter_task, kind: watch.kind, target: watch.target, detail }, ts: now });
}

/**
 * Nothing waits for the watch any more (the waiting task was dropped, or its
 * edge removed by hand): remove its task from the backlog, unless you dropped
 * that already. Call inside a transaction.
 */
export function closeWatch(db: Db, watch: WatchRow, why: string, removeTask: boolean, now: number): void {
  db.query("UPDATE watches SET state = 'closed', detail = ?2, ended_at = ?3 WHERE id = ?1 AND state = 'open'").run(watch.id, why, now);
  if (removeTask) recordIntent(db, { file: "backlog", verb: "rm", taskId: watch.task_id, positional: [watch.task_id], now });
  resolveItems(db, "watch_stuck", watch.task_id, "watch.closed", now);
  appendEvent(db, { source: "daemon", kind: "watch.closed", taskId: watch.task_id, payload: { watch: watch.id, waiter: watch.waiter_task, why }, ts: now });
}

/**
 * The event cannot happen as things stand (the PR was closed unmerged, the
 * scout failed or was dropped): one P1 while it stays so. The watch stays
 * open, because a PR can be reopened and a failed scout dispatched again; it
 * fires if the event still happens. Call inside a transaction.
 */
export function noteWatchStuck(db: Db, watch: WatchRow, why: string, now: number): void {
  db.query("UPDATE watches SET detail = ?2, checked_at = ?3 WHERE id = ?1").run(watch.id, why, now);
  if (findOpenItem(db, "watch_stuck", watch.task_id)) return;
  const event = appendEvent(db, { source: "daemon", kind: "watch.stuck", taskId: watch.task_id, payload: { watch: watch.id, waiter: watch.waiter_task, why }, ts: now });
  openItem(db, {
    kind: "watch_stuck",
    eventSeq: event.seq,
    taskId: watch.task_id,
    line: `${watch.waiter_task} waits for ${watchLabel(watch)}, but ${why}; drop it (flowryn drop ${watch.waiter_task}) or skip the wait (flowryn drop ${watch.task_id} --unblock)`,
    now,
  });
}

/** The stuck alert no longer applies (the PR reopened, the scout runs again). Call inside a transaction. */
export function clearWatchStuck(db: Db, watch: WatchRow, now: number): void {
  if (watch.detail !== null) db.query("UPDATE watches SET detail = NULL, checked_at = ?2 WHERE id = ?1").run(watch.id, now);
  resolveItems(db, "watch_stuck", watch.task_id, "watch.unstuck", now);
}

// --- settling -------------------------------------------------------------------------------

export type WatchVerdict = { fire: string } | { stuck: string } | { waiting: true };

/** A report wait, from the scout's own runs. */
export function reportVerdict(db: Db, scout: string): WatchVerdict {
  if (isDropped(db, scout)) return { stuck: `${scout} was dropped` };
  const latest = db.query("SELECT id, state FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(scout) as { id: string; state: string } | null;
  // Any landed run: the scout's own, or the ship it was promoted to, which kept the scout's landed report.
  const reported = db.query("SELECT id FROM runs WHERE task_id = ?1 AND state IN ('landed','cleaned') ORDER BY started_at LIMIT 1").get(scout) as { id: string } | null;
  if (reported) return { fire: `report landed (run ${reported.id})` };
  if (latest && (latest.state === "failed" || latest.state === "cancelled")) return { stuck: `its run ${latest.id} ${latest.state}` };
  return { waiting: true };
}

/** A PR wait read from Flowryn's own records: the run that delivered it landed. Null when Flowryn did not deliver it. */
export function ownPrVerdict(db: Db, prUrl: string): WatchVerdict | null {
  const owner = db.query("SELECT task_id FROM artifacts WHERE kind = 'pr' AND ref = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(prUrl) as { task_id: string } | null;
  if (!owner) return null;
  const landed = db.query("SELECT id FROM runs WHERE task_id = ?1 AND state IN ('landed','cleaned') ORDER BY started_at DESC LIMIT 1").get(owner.task_id) as { id: string } | null;
  // Not landed yet: GitHub still decides (a merge made there lands the run only on the next delivery pass).
  return landed ? { fire: `merged (${owner.task_id} landed)` } : null;
}

/** A PR wait from GitHub's word on it. */
export function prVerdict(state: PrState): WatchVerdict {
  if (state === "merged") return { fire: "merged on GitHub" };
  if (state === "closed") return { stuck: "it was closed without merging" };
  return { waiting: true };
}

export function prUrlOf(repo: RepoRef, number: number, webUrl: string): string {
  return canonicalPrUrl({ ...repo, number }, webUrl);
}

/** Apply one verdict to an open watch. Call inside a transaction; true when it fired. */
export function applyVerdict(db: Db, watch: WatchRow, verdict: WatchVerdict, now: number): boolean {
  if ("fire" in verdict) {
    fireWatch(db, watch, verdict.fire, "daemon", now);
    return true;
  }
  if ("stuck" in verdict) noteWatchStuck(db, watch, verdict.stuck, now);
  else {
    clearWatchStuck(db, watch, now);
    db.query("UPDATE watches SET checked_at = ?2 WHERE id = ?1").run(watch.id, now);
  }
  return false;
}

/**
 * Why nothing waits for an open watch any more, or null while something
 * does. Only decided once the backlog snapshot holds the watch's task and
 * no write for it or its waiter is pending, so a watch just filed is never
 * closed before its edges reach the backlog.
 */
export function orphanReason(db: Db, watch: WatchRow, backlog: BacklogTask[], pending: Set<string>): { why: string; removeTask: boolean } | null {
  if (isDropped(db, watch.task_id)) return { why: "its task was dropped", removeTask: false };
  if (watch.waiter_task === "" || pending.has(watch.task_id) || pending.has(watch.waiter_task)) return null;
  const own = backlog.find((t) => t.id === watch.task_id);
  if (!own) return { why: "its task left the backlog", removeTask: false };
  if (own.state === "done") return { why: "its task was completed by hand", removeTask: false };
  const waiting = backlog.some((t) => t.state === "queued" && !isDropped(db, t.id) && blockersOf(t).includes(watch.task_id));
  if (waiting) return null;
  return { why: isDropped(db, watch.waiter_task) ? `${watch.waiter_task} was dropped` : "no queued task waits for it", removeTask: true };
}

/** The ids with a backlog write still pending. */
export function pendingTaskIds(db: Db): Set<string> {
  return new Set(pendingIntents(db, "backlog").map((i) => i.task_id).filter((id): id is string => id !== null));
}

export function backlogTasks(db: Db): BacklogTask[] {
  return readSnapshot(db, "backlog")?.tasks ?? [];
}
