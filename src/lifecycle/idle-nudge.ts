import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { Timing } from "../config/workers.ts";
import type { GitRunner } from "../policy/landed.ts";
import { BACKGROUND_ENDED } from "./background-jobs.ts";
import { deliveredOf } from "./delivery.ts";
import { idleEpisodeStart } from "./idle-alert.ts";
import { openRunItemOnce, taskTitle, type RunRow } from "./runs.ts";
import { createSteer, dueSteers, type MessageRow } from "./steers.ts";
import { OUTCOME_KINDS, pendingWait } from "./turn-end-guard.ts";

/**
 * Idle-with-work nudges (task no-idle-workers-23, phase 2). A worker that sits
 * idle with work left (a steer it saw and never acknowledged, commits it has
 * not pushed or delivered, a stage it has not finished, a failed verification
 * of its delivered head nobody sent back) gets a fixed-template steer after
 * `[workers] idle_nudge_min`, then again after twice and four times that, up
 * to `idle_nudge_max` in one episode. One more window with no progress opens
 * one P1 `worker_stalled` for the leader. Never while the worker rightly waits
 * (pendingWait: a review gate, a question, a dialog, a capacity wait, a
 * pending launch, its own background job, an end-turn steer), during a
 * restart handoff, or while a steer ring is in flight. Deterministic: database
 * reads, local git refs and a fixed string.
 */

export const NUDGE_KIND = "run.idle_nudge";
export const STALLED_KIND = "run.idle_stalled";
export const UNKNOWN_KIND = "run.idle_nudge_unknown";

export interface IdleNudgeConfig {
  /** The first window, in ms; each later one doubles it. */
  firstMs: number;
  /** Nudges per episode before the worker_stalled item. */
  max: number;
}

/** What the worktree's local refs say; nothing here reaches the network. */
export interface GitFacts {
  head: string | null;
  /** refs/remotes/origin/<branch>, or null when the branch was never pushed. */
  remote: string | null;
  /** Commits on HEAD not on the remote branch; null when there is no remote branch or it is unknown. */
  unpushed: number | null;
  /** Commits on HEAD not in the delivered head; null when nothing was delivered or it is unknown. */
  undelivered: number | null;
  /** Why a read failed or timed out: the unpushed condition is then unknown, never outstanding. */
  unknown: string | null;
}

export const NO_GIT_FACTS: GitFacts = { head: null, remote: null, unpushed: null, undelivered: null, unknown: null };

export type Outstanding =
  | { kind: "steer"; steer: string }
  | { kind: "unpushed"; commits: number }
  | { kind: "undelivered"; commits: number }
  | { kind: "stage"; stage: string }
  | { kind: "verify"; verification: string };

function failure(result: { code: number; stderr: string }): string {
  return `exit ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]!.slice(0, 200)}` : ""}`;
}

async function countAhead(git: GitRunner, cwd: string, base: string): Promise<{ count: number } | { error: string }> {
  const result = await git(["rev-list", "--count", `${base}..HEAD`], cwd);
  const count = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isInteger(count)) return { error: `git rev-list ${base}..HEAD: ${failure(result)}` };
  return { count };
}

/**
 * Read a ship's HEAD against its remote branch and its delivered head, from
 * local refs only (no fetch). Any failed or timed-out read (124/125 from
 * runBounded) makes the answer unknown rather than outstanding.
 */
export async function readGitFacts(git: GitRunner, run: RunRow, deliveredHead: string | null): Promise<GitFacts> {
  const cwd = run.worktree_path;
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head.code !== 0) return { ...NO_GIT_FACTS, unknown: `git rev-parse HEAD: ${failure(head)}` };
  const facts: GitFacts = { ...NO_GIT_FACTS, head: head.stdout.trim() };
  const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${run.branch}`], cwd);
  if (remote.code === 0) {
    facts.remote = remote.stdout.trim();
    if (facts.remote === facts.head) facts.unpushed = 0;
    else {
      const ahead = await countAhead(git, cwd, facts.remote);
      if ("error" in ahead) return { ...facts, unknown: ahead.error };
      facts.unpushed = ahead.count;
    }
  } else if (remote.code !== 1) return { ...facts, unknown: `git rev-parse origin/${run.branch}: ${failure(remote)}` };
  if (deliveredHead !== null) {
    if (deliveredHead === facts.head) facts.undelivered = 0;
    else {
      const ahead = await countAhead(git, cwd, deliveredHead);
      if ("error" in ahead) return { ...facts, unknown: ahead.error };
      facts.undelivered = ahead.count;
    }
  }
  return facts;
}

/** The run's task kind (ship or scout), from its task policy; null for a run with none. */
export function runKind(db: Db, run: RunRow): string | null {
  return (db.query("SELECT kind FROM task_policy WHERE task_id = ?1").get(run.task_id) as { kind: string } | null)?.kind ?? null;
}

/** The delivered head a ship's git facts compare against, or null. */
export function deliveredHeadOf(db: Db, run: RunRow): string | null {
  return deliveredOf(db, run.task_id)?.head ?? null;
}

