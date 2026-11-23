import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { askConfig } from "../config/ask.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { reportDirFor } from "../lifecycle/launcher.ts";
import { getRunWithPolicy, isTerminal, type RunWithPolicy } from "../lifecycle/runs.ts";
import { DESIGN_SKILL, QA_SKILL, runWorkflow, type GateRow } from "../lifecycle/stages.ts";
import { recordGatePass } from "../policy/gates.ts";
import { gatePassOnEvidence, verifyConfig } from "../verify/config.ts";
import { verifyPolicyId } from "../verify/policy.ts";
import { autoVerifyPath, findQueued, getRequest, insertRequest } from "../verify/queue.ts";
import { finishedAtHead, runningVerifications } from "../verify/store.ts";
import { FlowrynError } from "../api/errors.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { designEvidence, EVIDENCE_CHANNEL, evidenceRefusal, MAX_PROBE_BYTES, MAX_PROBE_FILES, PROBE_FILE, qaEvidence, type QaEvidence } from "./evidence-gate.ts";
import { appendEvidencePassed, applyValidation, gateFacts, launchValidation, NO_AWAY, readPage, startRound, validationsInFlight, type ValidatorDeps } from "./gate-validator.ts";

/**
 * The evidence gate's daemon pass (docs/notes/2026-11-23-phase-gates-pass-8f.md), on the
 * validator's tick: each open design or QA review gate of a `gate_pass = "evidence"` project is
 * judged on its evidence (src/attention/evidence-gate.ts). A QA gate passes here once the
 * project's verify passed at the gate's head (queued by this pass, source auto); a design gate
 * starts one independent validator round (basis `evidence`), whose pass is recorded by
 * applyValidation. A gate whose evidence is not green is held once (`gate.evidence_held`, with
 * why) and stays the user's; one that may still turn green waits. Every pass appends
 * `gate.evidence_passed` with its evidence. Plain code.
 */

export interface EvidenceOutcome {
  passed: string[];
  rounds: string[];
  verifies: string[];
  held: string[];
}

function heldKey(gate: string): string {
  return `evidence_held:${gate}`;
}

function verifyKey(gate: string): string {
  return `evidence_verify:${gate}`;
}

/** Hold a gate for the user once, with why. Call inside a transaction. */
function holdGate(db: Db, run: RunWithPolicy, gate: GateRow, why: string, now: number, out: EvidenceOutcome): void {
  if (getMeta(db, heldKey(gate.id))) return;
  setMeta(db, heldKey(gate.id), String(now));
  appendEvent(db, { source: "daemon", kind: "gate.evidence_held", runId: run.id, taskId: run.task_id, payload: { gate: gate.id, stage: gate.stage, why: sanitizeLine(why, 200), review_url: gate.review_url }, ts: now });
  out.held.push(gate.id);
}

/** Open review gates of evidence projects that were not held, with their runs. */
function candidates(db: Db, onEvidence: (project: string) => boolean): { gate: GateRow; run: RunWithPolicy }[] {
  const gates = db.query("SELECT * FROM gates WHERE kind = 'review' AND state = 'open' ORDER BY opened_at, id").all() as GateRow[];
  const out: { gate: GateRow; run: RunWithPolicy }[] = [];
  for (const gate of gates) {
    if (getMeta(db, heldKey(gate.id))) continue;
    const run = getRunWithPolicy(db, gate.run_id);
    if (!run || isTerminal(run.state) || !onEvidence(run.project_id)) continue;
    out.push({ gate, run });
  }
  return out;
}

