import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import type { LawResult } from "./laws.ts";
import type { TestCounts } from "./summary.ts";

/**
 * The verifications table (migration 16) and its events: `pr.verify_started`
 * when a run begins, `pr.verify_step` as each step ends, `pr.verified` when it
 * finishes. Every write goes with its event, inside the caller's transaction.
 */

export type VerificationState = "running" | "passed" | "failed" | "error";
/**
 * `stopped`: a step of a parallel group ended early because another step of its group failed.
 * `skipped`: no file changed against the base matches its when_changed globs; its detail says so.
 */
export type StepState = "waiting" | "running" | "passed" | "failed" | "stopped" | "skipped";

export interface VerifyStep {
  name: string;
  state: StepState;
  exit: number | null;
  ms: number | null;
  /** The step's output, in the verification's directory. */
  log: string;
  tests: TestCounts | null;
  /** Why it failed beyond the exit code (a timeout, a missing binary), or a hang it recovered from. */
  detail: string | null;
  /** Steps with the same group run at the same time; groups run in order. Absent on rows from before groups: each step its own. */
  group?: number;
  /** The step's own deadline (verify_step_timeout_min or its history); null: only the run's. Absent on older rows. */
  deadline_ms?: number | null;
  /** When its current attempt began (ms), for the dashboard's elapsed time and estimate. Absent on older rows. */
  started_at?: number;
  /** How many times it ran: 2 when it hung at its own deadline and was retried. Absent on older rows. */
  attempts?: number;
  /** How many of its attempts were killed at the step's own deadline. Absent on older rows. */
  hangs?: number;
  /** The step runs only when a changed file matches one of these globs. Absent: it always runs. */
  when_changed?: readonly string[];
  /** A step kept from the interrupted verification this one resumes (its id): it passed (or was skipped) there and is not run again. */
  resumed_from?: string;
  /**
   * A landing batch's flake rerun (src/verify/flake.ts): instead of its own command, the step ran
   * only the tests that failed in verification `of`, `passes` times in a row, with its `rerun_failed`
   * command (`command`, the failing packages or files filled in). It passes only when every run did.
   */
  rerun?: { of: string; command: string; passes: number; tests: string[] };
  /** The laws step's result for each law of the table (src/verify/laws.ts). Absent on any other step. */
  laws?: LawResult[];
}

/** What a verification cut off by a daemon stop records (src/verify/runner.ts): never judged. */
export const STOPPED_MID_RUN = "the daemon stopped mid-run";

/** A verification recorded as an error because the daemon stopped under it: never judged, and resumable at the same head and policy. */
export function interruptedByStop(v: Pick<Verification, "state" | "detail">): boolean {
  return v.state === "error" && (v.detail ?? "").startsWith(STOPPED_MID_RUN);
}

export interface VerificationRow {
  id: string;
  project_id: string;
  pr_url: string;
  task_id: string | null;
  head_sha: string;
  state: VerificationState;
  steps: string;
  tests: string | null;
  detail: string | null;
  binary_path: string | null;
  dir: string;
  worktree_path: string;
  project_path: string;
  started_at: number;
  finished_at: number | null;
  /** The verify policy it ran under (src/verify/policy.ts); null on a row from before migration 24. */
  policy_id: string | null;
  /** Its head's tree, recorded at its end when it and the base held still through the run (migration 71); else null. */
  tree_sha: string | null;
  /** What its steps could read of the base (src/verify/changed.ts baseKey), recorded with `tree_sha`. */
  base_key: string | null;
  /** The passed verification whose result it reused instead of running its steps (src/verify/runner.ts); null when it ran them. */
  reused_from: string | null;
}

export interface Verification extends Omit<VerificationRow, "steps" | "tests"> {
  steps: VerifyStep[];
  tests: TestCounts | null;
}

export function parseVerification(row: VerificationRow): Verification {
  return { ...row, steps: JSON.parse(row.steps) as VerifyStep[], tests: row.tests ? (JSON.parse(row.tests) as TestCounts) : null };
}

/** How many of a project's newest finished verifications `lastLawsCheck` reads for a laws step that ran. */
const LAWS_LOOKBACK = 50;

/** The newest finished verification of the project whose laws step ran, with its per-law results; null when none did. */
export function lastLawsCheck(db: Db, projectId: string): { verification: Verification; laws: LawResult[] } | null {
  const rows = db.query("SELECT * FROM verifications WHERE project_id = ?1 AND state <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT ?2").all(projectId, LAWS_LOOKBACK) as VerificationRow[];
  for (const row of rows) {
    const v = parseVerification(row);
    const laws = v.steps.find((s) => s.laws !== undefined)?.laws;
    if (laws) return { verification: v, laws };
  }
  return null;
}

