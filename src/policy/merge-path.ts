import { FlowrynError } from "../api/errors.ts";
import type { HandlerResult } from "../api/verbs.ts";
import { openUserActed } from "../attention/follow-up.ts";
import { resolveItems } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { tx, type Db } from "../db/db.ts";
import type { EventSource } from "../db/events.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { landRun, type LandedBy } from "../lifecycle/landing.ts";
import { deliveryBasis, requireDeliveryBasis, staleBasis, type BasisPart, type DeliveryBasis } from "../lifecycle/observed.ts";
import { getProject, type ProjectRow } from "../lifecycle/projects.ts";
import { findRun, getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { noteMergedAfterEnd } from "../reconcile/delivery.ts";
import { verifyConfig } from "../verify/config.ts";
import { verifyPolicyId } from "../verify/policy.ts";
import {
  channelOf,
  checkGate,
  chooseApproval,
  DAEMON_CALLER,
  executeMerge,
  gatherFacts,
  latestMerge,
  recordMergeRequest,
  recordMergeResult,
  rememberFacts,
  takeApproval,
  targetOf,
  type ChoiceResult,
  type GateResult,
  type MergeCaller,
  type MergeContext,
  type MergeFacts,
  type MergeRequester,
  type MergeRow,
} from "./merge.ts";
import type { DeliveryServices } from "./services.ts";

/**
 * The merge path (design section 7): the `merge` verb's prepare, apply and
 * settle, shared by the verb (src/policy/verbs.ts) and the daemon's yolo
 * auto-merge (src/verify/auto-merge.ts), so the gate, approvals, events and
 * the proof stay in one place. The caller decides only who asked: the verb's
 * leader or human, or the daemon (DAEMON_CALLER), which brings no harness
 * channel and so merges under the yolo posture or not at all.
 */

/** What the merge path needs of the daemon: a HandlerCtx has all of it. */
export interface MergeServices {
  db: Db;
  config(): FlowrynConfig;
  delivery: DeliveryServices;
  now(): number;
  log(message: string): void;
}

export function mergeContext(s: MergeServices): MergeContext {
  return {
    db: s.db,
    forge: s.delivery.forge(),
    git: s.delivery.git,
    github: s.delivery.github(),
    now: s.now,
    verifyPolicy: (projectId) => {
      const config = verifyConfig(s.config(), projectId);
      return config ? verifyPolicyId(config) : null;
    },
  };
}

/** The run a task (or run id) names, with its project; any state. */
export function runAndProject(db: Db, target: string): { run: RunWithPolicy; project: ProjectRow } {
  const found = findRun(db, target);
  const run = found ? getRunWithPolicy(db, found.id) : null;
  if (!run) throw new FlowrynError("not_found", `no task or run ${target}`, "flowryn fleet");
  const project = getProject(db, run.project_id);
  if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
  return { run, project };
}

/** Merges whose settle is asking GitHub now, so a replayed call never asks twice. */
const executing = new Set<string>();

export interface MergePrepared {
  facts: MergeFacts;
  gate: GateResult;
  chosen: ChoiceResult;
  /** The run as the gate's reads started (docs/notes/2026-10-13-next-steps-md-av.md). */
  seen: DeliveryBasis;
}

/** A merge is requested only for the delivery, merge and run state the gate read: a redelivery, cancel or merge in between refuses it. */
const MERGE_PARTS: readonly BasisPart[] = ["state", "stage", "stage_state", "delivered", "merge", "operation"];

/** The ship a merge names, if it is ready to merge (or merging with no request in flight). */
export function mergeable(db: Db, delivery: Pick<DeliveryServices, "inFlight">, target: string): { run: RunWithPolicy; project: ProjectRow } {
  const { run, project } = runAndProject(db, target);
  if (run.kind !== "ship") throw new FlowrynError("not_ready", `${run.task_id} is a scout; scouts deliver a report, not a merge`);
  if (run.state === "merging") {
    const last = latestMerge(db, run.task_id);
    if (last && (last.state === "requested" || delivery.inFlight.has(last.id))) throw new FlowrynError("merge_in_flight", `merge ${last.id} of ${run.task_id} is in flight`, `flowryn show ${run.task_id}`);
  } else if (run.state === "landed" || run.state === "cleaned") {
    throw new FlowrynError("not_ready", `${run.task_id} is already ${run.state}`, `flowryn show ${run.task_id}`);
  } else if (run.state !== "ready") {
    throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}, not ready to merge`, `flowryn show ${run.task_id}`);
  }
  return { run, project };
}

/** The daemon's prepare: the gate as the verb runs it, with no harness channel (so the yolo posture, or a standing human record). */
export async function prepareDaemonMerge(s: MergeServices, task: string): Promise<MergePrepared> {
  const { run, project } = mergeable(s.db, s.delivery, task);
  const seen = deliveryBasis(s.db, run.id);
  const facts = await gatherFacts(mergeContext(s), run, project);
  const chosen = chooseApproval(s.db, facts, { caller: DAEMON_CALLER }, "merge", s.now());
  return { facts, gate: checkGate(facts, chosen), chosen, seen };
}

function sourceOf(caller: MergeCaller): EventSource {
  return caller.role === "daemon" ? "daemon" : "cli";
}

function landedBy(caller: MergeCaller): LandedBy {
  return caller.role === "leader" ? "leader" : caller.role === "daemon" ? "auto" : "other";
}

function requesterOf(caller: MergeCaller): MergeRequester {
  return { source: sourceOf(caller), by: caller.role === "leader" ? "leader" : caller.role === "daemon" ? "auto" : "human" };
}

/** Request the merge the gate allowed: the approval used up, the merges row, the run merging. Call inside a transaction. */
export function applyMerge(s: MergeServices, prepared: MergePrepared, caller: MergeCaller): HandlerResult {
  const { facts, gate, chosen, seen } = prepared;
  const now = s.now();
  const by = landedBy(caller);
  if (gate.alreadyMerged) {
    const ended = getRunWithPolicy(s.db, facts.run.id)!;
    const delivered = deliveredOf(s.db, ended.task_id);
    if (isTerminal(ended.state) && delivered && !staleBasis(seen, deliveryBasis(s.db, ended.id), ["delivered"]).delivered) {
      const sha = facts.pr!.mergeSha ?? facts.head;
      rememberFacts(s.db, facts, now);
      noteMergedAfterEnd(s.db, ended, delivered, { mergeSha: sha, source: "github" }, now);
      const lateMerge = latestMerge(s.db, ended.task_id);
      return {
        data: { task: ended.task_id, run: ended.id, run_state: ended.state, ...(lateMerge ? { state: lateMerge.state } : {}), merged: "after_end", sha, detail: `the PR was merged after the run was ${ended.state}; the run is not revived and a divergence asks you` },
        hints: [`flowryn show ${ended.task_id}`],
      };
    }
  }
  // A PR GitHub already reads merged lands the run whatever else changed, as long as it is still the delivery.
  requireDeliveryBasis(s.db, seen, gate.alreadyMerged ? ["delivered"] : MERGE_PARTS, "merge", sourceOf(caller), now, `flowryn merge ${facts.run.task_id} again`);
  const run = getRunWithPolicy(s.db, facts.run.id)!;
  rememberFacts(s.db, facts, now);
  if (gate.alreadyMerged) {
    // GitHub merged it, not this call: only the leader's own call reports it itself.
    landRun(s.db, run, { mergeSha: facts.pr!.mergeSha ?? facts.head, how: "merged_elsewhere", by: by === "leader" ? "leader" : "other" }, now);
    return { data: { task: run.task_id, run: run.id, state: "landed", merged: "already", sha: facts.pr!.mergeSha ?? "-" }, hints: [`flowryn show ${run.task_id}`] };
  }
  if (run.state !== "ready" && run.state !== "merging") throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}`);
  const channel = channelOf(chosen.choice!);
  const approval = takeApproval(s.db, facts, chosen.choice!, "merge", now);
  const mergeId = recordMergeRequest(s.db, facts, approval, channel, gate.waived, s.delivery.github().merge_method, now, gate.localGreen, requesterOf(caller));
  // The merge you approved is requested: its follow-up is done.
  resolveItems(s.db, "user_acted", run.task_id, `merge ${mergeId} requested`, now);
  // In flight from here: the watcher leaves a requested merge alone until this daemon has asked GitHub.
  s.delivery.inFlight.add(mergeId);
  const noVerify = facts.local?.policy ? null : `project ${facts.project.id} has no verify steps: this merge ran no local verify (add [projects.${facts.project.id}] verify to config.toml to require one)`;
  return {
    data: { task: run.task_id, run: run.id, merge: mergeId, head: facts.head, approval, channel, waived: gate.waived ?? "-", local_green: gate.localGreen ?? "-", ...(noVerify ? { verify: "none configured" } : {}), state: "merging" },
    ...(noVerify ? { hints: [noVerify] } : {}),
  };
}