interface NudgeEvent {
  ts: number;
  n: number;
  steer: string;
  head: string | null;
  remote: string | null;
  refsUnknown: boolean;
}

function nudgeEvents(db: Db, runId: string): NudgeEvent[] {
  return (db.query("SELECT ts, payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(runId, NUDGE_KIND) as { ts: number; payload: string }[]).map((e) => {
    const p = JSON.parse(e.payload) as { n: number; steer: string; head?: string | null; remote?: string | null; refs_unknown?: boolean };
    return { ts: e.ts, n: p.n, steer: p.steer, head: p.head ?? null, remote: p.remote ?? null, refsUnknown: p.refs_unknown === true };
  });
}

const OUTCOME_SQL = OUTCOME_KINDS.map((k) => `'${k}'`).join(",");

/**
 * When the worker last made progress: an outcome, an acknowledged steer (a
 * nudge's own ack does not count, or acking it would reset the count), a new
 * stage, or a (re)started worker. A new HEAD or a push is judged against the
 * latest nudge's recorded refs (headMoved).
 */
export function progressAt(db: Db, run: RunRow, nudgeIds: ReadonlySet<string>): number {
  const outcome = db.query(`SELECT MAX(ts) AS at FROM events WHERE run_id = ?1 AND kind IN (${OUTCOME_SQL})`).get(run.id) as { at: number | null };
  const acks = db.query("SELECT id, acked_at FROM messages WHERE run_id = ?1 AND acked_at IS NOT NULL").all(run.id) as { id: string; acked_at: number }[];
  const ack = Math.max(0, ...acks.filter((m) => !nudgeIds.has(m.id)).map((m) => m.acked_at));
  return Math.max(run.started_at, run.worker_started_at ?? 0, run.stage_started_at ?? 0, outcome.at ?? 0, ack);
}

function headMoved(episode: NudgeEvent[], facts: GitFacts): boolean {
  const known = episode.findLast((n) => !n.refsUnknown);
  if (!known || facts.head === null || facts.unknown !== null) return false;
  return known.head !== facts.head || known.remote !== facts.remote;
}

