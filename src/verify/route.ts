import { join } from "node:path";
import { openItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { getRunWithPolicy, isTerminal, openRunForTask, openRunItemOnce, taskTitle, type RunRow } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { createSteer } from "../lifecycle/steers.ts";
import { redactSecrets } from "../util/redact.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { REVIEW_STEP, verifyConfig } from "./config.ts";
import { verifyPolicyId } from "./policy.ts";
import { findQueued, insertRequest, requestOf, type VerifyRequest } from "./queue.ts";
import { endedAtDeadline, readTail, REVIEW_NO_VERDICT } from "./runner.ts";
import { getVerification, interruptedByStop, parseVerification, type Verification, type VerificationRow, type VerifyStep } from "./store.ts";

/**
 * Verify failures route themselves (task no-idle-workers-23, phase 3;
 * docs/notes/2026-11-06-no-idle-workers-23.md). One verdict for every verify
 * that did not pass, whoever started it: the auto-merge (and the landing queue
 * it carries), and a leader's own `flowryn verify` (routeManualVerifies).
 *
 * - A step killed at a deadline (its own hang, or the run's) is run once more
 *   at the same head (`verify.auto_rerun`); a second timeout there goes to the
 *   leader.
 * - A step that exited non-zero is the worker's to fix: sent back with the
 *   step, its exit, its log and its last 40 lines, control characters
 *   stripped and secrets redacted (`verify.sent_back`).
 * - The same head failing after a send-back, the same step failing after a
 *   send-back at an earlier head, or a fourth send-back in one run goes to the
 *   leader (`verify.escalated`), as does an error, a review with no verdict,
 *   and a failure with no failing step.
 *
 * Plain rules over the verifications table and events; no model.
 */

export const AUTO_RERUN_KIND = "verify.auto_rerun";
export const SENT_BACK_KIND = "verify.sent_back";
export const ESCALATED_KIND = "verify.escalated";
/** A leader's failed verify the router left alone (superseded, its run moved on); one per verification, so it is judged once. */
export const ROUTE_SKIPPED_KIND = "verify.route_skipped";

/** Send-backs for failed verifies one run gets; the next failure goes to the leader. */
export const MAX_VERIFY_SEND_BACKS = 3;
/** Lines of a failed step's output a send-back carries. */
export const SEND_BACK_TAIL_LINES = 40;
/** How much of a step's log a send-back reads. */
export const SEND_BACK_TAIL_BYTES = 16 * 1024;
/** How much of an escalation's reason its item line keeps. */
const ITEM_DETAIL_CHARS = 120;

export type EscalateCode = "verify_failed" | "verify_timeout" | "verify_error";

/** What a finished verify that did not pass leads to. */
export type VerifyRoute =
  | { route: "none"; why: string }
  | { route: "rerun"; step: VerifyStep }
  | { route: "send_back"; step: VerifyStep }
  | { route: "escalate"; code: EscalateCode; detail: string; step: VerifyStep | null };

/** How a finished verify that did not pass ends, judged on the verification alone. */
export type VerifyVerdict = { sendBack: VerifyStep } | { rerun: VerifyStep } | { hold: EscalateCode; detail: string };

/**
 * The verification alone: a step that exited non-zero is the worker's to
 * fix, a step killed at a deadline is worth one more run, and an error, a
 * review with no verdict or a failure with no failing step is the leader's.
 */
export function verifyVerdict(v: Verification): VerifyVerdict {
  if (v.state === "error") return { hold: "verify_error", detail: `verify ${v.id} ended in an error: ${v.detail ?? "no detail"}` };
  const step = v.steps.find((s) => s.state === "failed");
  // A review with no verdict (its call failed or went over its cap) is not the worker's to fix.
  if (step && step.name === REVIEW_STEP && step.exit === REVIEW_NO_VERDICT && !endedAtDeadline(step)) return { hold: "verify_error", detail: `verify ${v.id}: ${step.detail ?? "the review gave no verdict"}` };
  if (step && endedAtDeadline(step)) return { rerun: step };
  if (!step || step.exit === null || step.exit === 0) return { hold: "verify_failed", detail: `verify ${v.id} failed: ${v.detail ?? step?.detail ?? "no failing step recorded"}` };
  return { sendBack: step };
}

/** Whether a verify of this ref and head was already run again automatically. */
export function autoRerunAt(db: Db, ref: string, head: string): boolean {
  return !!db
    .query(`SELECT 1 FROM events WHERE kind = '${AUTO_RERUN_KIND}' AND json_extract(payload, '$.ref') = ?1 AND json_extract(payload, '$.head') = ?2 LIMIT 1`)
    .get(ref, head);
}

/** The run's verify send-backs so far, oldest first: which step, at which head. */
export function verifySendBacks(db: Db, runId: string): { step: string; head: string; verification: string }[] {
  return db
    .query(
      `SELECT json_extract(payload, '$.step') AS step, json_extract(payload, '$.head') AS head, json_extract(payload, '$.verification') AS verification
         FROM events WHERE run_id = ?1 AND kind = '${SENT_BACK_KIND}' ORDER BY seq`,
    )
    .all(runId) as { step: string; head: string; verification: string }[];
}

/** Auto-merge rows sent back at this head before verify.sent_back existed: they count as a send-back there. */
function legacySentBackAt(db: Db, runId: string, head: string): boolean {
  return !!db.query("SELECT 1 FROM auto_merges WHERE run_id = ?1 AND head_sha = ?2 AND state = 'sent_back' LIMIT 1").get(runId, head);
}

/**
 * The route for a finished verify `v` of `run`'s work (null: no live run).
 * Reads only; the caller acts on it in the same transaction.
 */
export function routeVerifyOutcome(db: Db, v: Verification, run: Pick<RunRow, "id" | "state"> | null): VerifyRoute {
  if (v.state === "passed" || v.state === "running") return { route: "none", why: `verify ${v.id} is ${v.state}` };
  const verdict = verifyVerdict(v);
  if ("hold" in verdict) return { route: "escalate", code: verdict.hold, detail: verdict.detail, step: null };
  if ("rerun" in verdict) {
    if (autoRerunAt(db, v.pr_url, v.head_sha)) return { route: "escalate", code: "verify_timeout", detail: `verify ${v.id} timed out in \`${verdict.rerun.name}\` again after one automatic re-run at ${v.head_sha.slice(0, 8)}`, step: verdict.rerun };
    return { route: "rerun", step: verdict.rerun };
  }
  const step = verdict.sendBack;
  const failed = `verify ${v.id} failed at ${v.head_sha.slice(0, 8)} (\`${step.name}\` exited ${step.exit})`;
  if (!run || isTerminal(run.state as RunRow["state"])) return { route: "escalate", code: "verify_failed", detail: `${failed}, and its run is ${run ? run.state : "gone"}`, step };
  const prior = verifySendBacks(db, run.id);
  if (prior.some((p) => p.head === v.head_sha) || legacySentBackAt(db, run.id, v.head_sha)) return { route: "escalate", code: "verify_failed", detail: `verify ${v.id} failed again at ${v.head_sha.slice(0, 8)} (\`${step.name}\` exited ${step.exit}) after a send-back`, step };
  const same = prior.find((p) => p.step === step.name);
  if (same) return { route: "escalate", code: "verify_failed", detail: `${failed}: the same step failed after its send-back at ${same.head.slice(0, 8)}`, step };
  if (prior.length >= MAX_VERIFY_SEND_BACKS) return { route: "escalate", code: "verify_failed", detail: `${failed} after ${prior.length} verify send-backs in this run`, step };
  return { route: "send_back", step };
}

/** A step's log tail fit for a steer: at most 16 KiB read, control characters stripped, secrets redacted, the last `lines` lines. */
export function cleanTail(path: string, lines = SEND_BACK_TAIL_LINES): string {
  const block = redactSecrets(sanitizeBlock(readTail(path, SEND_BACK_TAIL_BYTES)));
  return block.trimEnd().split("\n").slice(-lines).join("\n");
}

/** The steer a failed verify sends its worker: the step, its exit, its log, and its last lines. */
export function sendBackText(v: Verification, step: VerifyStep, label = "Auto-merge"): string {
  const log = join(v.dir, step.log);
  const after = "A second failure at the same head, or this step failing again, goes to your leader instead.";
  if (step.name === REVIEW_STEP) {
    const findings = redactSecrets(sanitizeBlock(readTail(log, SEND_BACK_TAIL_BYTES))).trimEnd();
    return [
      `${label}: the independent review in the daemon's flowryn verify ${v.id} of your delivery at ${v.head_sha.slice(0, 8)} failed it.`,
      findings ? `Its findings:\n\n${findings}\n` : "It gave no findings.",
      `Fix what holds up, commit, and deliver again; say in your handoff why a finding does not apply. ${after}`,
    ].join("\n");
  }
  const tail = cleanTail(log);
  return [
    `${label}: the daemon's flowryn verify ${v.id} of your work at ${v.head_sha.slice(0, 8)} failed: step \`${step.name}\` exited ${step.exit}. Its log: ${log}`,
    tail ? `Its last lines:\n\n${tail}\n` : "It printed nothing.",
    `Fix it, commit, and deliver again. ${after}`,
  ].join("\n");
}

/**
 * Queue one more verify of `v`'s head (the automatic re-run after a
 * timeout), as its own request was made (same PR, branch, worktree, PATH and
 * source), with its verify.auto_rerun event. A queued verify of that head is
 * joined instead. Throws with the reason when none can be queued (the project
 * has no verify steps now, its config is invalid). Call inside a transaction.
 */
export function queueAutoRerun(db: Db, config: FlowrynConfig, v: Verification, step: VerifyStep, runId: string | null, now: number): VerifyRequest {
  const verify = verifyConfig(config, v.project_id);
  if (!verify) throw new Error(`project ${v.project_id} has no verify steps now`);
  const policy = verifyPolicyId(verify);
  const from = requestOf(db, v.id);
  const request =
    findQueued(db, v.pr_url, v.head_sha, policy) ??
    insertRequest(db, {
      project_id: v.project_id,
      pr_url: v.pr_url,
      task_id: v.task_id,
      head_sha: v.head_sha,
      policy_id: policy,
      pr_number: from?.pr_number ?? null,
      head_ref: from?.head_ref ?? null,
      worktree: from?.worktree ?? null,
      source: from?.source === "cli" ? "cli" : "auto",
      path: from?.path ?? null,
      now,
    });
  appendEvent(db, {
    source: "daemon",
    kind: AUTO_RERUN_KIND,
    runId,
    taskId: v.task_id,
    payload: { of: v.id, step: step.name, ref: v.pr_url, head: v.head_sha, request: request.id, detail: step.detail },
    ts: now,
  });
  return request;
}

/** The verify.sent_back event's payload: what the router counts. */
export function sentBackPayload(v: Verification, step: VerifyStep, path: "auto_merge" | "manual", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { verification: v.id, step: step.name, exit: step.exit, head: v.head_sha, ref: v.pr_url, log: join(v.dir, step.log), path, ...extra };
}

/** The verify.escalated event. Call inside a transaction. */
export function recordEscalation(db: Db, v: Verification, route: Extract<VerifyRoute, { route: "escalate" }>, runId: string | null, path: "auto_merge" | "manual", now: number, extra: Record<string, unknown> = {}): number {
  return appendEvent(db, {
    source: "daemon",
    kind: ESCALATED_KIND,
    runId,
    taskId: v.task_id,
    payload: { verification: v.id, code: route.code, step: route.step?.name ?? null, head: v.head_sha, detail: route.detail, path, ...extra },
    ts: now,
  }).seq;
}

// --- a leader's own `flowryn verify` ------------------------------------------------------------

/** Where the manual router left off: the last finished_at it judged and the verifications judged at that instant. */
const MARK_KEY = "verify_route_mark";
/** On the first pass (no mark yet), how far back a failed verify is still judged. */
export const FIRST_PASS_LOOKBACK_MS = 15 * 60_000;

interface Mark {
  at: number;
  ids: string[];
}

function readMark(db: Db, now: number): Mark {
  const raw = getMeta(db, MARK_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Mark;
      if (typeof parsed.at === "number" && Array.isArray(parsed.ids)) return parsed;
    } catch {
      // A mark that does not parse starts again from the lookback, as a first pass does.
    }
  }
  return { at: now - FIRST_PASS_LOOKBACK_MS, ids: [] };
}

