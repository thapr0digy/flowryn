import type { FlowrynConfig } from "../config/config.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { localDate } from "../lifecycle/dates.ts";
import type { DecisionRow } from "../lifecycle/decisions.ts";
import { approvalRef, deliveredOf, prEvidence } from "../lifecycle/delivery.ts";
import type { RunWithPolicy } from "../lifecycle/runs.ts";
import type { GateRow } from "../lifecycle/stages.ts";
import { findHumanApproval } from "../policy/approvals.ts";
import { latestMerge } from "../policy/merge.ts";
import { latestAutoMerge, LIVE_AUTO_MERGE_STATES, type AutoMergeRow } from "../verify/auto-merge.ts";
import { liveLanding, placeOf, type LandingRow } from "../verify/landing-queue.ts";
import { verifyConfig } from "../verify/config.ts";
import { verifyPolicyId } from "../verify/policy.ts";
import { findQueued } from "../verify/queue.ts";
import { finishedAtHead, type Verification, type VerificationRow } from "../verify/store.ts";
import { findOpenRunItem } from "./items.ts";
import { explain, type ExplanationKind, type Fact, type Unblock } from "./explanations.ts";

/**
 * Waits on you or the leader (docs/notes/2026-10-29-why-waiting-covers-fy.md):
 * an open review gate, an open run-scoped decision, and delivered work not
 * yet merged. Unlike a dialog or a capacity refusal, these have no single
 * rule that decides them: about fifteen places open and close them. So one
 * writer reads what is open, each scheduler pass, and records each wait
 * through `explain`, whose dedupe writes nothing while a wait is unchanged.
 * It reads only the database (never GitHub or git), so it is cheap and
 * cannot hang, and a wait already open at upgrade is explained at once with
 * its real start (`since`). No model is involved.
 */

const HUMAN_KINDS: readonly ExplanationKind[] = ["gate", "decision", "merge"];

interface Wanted {
  kind: ExplanationKind;
  subject: string;
}

interface Explained {
  rule: string;
  reason: string;
  facts: Fact[];
  unblock: Unblock[];
  since: number;
}

/** A run that is not ended, with the stored facts the rules read. */
type LiveRun = RunWithPolicy & { yolo: number };

/** Record every review, decision and merge wait of the live runs; close those no longer wanted. Call inside a transaction. Returns the rows written. */
export function explainHumanWaits(db: Db, config: FlowrynConfig, now: number): number {
  const runs = db
    .query(
      `SELECT r.*, p.project_id, p.kind, p.delivery_mode, p.yolo, p.sensitive FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE r.state NOT IN ('cleaned','failed','cancelled')`,
    )
    .all() as LiveRun[];
  let written = 0;
  const wanted = new Map<string, Wanted[]>();
  const record = (run: LiveRun, kind: ExplanationKind, subject: string, x: Explained): void => {
    const list = wanted.get(run.id) ?? [];
    list.push({ kind, subject });
    wanted.set(run.id, list);
    const id = explain(db, { run: { id: run.id, task_id: run.task_id, stage: run.stage }, kind, subject, ...x, source: "daemon", now });
    if (id !== null) written += 1;
  };
  for (const run of runs) {
    for (const gate of openReviewGates(db, run.id)) record(run, "gate", gate.id, reviewWait(db, run, gate));
    for (const d of openDecisions(db, run.id)) record(run, "decision", d.id, decisionWait(run, d, now));
    const merge = mergeWait(db, config, run, now);
    if (merge) record(run, "merge", "merge", merge);
  }
  closeUnwanted(db, wanted, now);
  return written;
}

function openReviewGates(db: Db, runId: string): GateRow[] {
  return db.query("SELECT * FROM gates WHERE run_id = ?1 AND kind = 'review' AND state = 'open' ORDER BY opened_at, id").all(runId) as GateRow[];
}

/** The run's open questions, not those handed in with a review gate (they are the gate's wait: one answer place). */
function openDecisions(db: Db, runId: string): DecisionRow[] {
  return db.query("SELECT * FROM decisions WHERE run_id = ?1 AND state = 'open' AND gate_id IS NULL ORDER BY id").all(runId) as DecisionRow[];
}

// --- reviews ----------------------------------------------------------------------------------

