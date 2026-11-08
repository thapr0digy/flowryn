import type { FlowrynConfig } from "../config/config.ts";
import { mergeConfig, type MergeConfig } from "../config/merge.ts";
import { askConfig } from "../config/ask.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { approvalRef, deliveredOf, prEvidence, type Delivered } from "../lifecycle/delivery.ts";
import { getRunWithPolicy, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { consumeApproval, insertApproval, type ApprovalRow } from "../policy/approvals.ts";
import { AUTONOMY_MAX_MS, autonomyForRun } from "../policy/autonomy.ts";
import { createAutoMerge, liveAutoMerge, supersedeAutoMerge } from "../verify/auto-merge.ts";
import { landingQueued, verifyConfig } from "../verify/config.ts";
import { leaveLanding, liveLanding, MAX_INTEGRATIONS } from "../verify/landing-queue.ts";
import { verifyPolicyId } from "../verify/policy.ts";
import { finishedAtHead } from "../verify/store.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { userStartedAway, type AwayPosture } from "./away.ts";
import type { DecisionsConfig } from "./decisions-policy.ts";
import {
  finishValidation,
  launchValidation,
  nextValidationId,
  parseValidatorReply,
  validationsInFlight,
  validatorAction,
  type Applied,
  type ApplyValidation,
  type PickedValidation,
  type ValidatorDeps,
} from "./gate-validator.ts";
import { openItem, resolveRunItems } from "./items.ts";
import { getValidation, type ValidationRow, type ValidatorFinding, type ValidatorVerdict } from "./validator-report.ts";

/**
 * Sensitive merges while you are away (docs/notes/2026-11-08-merge-sensitive-prs-rr.md). With
 * `[merge] sensitive_when_away = true`, during an away the user started themselves
 * (userStartedAway: `flowryn away` in their terminal, or their chat confirmation), a delivered
 * sensitive ship in a yolo project whose local verify passed at exactly the delivered head gets
 * one merge round of the review-gate validator (src/attention/gate-validator.ts): the brief, the
 * approved spec and the diff at that head. On pass the daemon records an approval on channel
 * `away-validator` bound to that head; the merge itself is the merge verb's own path, with every
 * gate it runs today (src/policy/merge.ts takes the record only while the same away is on). On
 * changes the findings go back to the worker. Anything else leaves the PR waiting for
 * `flowryn approve`, with an item saying why.
 *
 * The validator's verdict is the only model use: whether a diff does what a brief asks is
 * judgement. The trigger, eligibility (awayMergeRefusal), the record, the live check
 * (awayApprovalLive), the stop when the away ends (stopAwayMerges) and the merge are plain code.
 */

export const AWAY_VALIDATOR_CHANNEL = "away-validator";
/** The stage a merge round records in gate_validations: no review gate is named so. */
export const MERGE_STAGE = "merge";
/** Passes per task per away: the landing queue moves the head at most MAX_INTEGRATIONS times, and each new head is judged again. A function, so a module cycle never reads it early. */
export function maxMergePasses(): number {
  return MAX_INTEGRATIONS + 1;
}

// --- pure checks ---------------------------------------------------------------------------------

/** What eligibility reads, gathered beforehand so the check itself is pure. */
export interface AwayMergeFacts {
  /** `[merge] sensitive_when_away`. */
  enabled: boolean;
  /** The away the user started themselves, live now, or null. */
  away: Pick<AwayPosture, "since"> | null;
  run: Pick<RunWithPolicy, "kind" | "state" | "sensitive" | "stacked_on"> | null;
  /** The task's policy is yolo: only the sensitive rule stands between it and a merge. */
  yolo: boolean;
  /** A live unattended-mode grant covers the run: its own pass merges it. */
  autonomyCovered: boolean;
  delivered: Pick<Delivered, "head"> | null;
  /** The PR head GitHub last showed; null when no evidence was recorded or the work is local-only. */
  prHead: string | null;
  /** The worktree HEAD; undefined while it has not been read (only an otherwise eligible run costs a git call). */
  worktreeHead?: string | null;
  /** The newest finished verify at exactly the delivered head, under today's policy. */
  verify: "passed" | "failed" | "none" | "no_steps";
  /** Another merge round of this task is running. */
  running: boolean;
  /** A merge round of this task under this away ended held. */
  held: boolean;
  /** Merge rounds of this task under this away that did not pass (changes, no verdict, advice). */
  stopped: number;
  /** Merge rounds of this task under this away that passed. */
  passed: number;
  /** An unused away-validator approval already binds the delivered head. */
  approvedAtHead: boolean;
}

/** Why no merge round may start for this run now, or null when one may. Pure. */
export function awayMergeRefusal(f: AwayMergeFacts, cfg: Pick<DecisionsConfig, "validator_rounds">): string | null {
  if (!f.enabled) return "[merge] sensitive_when_away is off";
  if (f.away === null) return "the user has not started away themselves";
  if (!f.run) return "no run";
  if (f.run.kind !== "ship") return "not a ship";
  if (f.run.sensitive !== 1) return "not sensitive";
  if (!f.yolo) return "its project merges only with your approval (not yolo)";
  if (f.autonomyCovered) return "unattended mode covers its run";
  if (f.run.state !== "ready") return `the run is ${f.run.state}, not ready`;
  if (f.run.stacked_on) return "stacked on a task that has not landed";
  if (!f.delivered) return "nothing delivered";
  if (f.verify === "no_steps") return "its project has no verify steps";
  if (f.verify !== "passed") return f.verify === "failed" ? "verify did not pass at this head" : "no verify has passed at this head yet";
  if (f.prHead !== null && f.prHead !== f.delivered.head) return "the PR head on GitHub is not the delivered head";
  if (f.worktreeHead !== undefined && f.worktreeHead !== f.delivered.head) return "the worktree head is not the delivered head";
  if (f.approvedAtHead) return "already approved at this head";
  if (f.running) return "a merge round is already running";
  if (f.held) return "a merge round under this away held it for you";
  if (f.stopped >= cfg.validator_rounds) return `${f.stopped} merge rounds did not pass under this away`;
  if (f.passed >= maxMergePasses()) return `${f.passed} merge rounds passed under this away without a merge`;
  return null;
}

/**
 * Whether an away-validator approval may still be used: an away the user started is on, it is the
 * away the round ran under, the round started after that away began, passed, and judged exactly
 * the head about to merge. Pure.
 */
export function awayApprovalLive(input: {
  away: Pick<AwayPosture, "since"> | null;
  validation: Pick<ValidationRow, "stage" | "state" | "away_since" | "started_at" | "head"> | null;
  head: string;
}): boolean {
  const { away, validation: v } = input;
  if (away === null || v === null) return false;
  return v.stage === MERGE_STAGE && v.state === "passed" && v.away_since === away.since && v.started_at >= away.since && v.head === input.head;
}

// --- facts and records ---------------------------------------------------------------------------

function verifyAt(db: Db, config: FlowrynConfig, run: RunWithPolicy, ref: string, head: string): AwayMergeFacts["verify"] {
  let policy: string;
  try {
    const steps = verifyConfig(config, run.project_id);
    if (!steps) return "no_steps";
    policy = verifyPolicyId(steps);
  } catch {
    return "no_steps";
  }
  const v = finishedAtHead(db, ref, head, policy);
  return v === null ? "none" : v.state === "passed" ? "passed" : "failed";
}

function count(db: Db, taskId: string, awaySince: number, states: string[], except: string | null): number {
  return (
    db
      .query(`SELECT COUNT(*) AS n FROM gate_validations WHERE task_id = ?1 AND stage = '${MERGE_STAGE}' AND away_since = ?2 AND id IS NOT ?3 AND state IN (${states.map((s) => `'${s}'`).join(",")})`)
      .get(taskId, awaySince, except) as { n: number }
  ).n;
}

/** The unused away-validator approvals of a task (or of every task), newest first. */
export function awayApprovals(db: Db, taskId: string | null = null): ApprovalRow[] {
  return db
    .query(`SELECT * FROM approvals WHERE channel = '${AWAY_VALIDATOR_CHANNEL}' AND consumed_at IS NULL AND (?1 IS NULL OR task_id = ?1) ORDER BY created_at DESC, id DESC`)
    .all(taskId) as ApprovalRow[];
}

/** The merge round an away-validator approval came from: its actor names it (`validator j<N> …`). */
export function validationOfApproval(db: Db, row: Pick<ApprovalRow, "actor">): ValidationRow | null {
  const id = /^validator (j\d+)\b/.exec(row.actor)?.[1];
  return id ? getValidation(db, id) : null;
}

/**
 * The away-validator approval the merge gate may take for exactly this head, or null: unused,
 * unexpired, bound to this task, ref and head, and still live (awayApprovalLive).
 */
export function findAwayApproval(db: Db, q: { task: string; ref: string; head: string; now: number }): ApprovalRow | null {
  const away = userStartedAway(db, q.now);
  for (const row of awayApprovals(db, q.task)) {
    if (row.pr_url !== q.ref || row.head_sha !== q.head || row.expires_at <= q.now || row.action !== "merge") continue;
    if (awayApprovalLive({ away, validation: validationOfApproval(db, row), head: q.head })) return row;
  }
  return null;
}

/** Every fact awayMergeRefusal reads. `except` leaves the round being checked out of the counts. */
export function awayMergeFacts(db: Db, input: { config: FlowrynConfig; merge: MergeConfig; run: RunWithPolicy | null; now: number; worktreeHead?: string | null; except?: string | null }): AwayMergeFacts {
  const { run, now, config } = input;
  const except = input.except ?? null;
  const away = userStartedAway(db, now);
  const delivered = run ? deliveredOf(db, run.task_id) : null;
  const ref = delivered ? approvalRef(delivered) : null;
  const yolo = run ? (db.query("SELECT yolo FROM task_policy WHERE task_id = ?1").get(run.task_id) as { yolo: number } | null)?.yolo === 1 : false;
  const evidence = run && delivered?.kind === "pr" ? prEvidence(db, run.id) : null;
  return {
    enabled: input.merge.sensitive_when_away,
    away,
    run,
    yolo,
    autonomyCovered: run !== null && autonomyForRun(db, run, now) !== null,
    delivered,
    prHead: evidence?.head ?? null,
    ...(input.worktreeHead === undefined ? {} : { worktreeHead: input.worktreeHead }),
    verify: run && delivered && ref ? verifyAt(db, config, run, ref, delivered.head) : "none",
    running: run !== null && db.query(`SELECT 1 FROM gate_validations WHERE task_id = ?1 AND stage = '${MERGE_STAGE}' AND state = 'running' AND id IS NOT ?2`).get(run.task_id, except) !== null,
    held: run !== null && away !== null && count(db, run.task_id, away.since, ["held"], except) > 0,
    stopped: run && away ? count(db, run.task_id, away.since, ["changes", "failed", "advised"], except) : 0,
    passed: run && away ? count(db, run.task_id, away.since, ["passed"], except) : 0,
    approvedAtHead: run !== null && delivered !== null && ref !== null && awayApprovals(db, run.task_id).some((a) => a.pr_url === ref && a.head_sha === delivered.head),
  };
}

function safeMergeConfig(config: FlowrynConfig): MergeConfig {
  try {
    return mergeConfig(config);
  } catch {
    // The daemon refuses an invalid config at start and on SIGHUP; a table it cannot read merges nothing.
    return { sensitive_when_away: false };
  }
}

/** Ready sensitive ships, oldest first: the only runs a merge round can be for. */
function candidateRuns(db: Db): RunWithPolicy[] {
  const ids = db.query("SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id WHERE r.state = 'ready' AND p.sensitive = 1 ORDER BY r.updated_at, r.id").all() as { id: string }[];
  return ids.map(({ id }) => getRunWithPolicy(db, id)).filter((r): r is RunWithPolicy => r !== null);
}

/**
 * Record a merge round for each eligible run (event `validator.started`), at most `limit` less the
 * calls in flight. `heads` holds each candidate's worktree HEAD, read before the transaction.
 * Call inside a transaction.
 */
export function pickMergeValidations(
  db: Db,
  input: { config: FlowrynConfig; merge: MergeConfig; cfg: DecisionsConfig; now: number; heads: ReadonlyMap<string, string>; inFlight: ReadonlySet<string>; limit: number },
): PickedValidation[] {
  const { now } = input;
  const away = userStartedAway(db, now);
  if (!input.merge.sensitive_when_away || !away) return [];
  const free = input.limit - input.inFlight.size;
  const picked: PickedValidation[] = [];
  for (const run of candidateRuns(db)) {
    if (picked.length >= free) break;
    const head = input.heads.get(run.id);
    if (!head) continue;
    if (awayMergeRefusal(awayMergeFacts(db, { config: input.config, merge: input.merge, run, now, worktreeHead: head }), input.cfg) !== null) continue;
    const delivered = deliveredOf(db, run.task_id)!;
    const ref = approvalRef(delivered);
    const id = nextValidationId(db);
    db.query(
      `INSERT INTO gate_validations (id, gate_id, run_id, task_id, stage, away_since, head, state, waited_ms, started_at, ref)
       VALUES (?1, NULL, ?2, ?3, '${MERGE_STAGE}', ?4, ?5, 'running', ?6, ?7, ?8)`,
    ).run(id, run.id, run.task_id, away.since, head, Math.max(0, now - delivered.at), now, ref);
    appendEvent(db, { source: "daemon", kind: "validator.started", runId: run.id, taskId: run.task_id, payload: { validation: id, gate: null, stage: MERGE_STAGE, head, ref, waited_ms: Math.max(0, now - delivered.at) }, ts: now });
    picked.push({ id, gate: null, run, head, ref });
  }
  return picked;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function findingLine(f: ValidatorFinding, i: number): string {
  const where = [f.requirement ? `requirement: ${f.requirement}` : null, f.file ? `file: ${f.file}` : null].filter(Boolean).join("; ");
  return `${i + 1}. (${where}) ${f.problem} Fix: ${f.fix}`;
}

/** The words the worker gets when a merge round asks for changes. */
export function mergeChangesWords(id: string, verdict: ValidatorVerdict): string {
  return sanitizeBlock(
    [
      `The independent validator (${id}) checked this PR against the brief, the spec and the code before merging it while the user was away, and asks for these changes. Fix them with new commits, then deliver again:`,
      ...verdict.findings.map(findingLine),
    ].join("\n"),
  );
}

function item(db: Db, row: ValidationRow, kind: "validator_failed" | "validator_advice", line: string, now: number): void {
  const { seq } = appendEvent(db, { source: "daemon", kind: "validator.item", runId: row.run_id, taskId: row.task_id, payload: { validation: row.id }, ts: now });
  openItem(db, { kind, eventSeq: seq, taskId: row.task_id, runId: row.run_id, line, now });
}

/**
 * Record a finished merge round and act on it: re-read every fact, then mint the approval and
 * start the merge, send the findings back, fail or advise (validatorAction). `headNow` is the
 * worktree HEAD read after the call (null: unreadable, which counts as moved). Call inside a
 * transaction; the caller notifies the run and kicks the scheduler.
 */
export function applyMergeValidation(db: Db, input: { id: string; result: Parameters<ApplyValidation>[1]["result"]; headNow: string | null; cfg: DecisionsConfig; config: FlowrynConfig; now: number; reportPath: string | null }): Applied | null {
  const { now, config } = input;
  const row = getValidation(db, input.id);
  if (!row || row.state !== "running" || row.stage !== MERGE_STAGE) return null;
  const run = getRunWithPolicy(db, row.run_id);
  const facts = awayMergeFacts(db, { config, merge: safeMergeConfig(config), run, now, worktreeHead: input.headNow, except: row.id });
  const verdict = input.result.reply === null ? null : parseValidatorReply(input.result.reply, []);
  const failure = input.result.reply === null ? input.result.reason : verdict === null ? "the reply did not follow the schema (no verdict)" : null;
  const away = userStartedAway(db, now);
  const headMoved = input.headNow !== row.head || facts.delivered?.head !== row.head;
  // A moved head is its own reason; eligibility is asked of the head the round judged.
  const refusal = headMoved ? null : awayMergeRefusal(facts, input.cfg);
  const action = validatorAction({ verdict, failure, refusal, awayChanged: away === null || away.since !== row.away_since, headMoved });
  const base = { verdict, costUsd: input.result.costUsd, now, reportPath: input.reportPath };
  const title = sanitizeLine(taskTitle(db, row.task_id), 60);
  const showLine = `flowryn show ${row.id}`;
  if (action.action === "fail") {
    finishValidation(db, row, { ...base, state: "failed", reason: action.why });
    item(db, row, "validator_failed", `The validator (${row.id}) gave no verdict on merging ${title} (${row.task_id}): ${sanitizeLine(action.why, 160)}; the PR waits for your approval (${showLine})`, now);
    return { validation: row.id, run: row.run_id, state: "failed" };
  }
  if (action.action === "advise") {
    finishValidation(db, row, { ...base, state: "advised", reason: action.why });
    item(db, row, "validator_advice", `The validator (${row.id}) says ${verdict!.verdict} for merging ${title} (${row.task_id}), but did not act: ${sanitizeLine(action.why, 120)}. The PR waits for your approval; its advice: ${showLine}`, now);
    return { validation: row.id, run: row.run_id, state: "advised" };
  }
  if (action.action === "changes") {
    finishValidation(db, row, { ...base, state: "changes", reason: `${verdict!.findings.length} finding(s)` });
    supersedeAutoMerge(db, run!.id, "sent_back", `the validator ${row.id} asked for changes`, now);
    const landing = liveLanding(db, run!.id);
    if (landing) leaveLanding(db, landing, "sent_back", `the validator ${row.id} asked for changes`, now);
    sendBack(
      db,
      run!,
      {
        text: mergeChangesWords(row.id, verdict!),
        feedback: `the validator ${row.id} asked for changes before merging`,
        why: `the validator ${row.id} asked for changes`,
        event: { source: "daemon", kind: "away_merge.sent_back", payload: { validation: row.id, findings: verdict!.findings.length, by: `validator ${row.id}` } },
      },
      now,
    );
    return { validation: row.id, run: row.run_id, state: "changes" };
  }
  finishValidation(db, row, { ...base, state: "passed", reason: null });
  const delivered = deliveredOf(db, run!.task_id)!;
  const ref = approvalRef(delivered);
  const approval = insertApproval(db, {
    task: run!.task_id,
    ref,
    head: row.head,
    channel: AWAY_VALIDATOR_CHANNEL,
    actor: `validator ${row.id} (away since ${hhmm(away!.since)}, started by ${away!.by})`,
    action: "merge",
    now,
  });
  // It lasts while the away does, and the merge gate checks the away again at every use.
  const until = Math.min(away!.until, now + AUTONOMY_MAX_MS);
  db.query("UPDATE approvals SET expires_at = ?2 WHERE id = ?1").run(approval.id, until);
  appendEvent(db, { source: "daemon", kind: "away_merge.approved", runId: run!.id, taskId: run!.task_id, payload: { validation: row.id, approval: approval.id, ref, head: row.head, away_since: away!.since, by: away!.by }, ts: now });
  // A landing that left for want of an approval waits no longer.
  resolveRunItems(db, run!.id, ["auto_merge_held"], "away_merge.approved", now);
  if (!landingQueued(config, run!.project_id)) {
    // The delivery's auto-verify gives way to the merge, which follows its passed verify.
    if (liveAutoMerge(db, run!.id)?.merge !== 1) {
      supersedeAutoMerge(db, run!.id, "away_merge", `the validator ${row.id} passed it while you are away`, now);
      const evidence = delivered.kind === "pr" ? prEvidence(db, run!.id) : null;
      createAutoMerge(db, config, run!, { ref, head: row.head, prNumber: evidence?.number ?? null, headRef: evidence?.head_ref ?? (delivered.kind === "pr" ? run!.branch : null), worktree: delivered.kind === "local" ? run!.worktree_path : null, source: "daemon" }, now);
    }
  }
  return { validation: row.id, run: row.run_id, state: "passed" };
}

/**
 * Void every unused away-validator approval that is no longer live (`keepLive`), or all of them,
 * and stop what it would have merged: a direct auto-merge not yet merging is superseded, a landing
 * entry leaves the line. A merge already asked of GitHub has used its approval and finishes.
 * Returns the tasks stopped. Call inside a transaction.
 */
export function stopAwayMerges(db: Db, input: { now: number; why: string; keepLive: boolean }): string[] {
  const { now } = input;
  const away = input.keepLive ? userStartedAway(db, now) : null;
  const stopped: string[] = [];
  for (const row of awayApprovals(db)) {
    if (input.keepLive && awayApprovalLive({ away, validation: validationOfApproval(db, row), head: row.head_sha })) continue;
    consumeApproval(db, row.id, now, input.why);
    const run = db.query("SELECT id FROM runs WHERE task_id = ?1 AND state IN ('ready','merging') ORDER BY started_at DESC LIMIT 1").get(row.task_id) as { id: string } | null;
    if (run) {
      const landing = liveLanding(db, run.id);
      const auto = liveAutoMerge(db, run.id);
      if (landing && landing.approval_id === row.id && auto?.state !== "merging") leaveLanding(db, landing, "user_back", `${input.why}: it waits for your approval`, now);
      else if (auto && auto.merge === 1 && auto.state !== "merging" && auto.head_sha === row.head_sha) supersedeAutoMerge(db, run.id, "user_back", `${input.why}: it waits for your approval`, now);
    }
    appendEvent(db, { source: "daemon", kind: "away_merge.stopped", runId: run?.id ?? null, taskId: row.task_id, payload: { approval: row.id, head: row.head_sha, why: input.why }, ts: now });
    stopped.push(row.task_id);
  }
  return stopped;
}

// --- the daemon's pass ---------------------------------------------------------------------------

/**
 * One pass, on the attention tick after the review-gate validator: stop what a finished or changed
 * away no longer covers, then pick what is due and start each call in the background (sharing
 * `[ask] max_concurrent` with the review rounds). Off, with nothing read beyond the config and the
 * away, while the key is off or no away the user started is on.
 */
export async function awayMergePass(deps: ValidatorDeps): Promise<string[]> {
  const config = deps.config();
  const merge = safeMergeConfig(config);
  const cfg = deps.decisions();
  const away = userStartedAway(deps.db, deps.now());
  tx(deps.db, () => stopAwayMerges(deps.db, { now: deps.now(), why: !merge.sensitive_when_away ? "[merge] sensitive_when_away was turned off" : away ? "the away changed" : "you came back", keepLive: merge.sensitive_when_away }));
  if (!merge.sensitive_when_away || !away) return [];
  const heads = new Map<string, string>();
  for (const run of candidateRuns(deps.db)) {
    // Only an otherwise eligible run costs a git call (the pick checks it again in its transaction).
    if (awayMergeRefusal(awayMergeFacts(deps.db, { config, merge, run, now: deps.now() }), cfg) !== null) continue;
    const result = await deps.git(["rev-parse", "HEAD"], run.worktree_path);
    const head = result.code === 0 ? result.stdout.trim() : "";
    if (head) heads.set(run.id, head);
  }
  if (heads.size === 0) return [];
  const picked = tx(deps.db, () => pickMergeValidations(deps.db, { config, merge, cfg, now: deps.now(), heads, inFlight: validationsInFlight(), limit: askConfig(config).max_concurrent }));
  const apply: ApplyValidation = (db, input) => applyMergeValidation(db, { ...input, config: deps.config() });
  for (const p of picked) {
    launchValidation(deps, p, cfg, apply);
    deps.log(`validator: ${p.id} started on the merge of ${p.run.task_id} at ${p.head.slice(0, 8)}`);
  }
  return picked.map((p) => p.id);
}