/** Whether a verification was started by a `flowryn verify` (directly, or a recovery's re-run of one). */
function startedByHand(db: Db, v: Verification): boolean {
  let request = requestOf(db, v.id);
  for (let hops = 0; request && hops < 5; hops++) {
    if (request.source === "cli") return true;
    if (request.source !== "recovered" || !request.recovered_from) return false;
    request = requestOf(db, request.recovered_from);
  }
  return false;
}

/** Why a leader's failed verify is not routed at all, or null when it is. */
function notRoutable(db: Db, v: Verification): string | null {
  if (!v.task_id) return "it has no task";
  if (v.state === "error" && interruptedByStop(v)) return "a daemon stop cut it off; startup recovery runs it again";
  const newer = db.query("SELECT id FROM verifications WHERE pr_url = ?1 AND started_at > ?2 AND id != ?3 LIMIT 1").get(v.pr_url, v.started_at, v.id) as { id: string } | null;
  if (newer) return `a later verify ${newer.id} of ${v.pr_url} followed it`;
  return null;
}

export interface ManualRouteDeps {
  db: Db;
  config(): FlowrynConfig;
  now(): number;
  log(message: string): void;
  /** A sent-back ship's last stage waits for a grant: the scheduler looks now. */
  kickScheduler(): void;
  /** A steer was made for this run: carry it now. */
  notify?(runId: string): void;
}