function reviewWait(db: Db, run: LiveRun, gate: GateRow): Explained {
  const task = run.task_id;
  const questions = (db.query("SELECT id FROM decisions WHERE gate_id = ?1 AND state = 'open' ORDER BY id").all(gate.id) as { id: string }[]).map((q) => q.id);
  const asking = questions.length > 0 ? ` and ${questions.length} question${questions.length === 1 ? "" : "s"}` : "";
  const facts: Fact[] = [
    { name: "gate", value: gate.id, at: gate.opened_at },
    { name: "stage", value: gate.stage, at: null },
    { name: "review page", value: gate.review_url ?? "-", at: null },
    { name: "questions open", value: questions.length > 0 ? questions.join(", ") : "none", at: null },
  ];
  const page: Unblock = { by: "captain", action: `answer on the review page ${gate.review_url ?? "(no URL recorded)"}` };
  const shell: Unblock = { by: "captain", action: `in your shell: flowryn approve ${task} --gate ${gate.stage}, or flowryn gate changes ${task} --body-file -` };
  const relay: Unblock = { by: "leader", action: `flowryn gate pass ${task} once you say yes in chat` };
  if (gate.channel_failing_since) {
    // The reason can carry timings or pids; it is shown, not compared, so a new wording is no new wait.
    facts.push({ name: "page answers failing since", value: new Date(gate.channel_failing_since).toISOString(), at: gate.channel_failing_since });
    facts.push({ name: "page channel", value: gate.channel_reason ?? "-", at: null, same: "failing" });
    return {
      rule: "gate.review_channel",
      reason: `waiting for your ${gate.stage} review (${gate.id})${asking}; answers on the page are not reaching Flowryn`,
      facts,
      unblock: [shell, page, relay],
      since: gate.opened_at,
    };
  }
  return { rule: "gate.review", reason: `waiting for your ${gate.stage} review (${gate.id})${asking}`, facts, unblock: [page, shell, relay], since: gate.opened_at };
}

// --- decisions --------------------------------------------------------------------------------

function decisionWait(run: LiveRun, d: DecisionRow, now: number): Explained {
  const options = parseOptions(d.options);
  const choice = options.length > 0 ? "<choice>" : "<answer>";
  const facts: Fact[] = [
    { name: "decision", value: d.id, at: d.created_at },
    { name: "from", value: d.origin ?? "ask", at: null },
    { name: "blocking", value: d.blocking ? "yes" : "no", at: null },
    { name: "options", value: options.length > 0 ? options.join(", ") : "free text", at: null },
  ];
  if (d.recommendation) facts.push({ name: "recommended", value: d.recommendation, at: null });
  if (d.reserved_reason) facts.push({ name: "reserved for you", value: d.reserved_reason, at: null });
  const since = d.created_at ?? now;
  const yours: Unblock = { by: "captain", action: `flowryn decide ${d.id} ${choice} --by captain, or tell the leader in chat` };
  const leaders: Unblock[] = [
    { by: "leader", action: `flowryn decide ${d.id} ${choice} --rationale -` },
    { by: "captain", action: `the same in your terminal: flowryn decide ${d.id} ${choice} --by captain` },
  ];
  const blocking = d.blocking ? " (the worker is blocked)" : "";
  if (d.defer_until && d.defer_until > localDate(new Date(now))) {
    facts.push({ name: "deferred until", value: d.defer_until, at: null });
    return {
      rule: "decision.deferred",
      reason: `${d.id} deferred until ${d.defer_until}${blocking}`,
      facts,
      unblock: [{ by: "flowryn", action: `shows it again on ${d.defer_until}` }, ...(d.reserved_reason ? [yours] : leaders)],
      since,
    };
  }
  if (d.reserved_reason) return { rule: "decision.captain", reason: `waiting for your answer to ${d.id}${blocking}`, facts, unblock: [yours], since };
  return { rule: "decision.leader", reason: `waiting for the leader to answer ${d.id}${blocking}`, facts, unblock: leaders, since };
}

function parseOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// --- merges -----------------------------------------------------------------------------------