/** The work a stopped worker still owes. */
export function outstandingWork(db: Db, run: RunRow, facts: GitFacts, nudgeIds: ReadonlySet<string>): Outstanding[] {
  const out: Outstanding[] = [];
  const seen = db.query("SELECT id FROM messages WHERE run_id = ?1 AND acked_at IS NULL AND ring_state = 'seen' ORDER BY created_at, id").all(run.id) as { id: string }[];
  for (const m of seen) if (!nudgeIds.has(m.id)) out.push({ kind: "steer", steer: m.id });
  if (runKind(db, run) === "ship") {
    if (facts.unpushed !== null && facts.unpushed > 0) out.push({ kind: "unpushed", commits: facts.unpushed });
    if (facts.undelivered !== null && facts.undelivered > 0) out.push({ kind: "undelivered", commits: facts.undelivered });
  }
  if (run.stage_state === "active" && db.query("SELECT 1 FROM events WHERE run_id = ?1 AND kind = 'stage.done' AND ts >= ?2").get(run.id, run.stage_started_at ?? 0) === null) {
    out.push({ kind: "stage", stage: run.stage });
  }
  const delivered = deliveredOf(db, run.task_id);
  if (delivered) {
    const v = db.query("SELECT id, state, finished_at FROM verifications WHERE task_id = ?1 AND head_sha = ?2 ORDER BY started_at DESC LIMIT 1").get(run.task_id, delivered.head) as {
      id: string;
      state: string;
      finished_at: number | null;
    } | null;
    const after = v?.finished_at ?? 0;
    const answered = (db.query("SELECT id FROM messages WHERE run_id = ?1 AND created_at >= ?2").all(run.id, after) as { id: string }[]).some((m) => !nudgeIds.has(m.id));
    if (v && v.state === "failed" && !answered) out.push({ kind: "verify", verification: v.id });
  }
  return out;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describe(o: Outstanding): string {
  switch (o.kind) {
    case "steer":
      return `unacked steer ${o.steer} (read it again: $FLOWRYN_BIN inbox)`;
    case "unpushed":
      return `${plural(o.commits, "commit")} not pushed (push, then deliver)`;
    case "undelivered":
      return `${plural(o.commits, "commit")} past your delivered head (deliver again)`;
    case "stage":
      return `stage ${o.stage} not done`;
    case "verify":
      return `verification ${o.verification} of your delivered head failed (fix it, then deliver again)`;
  }
}

/** The fixed nudge template. */
export function nudgeText(outstanding: Outstanding[]): string {
  return `Flowryn: you are idle with work left: ${outstanding.map(describe).join("; ")}. Continue now; end with an outcome.`;
}

function outstandingLabel(o: Outstanding): string {
  switch (o.kind) {
    case "steer":
      return `steer:${o.steer}`;
    case "unpushed":
    case "undelivered":
      return `${o.kind}:${o.commits}`;
    case "stage":
      return `stage:${o.stage}`;
    case "verify":
      return `verify:${o.verification}`;
  }
}

/** When the next nudge (n already sent this episode) or, past the last, the stall is due. */
export function nudgeDue(windowFrom: number, sent: number, config: IdleNudgeConfig, now: number): boolean {
  return now - windowFrom >= config.firstMs * 2 ** sent;
}

export interface NudgeInput {
  facts: GitFacts;
  config: IdleNudgeConfig;
  timing: Timing;
  /** A daemon restart is asked for or under way: its handoff owns the workers. */
  restartBusy: boolean;
}

export interface NudgeOutcome {
  /** The nudge steer to notify the bus for after commit, or null. */
  steer: MessageRow | null;
  /** A nudge episode is under way: the worker_idle pointer would only repeat it. */
  episodeActive: boolean;
  /** Why no nudge was considered, for tests and logs. */
  skipped: string | null;
}

function none(skipped: string | null, episodeActive = false): NudgeOutcome {
  return { steer: null, episodeActive, skipped };
}

/**
 * Judge one stopped, running worker. Call inside the reconciler's observed
 * transition, after liveness was set idle and the run is not waiting on
 * others. Writes the nudge steer and its event, the unknown note, or the
 * stall item, all in that transaction.
 */
export function runIdleNudge(db: Db, run: RunRow, input: NudgeInput, now: number): NudgeOutcome {
  if (run.state !== "running" || run.idle_since === null) return none("not stopped");
  if (input.restartBusy) return none("restart handoff");
  const wait = pendingWait(db, run, now, "reconciler");
  if (wait !== null) return none(wait);
  const nudges = nudgeEvents(db, run.id);
  const nudgeIds = new Set(nudges.map((n) => n.steer));
  // Another steer on its way (carried, or due to ring): the ring machinery owns it. An earlier nudge rings on its own and never holds the next.
  const inFlight = (db.query("SELECT id FROM messages WHERE run_id = ?1 AND acked_at IS NULL AND ring_state = 'carried'").all(run.id) as { id: string }[]).some((m) => !nudgeIds.has(m.id));
  if (inFlight || dueSteers(db, run.id, now, input.timing).some((m) => !nudgeIds.has(m.id))) return none("a steer ring in flight");
  const progress = progressAt(db, run, nudgeIds);
  const last = nudges.at(-1);
  const sent = headMoved(nudges.filter((n) => n.ts > progress), input.facts) || !last || last.ts <= progress ? 0 : last.n;
  const outstanding = outstandingWork(db, run, input.facts, nudgeIds);
  if (input.facts.unknown !== null && db.query("SELECT 1 FROM events WHERE run_id = ?1 AND kind = ?2 AND ts > ?3").get(run.id, UNKNOWN_KIND, progress) === null) {
    appendEvent(db, { source: "reconciler", kind: UNKNOWN_KIND, runId: run.id, taskId: run.task_id, payload: { detail: input.facts.unknown }, ts: now });
  }
  if (outstanding.length === 0) return none("no outstanding work");
  const bgEnded = db.query("SELECT MAX(ts) AS at FROM events WHERE run_id = ?1 AND kind = ?2").get(run.id, BACKGROUND_ENDED) as { at: number | null };
  const windowFrom = Math.max(idleEpisodeStart(db, run), bgEnded.at ?? 0, last?.ts ?? 0);
  const episodeActive = sent > 0;
  if (!nudgeDue(windowFrom, sent, input.config, now)) return none(null, episodeActive);
  const labels = outstanding.map(outstandingLabel);
  if (sent >= input.config.max) {
    const stalledAlready = db.query("SELECT 1 FROM events WHERE run_id = ?1 AND kind = ?2 AND ts > ?3").get(run.id, STALLED_KIND, last?.ts ?? progress) !== null;
    if (stalledAlready) return none(null, true);
    const idleMs = now - idleEpisodeStart(db, run);
    const ids = nudges.slice(-sent).map((n) => n.steer);
    const event = appendEvent(db, { source: "reconciler", kind: STALLED_KIND, runId: run.id, taskId: run.task_id, payload: { outstanding: labels, nudges: ids, idle_ms: idleMs }, ts: now });
    openRunItemOnce(
      db,
      "worker_stalled",
      run,
      event.seq,
      `Worker for ${taskTitle(db, run.task_id)} is idle with work left after ${plural(ids.length, "nudge")} (${ids.join(", ")}): ${outstanding.map(describe).join("; ")}`,
      now,
    );
    return none(null, true);
  }
  const steer = createSteer(db, run, nudgeText(outstanding), now);
  appendEvent(db, {
    source: "reconciler",
    kind: NUDGE_KIND,
    runId: run.id,
    taskId: run.task_id,
    payload: { n: sent + 1, steer: steer.id, outstanding: labels, idle_ms: now - windowFrom, ...(input.facts.unknown !== null ? { head: null, remote: null, refs_unknown: true } : { head: input.facts.head, remote: input.facts.remote }) },
    ts: now,
  });
  return { steer, episodeActive: true, skipped: null };
}