/** One leader-started verify judged, with its event, in one transaction. Returns the runs to notify. */
function routeOne(deps: ManualRouteDeps, v: Verification, now: number): { notify: string | null; kick: boolean } {
  const { db } = deps;
  const skip = (why: string) => {
    appendEvent(db, { source: "daemon", kind: ROUTE_SKIPPED_KIND, taskId: v.task_id, payload: { verification: v.id, why }, ts: now });
    return { notify: null, kick: false };
  };
  const unroutable = notRoutable(db, v);
  if (unroutable) return skip(unroutable);
  const task = v.task_id!;
  const run = openRunForTask(db, task);
  let route = routeVerifyOutcome(db, v, run);
  const delivered = deliveredOf(db, task);
  // The worker has redelivered past the verified head since: that delivery gets its own verify.
  if (run?.state === "ready" && delivered && delivered.head !== v.head_sha && route.route !== "escalate") return skip(`the run delivered ${delivered.head.slice(0, 8)} since`);
  if (route.route === "rerun") {
    try {
      queueAutoRerun(db, deps.config(), v, route.step, run?.id ?? null, now);
      return { notify: null, kick: true };
    } catch (error) {
      route = { route: "escalate", code: "verify_timeout", detail: `verify ${v.id} timed out in \`${route.step.name}\`, and no re-run could be queued: ${(error as Error).message}`, step: route.step };
    }
  }
  if (route.route === "send_back" && run && run.state !== "ready" && run.state !== "running") {
    route = { route: "escalate", code: "verify_failed", detail: `verify ${v.id} failed at ${v.head_sha.slice(0, 8)} (\`${route.step.name}\` exited ${route.step.exit}) while its run is ${run.state}`, step: route.step };
  }
  if (route.route === "send_back" && run) {
    const text = sendBackText(v, route.step, "Your leader's verify");
    if (run.state === "ready") {
      const full = getRunWithPolicy(db, run.id)!;
      sendBack(db, full, { text, feedback: `verify ${v.id} failed`, why: `verify ${v.id} failed`, event: { source: "daemon", kind: SENT_BACK_KIND, payload: sentBackPayload(v, route.step, "manual") } }, now);
      return { notify: null, kick: true };
    }
    const steer = createSteer(db, run, text, now);
    appendEvent(db, { source: "daemon", kind: SENT_BACK_KIND, runId: run.id, taskId: task, payload: sentBackPayload(v, route.step, "manual", { steer: steer.id }), ts: now });
    return { notify: run.id, kick: false };
  }
  if (route.route === "none") return skip(route.why);
  if (route.route !== "escalate") return skip(`no live run for ${task}`);
  return escalateManual(db, v, route, run, now);
}