/**
 * What a delivered run's merge waits on, from stored facts only, in the merge
 * gate's own order (src/policy/merge.ts `checkGate`): red checks (one you
 * waived at this head passes, and so do ones GitHub never started when the
 * project has verify steps), the local
 * verify, pending checks, an approval; else only the merge itself is left. A
 * live auto-merge, and a merge already requested (the run is merging; its
 * approval is used up), are Flowryn's own wait; a held auto-merge names the
 * command its item names while that item is open. None when no merge gate is open.
 */
export function mergeWait(db: Db, config: FlowrynConfig, run: LiveRun, now: number): Explained | null {
  const gate = db.query("SELECT * FROM gates WHERE run_id = ?1 AND kind = 'merge' AND state = 'open' ORDER BY opened_at DESC LIMIT 1").get(run.id) as GateRow | null;
  if (!gate) return null;
  const delivered = deliveredOf(db, run.task_id);
  if (!delivered) return null;
  const task = run.task_id;
  const ref = approvalRef(delivered);
  const head = delivered.head;
  const base = Math.max(gate.opened_at, delivered.at);
  const headFact: Fact = { name: "head", value: head.slice(0, 12), at: delivered.at };
  const auto = latestAutoMerge(db, run.id);
  if (run.state === "merging") return mergingWait(db, task, headFact, base);
  if (auto && auto.head_sha === head && auto.state === "held" && findOpenRunItem(db, "auto_merge_held", run.id)) return heldWait(auto, task, headFact);
  if (auto && auto.head_sha === head && LIVE_AUTO_MERGE_STATES.includes(auto.state)) return autoWait(auto, headFact);
  const landing = liveLanding(db, run.id);
  if (landing && landing.state === "waiting") return landingWait(db, landing, headFact);
  const evidence = delivered.kind === "pr" ? prEvidence(db, run.id) : null;
  const checks = evidence && evidence.head === head ? evidence.checks : null;
  if (evidence && evidence.head === head && evidence.state !== "open") return null;
  const checksAt = evidence?.observed_at ?? null;
  let policy: string | null;
  try {
    const verify = verifyConfig(config, run.project_id);
    policy = verify ? verifyPolicyId(verify) : null;
  } catch {
    // A broken [projects.<id>] table refuses the merge itself; say nothing rather than guess.
    return null;
  }
  const red = checks?.red ?? [];
  const notStarted = checks?.not_started ?? [];
  const coveredByVerify = policy !== null && red.every((name) => notStarted.includes(name));
  const waiver = red.length === 1 ? findHumanApproval(db, { task, action: "merge", ref, head, now, allowRed: red[0]! }) : null;
  if (red.length > 0 && !waiver && !coveredByVerify) {
    const unblock: Unblock[] = [{ by: "leader", action: `steer the worker to fix ${red.join(", ")}: flowryn steer ${task} --body-file -` }];
    if (red.length === 1) unblock.push({ by: "captain", action: `waive it in your shell: flowryn approve ${task} --allow-red ${shellWord(red[0]!)}` });
    return { rule: "merge.checks_red", reason: `merge waits: ${red.length} red check${red.length === 1 ? "" : "s"} (${red.join(", ")})`, facts: [headFact, { name: "red checks", value: red.join(", "), at: checksAt }], unblock, since: base };
  }
  let verifiedAt = base;
  if (policy !== null) {
    const done = finishedAtHead(db, ref, head, policy);
    if (done?.state === "passed") verifiedAt = Math.max(base, done.finished_at ?? base);
    else {
      const verify = verifyWait(db, task, ref, head, policy, done, headFact, base);
      if (verify) return verify;
    }
  }
  const pending = checks?.pending ?? [];
  if (pending.length > 0) {
    return {
      rule: "merge.checks_pending",
      reason: `merge waits on GitHub: ${pending.length} check${pending.length === 1 ? "" : "s"} still running`,
      facts: [headFact, { name: "pending checks", value: pending.join(", "), at: checksAt }],
      unblock: [
        { by: "flowryn", action: "reads the checks again on its next delivery pass" },
        { by: "leader", action: `flowryn show ${task}` },
      ],
      since: verifiedAt,
    };
  }
  const needsYou = run.sensitive === 1 || run.yolo !== 1;
  const approval = waiver ?? (needsYou ? findHumanApproval(db, { task, action: "merge", ref, head, now, allowRed: null }) : null);
  const posture: Fact = { name: "policy", value: `${run.yolo === 1 ? "yolo" : "approval"}${run.sensitive === 1 ? ", sensitive" : ""}`, at: null };
  if (needsYou && !approval) {
    return {
      rule: "merge.approval",
      reason: `merge waits for your approval${run.sensitive === 1 ? " (sensitive work)" : ""}`,
      facts: [headFact, posture],
      unblock: [
        { by: "captain", action: `in your shell: flowryn approve ${task}` },
        { by: "leader", action: `flowryn merge ${task} (it asks you first)` },
      ],
      since: verifiedAt,
    };
  }
  const merge = waiver ? `flowryn merge ${task} --allow-red ${shellWord(red[0]!)}` : `flowryn merge ${task}`;
  return {
    rule: "merge.ready",
    reason: "ready to merge; waiting for the leader",
    facts: [headFact, posture, { name: "approval", value: approval ? approval.id : "yolo", at: approval ? approval.created_at : null }],
    unblock: [
      { by: "leader", action: merge },
      { by: "captain", action: `the same in your terminal: ${merge}` },
    ],
    since: verifiedAt,
  };
}

