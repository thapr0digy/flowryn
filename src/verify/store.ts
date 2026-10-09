import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import type { TestCounts } from "./summary.ts";

/**
 * The verifications table (migration 16) and its events: `pr.verify_started`
 * when a run begins, `pr.verify_step` as each step ends, `pr.verified` when it
 * finishes. Every write goes with its event, inside the caller's transaction.
 */

export type VerificationState = "running" | "passed" | "failed" | "error";
export type StepState = "waiting" | "running" | "passed" | "failed";

export interface VerifyStep {
  name: string;
  state: StepState;
  exit: number | null;
  ms: number | null;
  /** The step's output, in the verification's directory. */
  log: string;
  tests: TestCounts | null;
  /** Why it failed beyond the exit code: a timeout, a missing binary. */
  detail: string | null;
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
}

export interface Verification extends Omit<VerificationRow, "steps" | "tests"> {
  steps: VerifyStep[];
  tests: TestCounts | null;
}

export function parseVerification(row: VerificationRow): Verification {
  return { ...row, steps: JSON.parse(row.steps) as VerifyStep[], tests: row.tests ? (JSON.parse(row.tests) as TestCounts) : null };
}

export function getVerification(db: Db, id: string): Verification | null {
  const row = db.query("SELECT * FROM verifications WHERE id = ?1").get(id) as VerificationRow | null;
  return row ? parseVerification(row) : null;
}

export function runningVerifications(db: Db): Verification[] {
  return (db.query("SELECT * FROM verifications WHERE state = 'running' ORDER BY started_at").all() as VerificationRow[]).map(parseVerification);
}

/** The newest finished verification of this PR at exactly this head. */
export function finishedAtHead(db: Db, prUrl: string, head: string): Verification | null {
  const row = db.query("SELECT * FROM verifications WHERE pr_url = ?1 AND head_sha = ?2 AND state <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(prUrl, head) as VerificationRow | null;
  return row ? parseVerification(row) : null;
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
  dir: (id: string) => string;
  worktree: (id: string) => string;
  project_path: string;
  source: EventSource;
  now: number;
}

/** Insert a running verification and its event. Call inside a transaction. */
export function insertVerification(db: Db, v: NewVerification): Verification {
  const next = Number(getMeta(db, "next_verify_no") ?? "1");
  setMeta(db, "next_verify_no", String(next + 1));
  const id = `v${next}`;
  db.query(
    `INSERT INTO verifications (id, project_id, pr_url, task_id, head_sha, state, steps, dir, worktree_path, project_path, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8, ?9, ?10)`,
  ).run(id, v.project_id, v.pr_url, v.task_id, v.head_sha, JSON.stringify(v.steps), v.dir(id), v.worktree(id), v.project_path, v.now);
  appendEvent(db, {
    source: v.source,
    kind: "pr.verify_started",
    taskId: v.task_id,
    payload: { verification: id, project: v.project_id, pr: v.pr_url, head: v.head_sha, steps: v.steps.map((s) => s.name) },
    ts: v.now,
  });
  return getVerification(db, id)!;
}

/** Record the steps as they stand now (a step began or ended). Call inside a transaction. */
export function recordSteps(db: Db, v: Verification, steps: VerifyStep[], ended: VerifyStep | null, now: number): void {
  db.query("UPDATE verifications SET steps = ?2 WHERE id = ?1 AND state = 'running'").run(v.id, JSON.stringify(steps));
  appendEvent(db, {
    source: "daemon",
    kind: "pr.verify_step",
    taskId: v.task_id,
    payload: { verification: v.id, step: (ended ?? steps.find((s) => s.state === "running"))?.name ?? null, state: ended?.state ?? "running", exit: ended?.exit ?? null, ms: ended?.ms ?? null },
    ts: now,
  });
}

export interface VerificationOutcome {
  state: Exclude<VerificationState, "running">;
  steps: VerifyStep[];
  tests: TestCounts | null;
  detail: string | null;
  binary: string | null;
}

/** Finish a verification with its `pr.verified` event. Call inside a transaction; a row already finished is left alone. */
export function finishVerification(db: Db, v: Verification, outcome: VerificationOutcome, now: number): boolean {
  const changed = db
    .query("UPDATE verifications SET state = ?2, steps = ?3, tests = ?4, detail = ?5, binary_path = ?6, finished_at = ?7 WHERE id = ?1 AND state = 'running'")
    .run(v.id, outcome.state, JSON.stringify(outcome.steps), outcome.tests ? JSON.stringify(outcome.tests) : null, outcome.detail, outcome.binary, now).changes;
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
      state: outcome.state,
      ok: outcome.state === "passed",
      steps: outcome.steps.map((s) => ({ name: s.name, state: s.state, exit: s.exit, ms: s.ms })),
      tests: outcome.tests,
      duration_ms: now - v.started_at,
      binary: outcome.binary,
      detail: outcome.detail,
    },
    ts: now,
  });
  return true;
}

/** "v4 passed at fc2f76d7 (1843 pass, 0 fail)", for `show` and the gate's messages. */
export function verificationLine(v: Verification): string {
  const tests = v.tests ? ` (${v.tests.pass} pass, ${v.tests.fail} fail)` : "";
  return `${v.id} ${v.state} at ${v.head_sha.slice(0, 8)}${tests}`;
}