/** A leader's failed verify sent to the leader: its verify.escalated event and a P1 verify_failed item. Call inside a transaction. */
function escalateManual(db: Db, v: Verification, route: Extract<VerifyRoute, { route: "escalate" }>, run: RunRow | null, now: number, extra: Record<string, unknown> = {}): { notify: null; kick: false } {
  const seq = recordEscalation(db, v, route, run?.id ?? null, "manual", now, extra);
  const what = v.task_id ? `${taskTitle(db, v.task_id)} (${v.task_id})` : v.pr_url;
  const line = `Verify failed: ${what}: ${sanitizeLine(route.detail, ITEM_DETAIL_CHARS)}; flowryn verify show ${v.id}`;
  if (run) openRunItemOnce(db, "verify_failed", run, seq, line, now);
  else openItem(db, { kind: "verify_failed", eventSeq: seq, taskId: v.task_id, line, now });
  return { notify: null, kick: false };
}

/** Routing a leader's failed verify threw: the leader hears of it, with the error, rather than nobody. Call inside a transaction. */
function escalateRouteError(db: Db, v: Verification, error: unknown, now: number): { notify: null; kick: false } {
  const message = error instanceof Error ? error.message : String(error);
  const code: EscalateCode = v.state === "error" ? "verify_error" : "verify_failed";
  const run = v.task_id ? openRunForTask(db, v.task_id) : null;
  return escalateManual(db, v, { route: "escalate", code, detail: `verify ${v.id} ${v.state} and routing it failed: ${message}`, step: null }, run, now, { route_error: message });
}