/** The QA stage's probe files beside its evidence page in the task's report dir; a string says why they cannot be read. */
export function readProbes(dir: string): { name: string; text: string }[] | string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => PROBE_FILE.test(n)).toSorted();
  } catch {
    return [];
  }
  if (names.length > MAX_PROBE_FILES) return `${names.length} probe files, over ${MAX_PROBE_FILES}`;
  const out: { name: string; text: string }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = lstatSync(path, { throwIfNoEntry: false });
    // A symlink is refused, as stage done refuses one for the page.
    if (!st || !st.isFile()) return `${name} is not a regular file`;
    if (st.size > MAX_PROBE_BYTES) return `${name} is over ${MAX_PROBE_BYTES / 1024} KB`;
    out.push({ name, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** What the gate's stage is judged by: the QA rule, the design rule, or none. */
function stageRule(db: Db, run: RunWithPolicy, gate: GateRow): "qa" | "design" | null {
  const skill = runWorkflow(db, run, run.kind).stages.find((s) => s.id === gate.stage)?.skill;
  return skill === QA_SKILL ? "qa" : skill === DESIGN_SKILL ? "design" : null;
}

type Step = { kind: "hold"; why: string } | { kind: "wait" } | { kind: "round" } | { kind: "qa"; evidence: QaEvidence };

/** Everything read from files and git for one gate, before its transaction. */
async function readGate(deps: ValidatorDeps, gate: GateRow, run: RunWithPolicy): Promise<{ step: Step; head: string | null }> {
  const { db } = deps;
  const rule = stageRule(db, run, gate);
  if (rule === null) return { step: { kind: "hold", why: `the ${gate.stage} stage has no evidence rule (design and QA reviews only)` }, head: null };
  const refusal = evidenceRefusal(gateFacts(db, gate, deps.now(), null, "evidence"), deps.decisions());
  if (refusal) return { step: refusal.wait ? { kind: "wait" } : { kind: "hold", why: refusal.why }, head: null };
  const read = await deps.git(["rev-parse", "HEAD"], run.worktree_path).catch(() => null);
  if (!read || read.code !== 0 || !read.stdout.trim()) return { step: { kind: "wait" }, head: null };
  const head = read.stdout.trim();
  const opened = (db.query("SELECT pass_head FROM gates WHERE id = ?1").get(gate.id) as { pass_head: string | null } | null)?.pass_head ?? null;
  if (opened !== null && opened !== "none" && opened !== head) return { step: { kind: "hold", why: `the branch moved from ${opened.slice(0, 8)} to ${head.slice(0, 8)} since the review opened` }, head };
  const html = readPage(gate.page_path!);
  if (html === null) return { step: { kind: "hold", why: "its review page cannot be read" }, head };
  if (rule === "design") {
    const design = designEvidence(html);
    return { step: design.ok ? { kind: "round" } : { kind: "hold", why: design.why }, head };
  }
  const probes = readProbes(join(reportDirFor(deps.config(), run.task_id), "qa"));
  if (typeof probes === "string") return { step: { kind: "hold", why: probes }, head };
  const qa = qaEvidence({ html, probes });
  return { step: qa.ok ? { kind: "qa", evidence: qa.evidence } : { kind: "hold", why: qa.why }, head };
}

/**
 * A QA gate whose page is green: pass it once the project's verify passed at `head`, hold it when
 * that verify failed or its request was cancelled, else queue the verify (once) and wait. Call
 * inside a transaction.
 */
function judgeQa(deps: ValidatorDeps, gate: GateRow, run: RunWithPolicy, head: string, evidence: QaEvidence, now: number, out: EvidenceOutcome): void {
  const { db } = deps;
  let steps: ReturnType<typeof verifyConfig>;
  try {
    steps = verifyConfig(deps.config(), run.project_id);
  } catch (error) {
    if (!(error instanceof FlowrynError)) throw error;
    return holdGate(db, run, gate, `the project's verify config is invalid: ${error.message}`, now, out);
  }
  if (!steps) return holdGate(db, run, gate, "the project has no verify steps, so its checks cannot be green at this head", now, out);
  const policy = verifyPolicyId(steps);
  const ref = `local:${run.branch}`;
  const done = finishedAtHead(db, ref, head, policy);
  if (done && done.state !== "passed") return holdGate(db, run, gate, `verify ${done.id} ${done.state} at ${head.slice(0, 8)}`, now, out);
  if (done) {
    const passed = recordGatePass(db, run, gate, { channel: EVIDENCE_CHANNEL, actor: `evidence ${gate.id}`, head }, now);
    appendEvidencePassed(db, run, gate, { approval: passed.approval, head, evidence: { verdict: evidence.verdict, probes: evidence.probes, nothing_visible: evidence.nothingVisible, verification: done.id } }, now);
    out.passed.push(gate.id);
    return;
  }
  if (runningVerifications(db).some((v) => v.pr_url === ref && v.head_sha === head && v.policy_id === policy)) return;
  if (findQueued(db, ref, head, policy)) return;
  const asked = getMeta(db, verifyKey(gate.id));
  const request = asked ? getRequest(db, asked) : null;
  if (request && request.head_sha === head && request.state === "cancelled") return holdGate(db, run, gate, `verify request ${request.id} was cancelled: ${sanitizeLine(request.detail ?? "-", 120)}`, now, out);
  if (request && request.head_sha === head) return;
  const made = insertRequest(db, { project_id: run.project_id, pr_url: ref, task_id: run.task_id, head_sha: head, policy_id: policy, pr_number: null, head_ref: null, worktree: run.worktree_path, source: "auto", path: autoVerifyPath(db, run.project_id), now });
  setMeta(db, verifyKey(gate.id), made.id);
  appendEvent(db, { source: "daemon", kind: "gate.evidence_verify", runId: run.id, taskId: run.task_id, payload: { gate: gate.id, stage: gate.stage, request: made.id, ref, head }, ts: now });
  out.verifies.push(made.id);
}

/**
 * One pass. Returns at once while no project sets `gate_pass = "evidence"`. Files and git are read
 * before each gate's transaction, which reads its eligibility again before it acts.
 */
export async function evidencePass(deps: ValidatorDeps): Promise<EvidenceOutcome> {
  const out: EvidenceOutcome = { passed: [], rounds: [], verifies: [], held: [] };
  const config = deps.config();
  const projects = Object.keys((config.extra.projects ?? {}) as Record<string, unknown>).filter((id) => gatePassOnEvidence(config, id));
  if (projects.length === 0) return out;
  const { db } = deps;
  const cfg = deps.decisions();
  for (const { gate, run } of candidates(db, (p) => projects.includes(p))) {
    const { step, head } = await readGate(deps, gate, run);
    if (step.kind === "wait") continue;
    const acted = out.passed.length + out.verifies.length + out.held.length;
    const picked = tx(db, () => {
      const now = deps.now();
      const fresh = db.query("SELECT * FROM gates WHERE id = ?1").get(gate.id) as GateRow | null;
      const live = getRunWithPolicy(db, run.id);
      if (!fresh || fresh.state !== "open" || !live || isTerminal(live.state) || getMeta(db, heldKey(gate.id))) return null;
      if (step.kind === "hold") {
        holdGate(db, live, fresh, step.why, now, out);
        return null;
      }
      const refusal = evidenceRefusal(gateFacts(db, fresh, now, null, "evidence"), cfg);
      if (refusal) {
        if (!refusal.wait) holdGate(db, live, fresh, refusal.why, now, out);
        return null;
      }
      if (step.kind === "qa") {
        judgeQa(deps, fresh, live, head!, step.evidence, now, out);
        return null;
      }
      if (validationsInFlight().size >= askConfig(config).max_concurrent) return null;
      return startRound(db, { gate: fresh, run: live, head: head!, basis: "evidence", awaySince: NO_AWAY, now });
    });
    if (picked) {
      launchValidation(deps, picked, cfg, applyValidation);
      out.rounds.push(picked.id);
      deps.log(`evidence: ${picked.id} started on gate ${gate.id} (${gate.stage}) of ${run.task_id}`);
    }
    if (out.passed.length + out.verifies.length + out.held.length > acted) deps.changed(run.id);
  }
  return out;
}