export function getVerification(db: Db, id: string): Verification | null {
  const row = db.query("SELECT * FROM verifications WHERE id = ?1").get(id) as VerificationRow | null;
  return row ? parseVerification(row) : null;
}

export function runningVerifications(db: Db): Verification[] {
  return (db.query("SELECT * FROM verifications WHERE state = 'running' ORDER BY started_at").all() as VerificationRow[]).map(parseVerification);
}

/** Whether services a slot's last user started may still run there, or were released (docs/notes/2026-11-24-verifies-reuse-one-a6.md). */
export type SlotServices = "may_run" | "released";

export interface SlotState {
  /** The verification that last touched the slot: released and reset it, ran steps there, or released it at its end. */
  verification: string;
  services: SlotServices;
}

/** Record, in its own transaction, that `v` touched its slot and what that left there (a `verify.slot_state` event). */
export function recordSlotState(db: Db, v: Pick<Verification, "id" | "worktree_path" | "task_id">, services: SlotServices, now: number): void {
  tx(db, () => appendEvent(db, { source: "daemon", kind: "verify.slot_state", taskId: v.task_id, payload: { slot: v.worktree_path, verification: v.id, services }, ts: now }));
}

/** The slot's newest recorded state; null when nothing was ever recorded for it. */
export function slotState(db: Db, slot: string): SlotState | null {
  return db
    .query("SELECT json_extract(payload, '$.verification') AS verification, json_extract(payload, '$.services') AS services FROM events WHERE kind = 'verify.slot_state' AND json_extract(payload, '$.slot') = ?1 ORDER BY seq DESC LIMIT 1")
    .get(slot) as SlotState | null;
}