/** Whether a verification is already judged: an auto-merge row follows it, or either path recorded its routing event. */
function judgedElsewhere(db: Db, id: string): boolean {
  if (db.query("SELECT 1 FROM auto_merges WHERE verification_id = ?1").get(id)) return true;
  return !!db
    .query(
      `SELECT 1 FROM events WHERE (kind = '${AUTO_RERUN_KIND}' AND json_extract(payload, '$.of') = ?1)
          OR (kind IN ('${SENT_BACK_KIND}', '${ESCALATED_KIND}', '${ROUTE_SKIPPED_KIND}') AND json_extract(payload, '$.verification') = ?1)
        LIMIT 1`,
    )
    .get(id);
}

/**
 * Judge every leader-started verify that failed since the last pass (a
 * `flowryn verify`, not the auto-merge's own: that one is judged where its row
 * waits on it), each once. The auto-merger's pass calls it, so a finished
 * verify reaches it at once. Returns the verifications judged.
 */
export function routeManualVerifies(deps: ManualRouteDeps): string[] {
  const { db } = deps;
  const now = deps.now();
  const mark = readMark(db, now);
  const rows = (
    db
      .query(
        `SELECT * FROM verifications WHERE state IN ('failed', 'error') AND finished_at >= ?1
           AND NOT EXISTS (SELECT 1 FROM auto_merges a WHERE a.verification_id = verifications.id)
         ORDER BY finished_at, CAST(substr(id, 2) AS INTEGER)`,
      )
      .all(mark.at) as VerificationRow[]
  ).map(parseVerification);
  const judged: string[] = [];
  let at = mark.at;
  let ids = new Set(mark.ids);
  for (const v of rows) {
    const finished = v.finished_at ?? 0;
    if (finished === mark.at && mark.ids.includes(v.id)) continue;
    if (finished > at) {
      at = finished;
      ids = new Set();
    }
    ids.add(v.id);
    const judge = (route: (fresh: Verification) => { notify: string | null; kick: boolean }) =>
      tx(db, () => {
        const fresh = getVerification(db, v.id);
        if (!fresh || judgedElsewhere(db, v.id) || !startedByHand(db, fresh)) return null;
        return route(fresh);
      });
    let outcome: { notify: string | null; kick: boolean } | null = null;
    try {
      outcome = judge((fresh) => routeOne(deps, fresh, now));
    } catch (error) {
      deps.log(`verify route ${v.id}: ${(error as Error).stack ?? String(error)}`);
      try {
        outcome = judge((fresh) => escalateRouteError(db, fresh, error, now));
      } catch (again) {
        deps.log(`verify route ${v.id}: escalating the routing error failed: ${(again as Error).stack ?? String(again)}`);
      }
    }
    if (!outcome) continue;
    judged.push(v.id);
    if (outcome.notify) deps.notify?.(outcome.notify);
    if (outcome.kick) deps.kickScheduler();
  }
  if (rows.length > 0) setMetaTx(db, { at, ids: [...ids] });
  return judged;
}

function setMetaTx(db: Db, mark: Mark): void {
  tx(db, () => setMeta(db, MARK_KEY, JSON.stringify(mark)));
}