/**
 * Ask GitHub (or git, local-only) for the requested merge and record the
 * proof; cleanup follows a proven merge. Throws merge_refused or not_landed
 * when it did not land, as the verb replies.
 */
export async function settleMerge(s: MergeServices, result: HandlerResult, caller: MergeCaller): Promise<HandlerResult> {
  const runId = String(result.data.run ?? "");
  if (result.data.merged === "already") {
    void s.delivery.cleanup(runId, { discardApproval: null, auto: true }).catch((error: unknown) => s.log(`cleanup ${runId}: ${(error as Error).message}`));
    return result;
  }
  if (result.data.merged === "after_end") return result;
  const mergeId = String(result.data.merge ?? "");
  let row = s.db.query("SELECT * FROM merges WHERE id = ?1").get(mergeId) as MergeRow | null;
  if (!row) throw new FlowrynError("internal", `merge ${mergeId} is gone`);
  let endedBefore = null as RunWithPolicy | null;
  if (row.state === "requested" && s.delivery.inFlight.has(mergeId) && !executing.has(mergeId)) {
    executing.add(mergeId);
    try {
      const { run, project } = runAndProject(s.db, runId);
      const outcome = await executeMerge(mergeContext(s), targetOf(row, project, `${taskTitle(s.db, run.task_id)} (${run.task_id})`));
      tx(s.db, () => {
        const current = getRunWithPolicy(s.db, runId)!;
        if (isTerminal(current.state)) endedBefore = current;
        recordMergeResult(s.db, current, mergeId, outcome, s.now(), landedBy(caller));
        if (outcome.state === "refused" && caller.role !== "daemon") {
          openUserActed(s.db, caller.role, { action: "merge_refused", taskId: current.task_id, runId: current.id, line: `The user's merge of ${taskTitle(s.db, current.task_id)} (${current.task_id}) was refused: ${outcome.detail}; tell the user why`, now: s.now() });
        }
      });
    } finally {
      executing.delete(mergeId);
      s.delivery.inFlight.delete(mergeId);
    }
    row = s.db.query("SELECT * FROM merges WHERE id = ?1").get(mergeId) as MergeRow;
    if (row.state === "merged" && !endedBefore) void s.delivery.cleanup(runId, { discardApproval: null, auto: true }).catch((error: unknown) => s.log(`cleanup ${runId}: ${(error as Error).message}`));
  }
  s.delivery.watch(runId);
  const data = { ...result.data, state: row.state, sha: row.merge_sha ?? "-", detail: row.detail ?? "-" };
  if (row.state === "refused") throw new FlowrynError("merge_refused", `merge ${mergeId} refused: ${row.detail ?? "no detail"}`, `flowryn show ${result.data.task}`);
  if (row.state === "unproven" || row.state === "requested") {
    throw new FlowrynError("not_landed", `merge ${mergeId} was requested but is not proven (${row.detail ?? "no answer yet"}); the task is not landed and flowrynd keeps checking`, `flowryn show ${result.data.task}`);
  }
  if (endedBefore) {
    return { data: { ...data, run_state: (endedBefore as RunWithPolicy).state, merged: "after_end", detail: `the PR was merged after the run was ${(endedBefore as RunWithPolicy).state}; the run is not revived and a divergence asks you` }, hints: [`flowryn show ${result.data.task}`] };
  }
  return { data: { ...data, cleanup: "running" }, hints: [...(result.hints ?? []), `flowryn show ${result.data.task}`] };
}
