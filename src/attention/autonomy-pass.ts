import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { docProblems } from "../lifecycle/brief.ts";
import { CI_WAIT_ORIGIN, declaresNoCi } from "../lifecycle/ci-wait.ts";
import { answerDecision } from "../lifecycle/decision-verbs.ts";
import type { DecisionRow } from "../lifecycle/decisions.ts";
import { deliveredOf, prEvidence } from "../lifecycle/delivery.ts";
import { requireDesignPinned } from "../lifecycle/design-spec.ts";
import { requireDraftPageShown } from "../lifecycle/draft.ts";
import { GATE_QUESTION_RESERVED } from "../lifecycle/gate-questions.ts";
import { dispatchedBody } from "../lifecycle/launcher.ts";
import { getProject } from "../lifecycle/projects.ts";
import { getRunWithPolicy, holdReason, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { openGate, runWorkflow, type GateRow } from "../lifecycle/stages.ts";
import { AUTONOMOUS_CHANNEL, autonomyActor, autonomyFor, liveAutonomy, projectsOf, type AutonomyRow } from "../policy/autonomy.ts";
import { recordGatePass } from "../policy/gates.ts";
import type { GitRunner } from "../policy/landed.ts";
import { createAutoMerge } from "../verify/auto-merge.ts";
import { landingQueued, verifyConfig } from "../verify/config.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { openItem, findOpenRunItem } from "./items.ts";
import { RESERVED_CLASSES, reservedReason, type DecisionsConfig } from "./decisions-policy.ts";

/**
 * Unattended mode's pass (docs/notes/2026-11-05-unattended-mode-one-9e.md), on the attention
 * tick while a standing approval is live (src/policy/autonomy.ts), for its projects only:
 *
 * - a worker question (and a review gate's) is answered with the worker's own
 *   recommendation, `answered_by = worker`, `via = autonomous`, with its why kept; a question
 *   of a protected kind (PARKING_CLASSES), one the worker marked for the user, a sensitive
 *   task's, or one whose recommendation would skip CI without `no_ci`, is parked: its task is
 *   held for the user's answer and a P1 item waits for the morning; one with no
 *   recommendation is left to the leader, as today;
 * - a review gate whose questions are all answered passes on channel `autonomous` when its
 *   task carried a full brief (or is a plan phase) and its pinned page and spec are unchanged;
 *   otherwise it is parked with why;
 * - a ready ship on a project that merges by hand gets the verify-backed auto-merge, which
 *   merges under the standing approval (src/policy/merge.ts); a landing-queue project's line
 *   takes it itself (src/verify/landing-queue.ts).
 *
 * Nothing here can be reached by a worker's or a leader's call: the channel is the daemon's.
 * Plain code: rule checks and existing state machines; no model.
 */

/** The classes that park a task under autonomy: every keyword class but merge, which only asks for the record the grant is. */
export const PARKING_CLASSES = RESERVED_CLASSES.filter((c) => c !== "merge");

const NOMISTAKES_KINDS = ["nomistakes", "nomistakes-floor", "nomistakes-unread"];
/** Answers that skip CI: taken only when the default branch's .no-mistakes.yaml says no_ci. */
const SKIPS_CI = ["accept-without-ci"];
const CI_TEXT = /\b(ci|checks?)\b|never started/i;

export type QuestionVerdict = { action: "decide"; choice: string } | { action: "park"; why: string; klass: string | null } | { action: "skip"; why: string };

export interface QuestionFacts {
  /** The default branch's .no-mistakes.yaml declares no_ci: true (null: not read). */
  noCi: boolean | null;
}

/** Was this run started under the autonomy migration? Older runs finish as they began. */
export function startedUnderAutonomy(db: Db, startedAt: number): boolean {
  const row = db.query("SELECT applied_at FROM schema_migrations WHERE name = 'autonomy'").get() as { applied_at: number | null } | null;
  return row?.applied_at != null && startedAt >= row.applied_at;
}

/** The recommendation as an answer, or null when it names no option (a text question takes its text). */
function recommendedChoice(d: DecisionRow): string | null {
  const rec = d.recommendation?.trim() ?? "";
  if (rec.length === 0) return null;
  if (d.kind === "text") return rec;
  const options = JSON.parse(d.options) as string[];
  if (d.kind === "multi") {
    const parts = rec.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    return parts.length > 0 && parts.every((p) => options.includes(p)) ? parts.join(", ") : null;
  }
  return options.includes(rec) ? rec : null;
}

/** The worker marked the question for the user with its own words (`ask --reserved`). */
function workerReserved(d: DecisionRow): boolean {
  const reason = d.reserved_reason;
  if (reason === null || d.reserved_class !== null || d.gate_id !== null || d.origin === CI_WAIT_ORIGIN) return false;
  return reason !== GATE_QUESTION_RESERVED && reason !== "merge" && !reason.startsWith("nomistakes:");
}

/** What autonomy does with an open question. Pure: the run and the facts are read before. */
export function autonomyVerdict(d: DecisionRow, run: Pick<RunWithPolicy, "state" | "sensitive"> | null, cfg: DecisionsConfig, facts: QuestionFacts): QuestionVerdict {
  if (d.state !== "open") return { action: "skip", why: "not open" };
  if (d.run_id === null) return { action: "skip", why: "standalone decision" };
  if (d.autonomy_state != null) return { action: "skip", why: `already ${d.autonomy_state}` };
  if (!run || isTerminal(run.state)) return { action: "skip", why: "its run is over" };
  if (workerReserved(d)) return { action: "park", why: `the worker marked it for the user: ${sanitizeLine(d.reserved_reason!, 120)}`, klass: null };
  if (d.reserved_class !== null && (PARKING_CLASSES as readonly string[]).includes(d.reserved_class)) return { action: "park", why: `a ${d.reserved_class} question`, klass: d.reserved_class };
  // The wording is checked with every protected class on, whatever [decisions] reserved_classes narrows.
  const all = { ...cfg, reserved_classes: [...PARKING_CLASSES] };
  const klass = reservedReason({ question: d.question, context: d.context, sourceReason: null, blocksYoloOff: false }, all);
  if (klass !== null) return { action: "park", why: `its wording names a ${klass} step`, klass };
  if (run.sensitive === 1) return { action: "park", why: "a sensitive task's question", klass: null };
  const choice = recommendedChoice(d);
  if (choice === null) return { action: "skip", why: "no recommendation among its options: the leader decides" };
  const ciRelated = d.origin === CI_WAIT_ORIGIN ? SKIPS_CI.includes(choice) : NOMISTAKES_KINDS.includes(d.reserved_class ?? "") && ["approve", "skip"].includes(choice) && CI_TEXT.test(d.question);
  if (ciRelated && facts.noCi !== true) return { action: "park", why: `${choice} skips CI, and the default branch's .no-mistakes.yaml does not say no_ci`, klass: null };
  return { action: "decide", choice };
}

export interface GateFacts {
  /** The task's dispatch brief passes the ship brief check, or the task is a plan phase. */
  briefOk: boolean;
  /** The run started after the autonomy migration. */
  current: boolean;
  /** The gate's stage is a flowryn-design one: it owes a pinned build spec. */
  designStage: boolean;
}

export type GateVerdict = { action: "pass" } | { action: "park"; why: string } | { action: "skip"; why: string };

/** What autonomy does with an open review gate whose questions are answered. Pure apart from the pinned files' digests. */
export function autonomyGateVerdict(run: RunWithPolicy, gate: GateRow, facts: GateFacts): GateVerdict {
  if (!facts.current) return { action: "skip", why: "its run started before unattended mode existed" };
  if (!facts.briefOk) return { action: "park", why: "its task was dispatched without a full brief" };
  if (!gate.review_url && !gate.page_path) return { action: "park", why: "the review has no page" };
  if (facts.designStage && !gate.spec_digest) return { action: "park", why: "the design review pinned no build spec" };
  try {
    requireDraftPageShown(run, gate);
    requireDesignPinned(run, { ...gate, spec_path: gate.spec_path ?? null, page_path: gate.page_path ?? null, spec_digest: gate.spec_digest ?? null, page_digest: gate.page_digest ?? null });
  } catch (error) {
    if (error instanceof FlowrynError) return { action: "park", why: error.message };
    throw error;
  }
  return { action: "pass" };
}

export interface AutonomyPassDeps {
  db: Db;
  config(): FlowrynConfig;
  decisions(): DecisionsConfig;
  git: GitRunner;
  now(): number;
  log(message: string): void;
}

export interface AutonomyOutcome {
  /** Runs steered with an answer. */
  steered: string[];
  /** Gates passed (the scheduler should look). */
  passed: string[];
  parked: string[];
  merges: string[];
}

const EMPTY: AutonomyOutcome = { steered: [], passed: [], parked: [], merges: [] };

function parkedGateKey(gate: string): string {
  return `autonomy_parked:${gate}`;
}

/** Open the task's morning item and hold it once. Call inside a transaction. */
function park(db: Db, row: AutonomyRow, run: RunWithPolicy, what: { decision?: DecisionRow; gate?: GateRow }, why: string, klass: string | null, now: number): void {
  const ref = what.decision?.id ?? what.gate?.id ?? run.id;
  const event = appendEvent(db, { source: "daemon", kind: "autonomy.parked", runId: run.id, taskId: run.task_id, payload: { autonomy: row.id, ...(what.decision ? { decision: what.decision.id } : {}), ...(what.gate ? { gate: what.gate.id } : {}), class: klass, why: sanitizeLine(why, 200) }, ts: now });
  if (what.decision) {
    const d = what.decision;
    db.query("UPDATE decisions SET autonomy_state = 'parked', autonomy_id = ?2 WHERE id = ?1").run(d.id, row.id);
    // A run question that did not hold its task becomes blocking, so its answer unholds it (answerDecision); a gate's question is held by its open gate.
    if (d.blocking === 0 && d.gate_id === null) {
      db.query("UPDATE decisions SET blocking = 1 WHERE id = ?1").run(d.id);
      recordIntent(db, { file: "backlog", verb: "hold", taskId: run.task_id, positional: [run.task_id], flags: { reason: holdReason(`autonomy parked on ${d.id}`), kind: "captain" }, now });
    }
  }
  if (what.gate) setMeta(db, parkedGateKey(what.gate.id), row.id);
  if (!findOpenRunItem(db, "autonomy_parked", run.id)) {
    const next = what.decision ? `flowryn decide ${what.decision.id} <choice> --by captain` : `flowryn approve ${run.task_id} --gate ${what.gate?.stage ?? ""}`.trim();
    openItem(db, { kind: "autonomy_parked", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Parked under unattended mode: ${sanitizeLine(taskTitle(db, run.task_id), 60)} (${run.task_id}) on ${ref}: ${sanitizeLine(why, 120)}; ${next}`, now });
  }
}

/** The questions half: decide or park each open question of a covered live run. Call inside a transaction. */
function passQuestions(db: Db, row: AutonomyRow, cfg: DecisionsConfig, noCi: Map<string, boolean | null>, now: number, out: AutonomyOutcome): void {
  const open = db.query("SELECT * FROM decisions WHERE state = 'open' AND run_id IS NOT NULL AND autonomy_state IS NULL ORDER BY created_at, id").all() as DecisionRow[];
  for (const d of open) {
    const run = getRunWithPolicy(db, d.run_id!);
    if (!run || !autonomyFor(db, run.project_id, now) || !startedUnderAutonomy(db, run.started_at)) continue;
    const verdict = autonomyVerdict(d, run, cfg, { noCi: noCi.get(run.project_id) ?? null });
    if (verdict.action === "skip") continue;
    if (verdict.action === "park") {
      park(db, row, run, { decision: d }, verdict.why, verdict.klass, now);
      out.parked.push(d.id);
      continue;
    }
    const why = d.note?.trim() ? sanitizeLine(d.note, 300) : "no reason given";
    const done = answerDecision({ db, now: () => now }, d, { choice: verdict.choice, words: `Decided under unattended mode (${row.id}) as the worker recommended: ${why}`, by: "worker", via: AUTONOMOUS_CHANNEL });
    db.query("UPDATE decisions SET autonomy_state = 'decided', autonomy_id = ?2 WHERE id = ?1").run(d.id, row.id);
    appendEvent(db, { source: "daemon", kind: "autonomy.decided", runId: run.id, taskId: run.task_id, payload: { autonomy: row.id, decision: d.id, choice: verdict.choice, class: d.reserved_class, ...(d.gate_id ? { gate: d.gate_id } : {}) }, ts: now });
    if (done.steer) out.steered.push(run.id);
  }
}

interface GateCandidate {
  gate: string;
  run: string;
  head: string;
}

/** Open review gates of covered live runs whose questions are all answered and that were not parked. */
function gateCandidates(db: Db, now: number): { gate: GateRow; run: RunWithPolicy }[] {
  const gates = db.query("SELECT g.* FROM gates g WHERE g.kind = 'review' AND g.state = 'open' ORDER BY g.id").all() as GateRow[];
  const out: { gate: GateRow; run: RunWithPolicy }[] = [];
  for (const gate of gates) {
    const run = getRunWithPolicy(db, gate.run_id);
    if (!run || isTerminal(run.state) || !autonomyFor(db, run.project_id, now)) continue;
    if (getMeta(db, parkedGateKey(gate.id))) continue;
    if (db.query("SELECT 1 FROM decisions WHERE gate_id = ?1 AND state = 'open'").get(gate.id)) continue;
    out.push({ gate, run });
  }
  return out;
}

function gateFacts(db: Db, run: RunWithPolicy, gate: GateRow): GateFacts {
  const phase = db.query("SELECT 1 FROM plan_phases WHERE task_id = ?1").get(run.task_id) !== null;
  const body = dispatchedBody(db, run.id);
  const def = runWorkflow(db, run, run.kind);
  return {
    briefOk: phase || (body.trim().length > 0 && docProblems("ship", body).length === 0),
    current: startedUnderAutonomy(db, run.started_at),
    designStage: def.stages.find((s) => s.id === gate.stage)?.skill === "flowryn-design",
  };
}

/** The gates half, in the caller's transaction: pass or park each candidate whose head was read. */
function passGates(db: Db, row: AutonomyRow, heads: GateCandidate[], now: number, out: AutonomyOutcome): void {
  for (const c of heads) {
    const run = getRunWithPolicy(db, c.run);
    const gate = run ? openGate(db, run.id, "review") : null;
    if (!run || !gate || gate.id !== c.gate || !autonomyFor(db, run.project_id, now)) continue;
    if (db.query("SELECT 1 FROM decisions WHERE gate_id = ?1 AND state = 'open'").get(gate.id)) continue;
    const verdict = autonomyGateVerdict(run, gate, gateFacts(db, run, gate));
    if (verdict.action === "skip") continue;
    if (verdict.action === "park") {
      park(db, row, run, { gate }, verdict.why, null, now);
      out.parked.push(gate.id);
      continue;
    }
    let passed: ReturnType<typeof recordGatePass>;
    try {
      passed = recordGatePass(db, run, gate, { channel: AUTONOMOUS_CHANNEL, actor: autonomyActor(row), head: c.head }, now);
    } catch (error) {
      // Its checks refuse before anything is written: the gate is parked with the refusal.
      if (!(error instanceof FlowrynError)) throw error;
      park(db, row, run, { gate }, error.message, null, now);
      out.parked.push(gate.id);
      continue;
    }
    appendEvent(db, { source: "daemon", kind: "autonomy.gate_passed", runId: run.id, taskId: run.task_id, payload: { autonomy: row.id, gate: gate.id, stage: gate.stage, approval: passed.approval, review_url: gate.review_url, page: gate.page_path ?? null, spec_path: gate.spec_path ?? null, spec_digest: gate.spec_digest ?? null, head: c.head }, ts: now });
    out.passed.push(gate.id);
  }
}

/** A ready ship on a covered project that merges by hand: start its verify-backed auto-merge, once per head. Call inside a transaction. */
function startMerges(db: Db, config: FlowrynConfig, now: number, out: AutonomyOutcome, log: (m: string) => void): void {
  const ready = db.query("SELECT id FROM runs WHERE state = 'ready'").all() as { id: string }[];
  for (const { id } of ready) {
    const run = getRunWithPolicy(db, id);
    if (!run || run.kind !== "ship" || run.stacked_on || !autonomyFor(db, run.project_id, now) || landingQueued(config, run.project_id)) continue;
    let steps: ReturnType<typeof verifyConfig> = null;
    try {
      steps = verifyConfig(config, run.project_id);
    } catch {
      steps = null;
    }
    if (!steps) continue;
    const delivered = deliveredOf(db, run.task_id);
    if (!delivered) continue;
    const ref = delivered.kind === "pr" ? delivered.ref : `local:${delivered.ref}`;
    if (db.query("SELECT 1 FROM auto_merges WHERE run_id = ?1 AND head_sha = ?2").get(run.id, delivered.head)) continue;
    const evidence = delivered.kind === "pr" ? prEvidence(db, run.id) : null;
    try {
      const row = createAutoMerge(db, config, run, { ref, head: delivered.head, prNumber: evidence?.number ?? null, headRef: evidence?.head_ref ?? (delivered.kind === "pr" ? run.branch : null), worktree: delivered.kind === "local" ? run.worktree_path : null, source: "daemon" }, now);
      out.merges.push(row.id);
    } catch (error) {
      if (!(error instanceof FlowrynError)) throw error;
      log(`autonomy: no auto-merge for ${run.task_id}: ${error.message}`);
    }
  }
}

/** Read the default branch's .no-mistakes.yaml of each covered project. */
async function readNoCi(db: Db, git: GitRunner, projects: string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  for (const id of projects) {
    const project = getProject(db, id);
    if (!project) continue;
    const shown = await git(["show", `origin/${project.default_branch}:.no-mistakes.yaml`], project.path).catch(() => null);
    out.set(id, shown === null ? null : shown.code === 0 ? declaresNoCi(shown.stdout) : false);
  }
  return out;
}

/**
 * One pass. Returns at once, with one read, while no grant is live. The git reads (each
 * gate's worktree head, each project's no_ci) happen before the one transaction, which
 * checks again everything they were read for.
 */
export async function autonomyPass(deps: AutonomyPassDeps): Promise<AutonomyOutcome> {
  const { db } = deps;
  const live = liveAutonomy(db, deps.now());
  if (!live) return EMPTY;
  const noCi = await readNoCi(db, deps.git, projectsOf(live));
  const heads: GateCandidate[] = [];
  for (const { gate, run } of gateCandidates(db, deps.now())) {
    const head = await deps.git(["rev-parse", "HEAD"], run.worktree_path).catch(() => null);
    if (!head || head.code !== 0) {
      deps.log(`autonomy: cannot read ${run.task_id}'s head; gate ${gate.id} waits`);
      continue;
    }
    heads.push({ gate: gate.id, run: run.id, head: head.stdout.trim() });
  }
  const now = deps.now();
  return tx(db, () => {
    const row = liveAutonomy(db, now);
    if (!row || row.id !== live.id) return EMPTY;
    const out: AutonomyOutcome = { steered: [], passed: [], parked: [], merges: [] };
    passQuestions(db, row, deps.decisions(), noCi, now, out);
    passGates(db, row, heads, now, out);
    startMerges(db, deps.config(), now, out, deps.log);
    return out;
  });
}