/** The newest finished verification of this PR at exactly this head under exactly this verify policy; a legacy row (no policy) never matches. */
export function finishedAtHead(db: Db, prUrl: string, head: string, policy: string): Verification | null {
  const row = db
    .query("SELECT * FROM verifications WHERE pr_url = ?1 AND head_sha = ?2 AND policy_id = ?3 AND state <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(prUrl, head, policy) as VerificationRow | null;
  return row ? parseVerification(row) : null;
}

/** The newest finished verification of this PR at this head under any other verify policy, or none recorded (`policy` null: any). */
export function finishedAtHeadUnderOther(db: Db, prUrl: string, head: string, policy: string | null): Verification | null {
  const row = db
    .query("SELECT * FROM verifications WHERE pr_url = ?1 AND head_sha = ?2 AND (?3 IS NULL OR policy_id IS NULL OR policy_id <> ?3) AND state <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(prUrl, head, policy) as VerificationRow | null;
  return row ? parseVerification(row) : null;
}

/** What a verification's pass proved: its head's tree, the base its steps could read, and the policy it ran under. */
export interface ReuseKey {
  tree: string;
  base: string;
}

/**
 * The newest pass of the project under exactly this policy at exactly this tree and base
 * (docs/notes/2026-11-25-skip-a-batch-z7.md) that ran every step as configured: none was a
 * flake rerun of only the failed tests. `except`: the verification asking.
 */
export function passedAtTree(db: Db, projectId: string, policy: string, key: ReuseKey, except: string): Verification | null {
  const rows = (
    db
      .query("SELECT * FROM verifications WHERE project_id = ?1 AND tree_sha = ?2 AND base_key = ?3 AND policy_id = ?4 AND state = 'passed' AND id <> ?5 ORDER BY finished_at DESC, rowid DESC LIMIT 10")
      .all(projectId, key.tree, key.base, policy, except) as VerificationRow[]
  ).map(parseVerification);
  return rows.find((v) => v.steps.every((s) => !s.rerun)) ?? null;
}

/** The newest passing verification of this PR, at any head. */
export function lastPassed(db: Db, prUrl: string): Verification | null {
  const row = db.query("SELECT * FROM verifications WHERE pr_url = ?1 AND state = 'passed' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(prUrl) as VerificationRow | null;
  return row ? parseVerification(row) : null;
}

/** The newest verification of this PR, any state, for `show`. */
export function latestVerification(db: Db, prUrl: string): Verification | null {
  const row = db.query("SELECT * FROM verifications WHERE pr_url = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(prUrl) as VerificationRow | null;
  return row ? parseVerification(row) : null;
}

export interface NewVerification {
  project_id: string;
  pr_url: string;
  task_id: string | null;
  head_sha: string;
  steps: VerifyStep[];
  /** The verify policy identity of the config the steps came from. */
  policy_id: string;
  dir: (id: string) => string;
  worktree: (id: string) => string;
  project_path: string;
  source: EventSource;
  now: number;
  /** The interrupted verification whose passed steps it keeps (src/verify/start.ts resumeSteps), if any. */
  resumed_from?: string | null;
}

/** Insert a running verification and its event. Call inside a transaction. */
export function insertVerification(db: Db, v: NewVerification): Verification {
  const next = Number(getMeta(db, "next_verify_no") ?? "1");
  setMeta(db, "next_verify_no", String(next + 1));
  const id = `v${next}`;
  db.query(
    `INSERT INTO verifications (id, project_id, pr_url, task_id, head_sha, state, steps, dir, worktree_path, project_path, started_at, policy_id)
     VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).run(id, v.project_id, v.pr_url, v.task_id, v.head_sha, JSON.stringify(v.steps), v.dir(id), v.worktree(id), v.project_path, v.now, v.policy_id);
  appendEvent(db, {
    source: v.source,
    kind: "pr.verify_started",
    taskId: v.task_id,
    payload: {
      verification: id,
      project: v.project_id,
      pr: v.pr_url,
      head: v.head_sha,
      policy: v.policy_id,
      steps: v.steps.map((s) => s.name),
      ...(v.resumed_from ? { resumed_from: v.resumed_from, kept: v.steps.filter((s) => s.resumed_from).map((s) => s.name) } : {}),
    },
    ts: v.now,
  });
  return getVerification(db, id)!;
}

/** Record the steps as they stand now, with an event for the step that began, ended, or began again after a hang. Call inside a transaction. */
export function recordSteps(db: Db, v: Verification, steps: VerifyStep[], changed: VerifyStep, now: number): void {
  db.query("UPDATE verifications SET steps = ?2 WHERE id = ?1 AND state = 'running'").run(v.id, JSON.stringify(steps));
  const ended = changed.state !== "running";
  appendEvent(db, {
    source: "daemon",
    kind: "pr.verify_step",
    taskId: v.task_id,
    payload: {
      verification: v.id,
      step: changed.name,
      state: changed.state,
      exit: ended ? changed.exit : null,
      ms: ended ? changed.ms : null,
      attempt: changed.attempts ?? 1,
      hangs: changed.hangs ?? 0,
    },
    ts: now,
  });
}

export interface VerificationOutcome {
  state: Exclude<VerificationState, "running">;
  steps: VerifyStep[];
  tests: TestCounts | null;
  detail: string | null;
  binary: string | null;
  /** The tree and base its steps saw, when both held still through the run: a later verification may reuse a pass by it. */
  key?: ReuseKey | null;
  /** The passed verification whose result this one reused. */
  reused_from?: string | null;
}

/** Finish a verification with its `pr.verified` event. Call inside a transaction; a row already finished is left alone. */
export function finishVerification(db: Db, v: Verification, outcome: VerificationOutcome, now: number): boolean {
  const key = outcome.key ?? null;
  const reused = outcome.reused_from ?? null;
  const changed = db
    .query("UPDATE verifications SET state = ?2, steps = ?3, tests = ?4, detail = ?5, binary_path = ?6, finished_at = ?7, tree_sha = ?8, base_key = ?9, reused_from = ?10 WHERE id = ?1 AND state = 'running'")
    .run(v.id, outcome.state, JSON.stringify(outcome.steps), outcome.tests ? JSON.stringify(outcome.tests) : null, outcome.detail, outcome.binary, now, key?.tree ?? null, key?.base ?? null, reused).changes;
  if (changed === 0) return false;
  appendEvent(db, {
    source: "daemon",
    kind: "pr.verified",
    taskId: v.task_id,
    payload: {
      verification: v.id,
      project: v.project_id,
      pr: v.pr_url,
      head: v.head_sha,
      policy: v.policy_id,
      state: outcome.state,
      ok: outcome.state === "passed",
      steps: outcome.steps.map((s) => ({ name: s.name, state: s.state, exit: s.exit, ms: s.ms })),
      tests: outcome.tests,
      duration_ms: now - v.started_at,
      binary: outcome.binary,
      detail: outcome.detail,
      tree: key?.tree ?? null,
      ...(reused ? { reused_from: reused } : {}),
    },
    ts: now,
  });
  return true;
}

/** "verifying v4", "verify v4 failed", "verify v4 passed, reused v2": a batch's or a train candidate's verify in a line. */
export function verifyStatus(v: Verification): string {
  if (v.state === "running") return `verifying ${v.id}`;
  return `verify ${v.id} ${v.state}${v.reused_from ? `, reused ${v.reused_from}` : ""}`;
}

/** "v4 passed at fc2f76d7 (1843 pass, 0 fail)", for `show` and the gate's messages; a reused pass adds "reused v2". */
export function verificationLine(v: Verification): string {
  const tests = v.tests ? ` (${v.tests.pass} pass, ${v.tests.fail} fail)` : "";
  const reused = v.reused_from ? `, reused ${v.reused_from}` : "";
  return `${v.id} ${v.state} at ${v.head_sha.slice(0, 8)}${tests}${reused}`;
}