/** The verify a merge needs at this head: running, queued, failed, or not asked for. Null when none of them (it passed). */
function verifyWait(db: Db, task: string, ref: string, head: string, policy: string, done: Verification | null, headFact: Fact, base: number): Explained | null {
  const running = db
    .query("SELECT * FROM verifications WHERE pr_url = ?1 AND head_sha = ?2 AND state = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(ref, head) as VerificationRow | null;
  if (running) {
    return {
      rule: "merge.verify",
      reason: `merge waits on the local verify ${running.id}`,
      facts: [headFact, { name: "verification", value: `${running.id} running`, at: running.started_at }],
      unblock: [{ by: "flowryn", action: `finishes verify ${running.id}` }],
      since: running.started_at,
    };
  }
  const queued = findQueued(db, ref, head, policy);
  if (queued) {
    return {
      rule: "merge.verify",
      reason: `merge waits on its queued local verify ${queued.id}`,
      facts: [headFact, { name: "verify request", value: `${queued.id} queued`, at: queued.requested_at }],
      unblock: [{ by: "flowryn", action: `starts verify request ${queued.id} when a validation slot frees` }],
      since: queued.requested_at,
    };
  }
  if (done) {
    return {
      rule: "merge.verify_failed",
      reason: `merge waits: the local verify ${done.id} ${done.state} at this head`,
      facts: [headFact, { name: "verification", value: `${done.id} ${done.state}`, at: done.finished_at }],
      unblock: [
        { by: "leader", action: `flowryn verify show ${done.id}, steer the worker to fix it, or once fixed: flowryn verify ${task}` },
        { by: "captain", action: `the same in your terminal: flowryn verify ${task}` },
      ],
      since: done.finished_at ?? base,
    };
  }
  return {
    rule: "merge.verify",
    reason: "merge waits for a local verify of this head",
    facts: [headFact],
    unblock: [
      { by: "leader", action: `flowryn verify ${task}` },
      { by: "captain", action: `the same in your terminal: flowryn verify ${task}` },
    ],
    since: base,
  };
}

function autoWait(auto: AutoMergeRow, headFact: Fact): Explained {
  const step =
    auto.state === "queued"
      ? `its verify is queued (${auto.request_id ?? "-"})`
      : auto.state === "verifying"
        ? `verify ${auto.verification_id ?? "-"} is running`
        : auto.state === "waiting_checks"
          ? `verify ${auto.verification_id ?? "-"} passed; GitHub's checks are running`
          : `merging (${auto.merge_id ?? "-"})`;
  return {
    rule: "merge.auto",
    reason: `auto-merge ${auto.id}: ${step}`,
    facts: [headFact, { name: "auto-merge", value: `${auto.id} ${auto.state}`, at: auto.state_since }],
    unblock: [{ by: "flowryn", action: "merges once the verify passes and the checks are green (holds it after 6 h of pending checks)" }],
    since: auto.state_since,
  };
}

function landingWait(db: Db, row: LandingRow, headFact: Fact): Explained {
  const place = placeOf(db, row);
  return {
    rule: "merge.landing",
    reason: `landing queue ${row.id}: ${place ? `${place.position} of ${place.of}${place.ahead ? `, behind ${place.ahead}` : ""}` : "waiting"}${row.blocked_since !== null && row.detail ? ` (${row.detail})` : ""}`,
    facts: [headFact, { name: "landing", value: `${row.id} ${row.state}`, at: row.state_since }],
    unblock: [{ by: "flowryn", action: "merges its base into it, verifies and merges it once the PRs ahead of it have landed" }],
    since: row.enqueued_at,
  };
}

function mergingWait(db: Db, task: string, headFact: Fact, base: number): Explained {
  const merge = latestMerge(db, task);
  const id = merge?.id ?? "-";
  return {
    rule: "merge.merging",
    reason: `merge ${id} requested; waiting for its result`,
    facts: [headFact, { name: "merge", value: `${id} ${merge?.state ?? "-"}`, at: merge?.requested_at ?? null }],
    unblock: [{ by: "flowryn", action: "records the merge's result, or reads the PR again on its next delivery pass" }],
    since: merge?.requested_at ?? base,
  };
}

function heldWait(auto: AutoMergeRow, task: string, headFact: Fact): Explained {
  const next = auto.next ?? `flowryn show ${task}`;
  return {
    rule: "merge.held",
    reason: `auto-merge ${auto.id} held (${auto.reason ?? "-"}); waiting for the leader`,
    facts: [headFact, { name: "held", value: `${auto.reason ?? "-"}: ${auto.detail ?? "-"}`, at: auto.state_since }],
    unblock: [
      { by: "leader", action: next },
      { by: "captain", action: `the same in your terminal: ${next}` },
    ],
    since: auto.state_since,
  };
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

// --- closing ----------------------------------------------------------------------------------

/**
 * Close the open review, decision and merge rows no rule wants any more: the
 * run ended, the gate or decision closed, or the merge gate closed (a landing
 * or a send-back), each with its outcome, as the sweep would close it. One
 * event when anything closed.
 */
function closeUnwanted(db: Db, wanted: Map<string, Wanted[]>, now: number): void {
  const open = db
    .query(`SELECT id, run_id, kind, subject FROM explanations WHERE closed_at IS NULL AND kind IN (${HUMAN_KINDS.map((k) => `'${k}'`).join(", ")})`)
    .all() as { id: number; run_id: string; kind: ExplanationKind; subject: string | null }[];
  const closed: number[] = [];
  for (const row of open) {
    if ((wanted.get(row.run_id) ?? []).some((w) => w.kind === row.kind && w.subject === row.subject)) continue;
    db.query("UPDATE explanations SET closed_at = ?2, closed_by = ?3 WHERE id = ?1").run(row.id, now, closedWhy(db, row));
    closed.push(row.id);
  }
  if (closed.length > 0) appendEvent(db, { source: "daemon", kind: "run.explanations_closed", payload: { explanations: closed }, ts: now });
}

function closedWhy(db: Db, row: { run_id: string; kind: ExplanationKind; subject: string | null }): string {
  const run = db.query("SELECT state FROM runs WHERE id = ?1").get(row.run_id) as { state: string } | null;
  if (!run || ["cleaned", "failed", "cancelled"].includes(run.state)) return "run ended";
  if (row.kind === "gate") {
    const gate = db.query("SELECT state FROM gates WHERE id = ?1").get(row.subject) as { state: string } | null;
    return gate && gate.state !== "open" ? `gate ${gate.state}` : "no longer waiting";
  }
  if (row.kind === "decision") {
    const d = db.query("SELECT state, answered_by, answered_via FROM decisions WHERE id = ?1").get(row.subject) as { state: string; answered_by: string | null; answered_via: string | null } | null;
    if (d?.state === "answered") return `answered by ${d.answered_by ?? d.answered_via ?? "-"}`;
    return d && d.state !== "open" ? d.state : "no longer waiting";
  }
  const gate = db.query("SELECT state FROM gates WHERE run_id = ?1 AND kind = 'merge' ORDER BY opened_at DESC, id DESC LIMIT 1").get(row.run_id) as { state: string } | null;
  if (gate?.state === "passed") return "merged";
  if (gate?.state === "changes") return "sent back";
  return "no longer waiting";
}

