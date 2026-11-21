import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { openItem, resolveItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { deliveredOf, type Delivered } from "../lifecycle/delivery.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import type { GitRunner } from "../policy/landed.ts";
import { DAEMON_CALLER } from "../policy/merge.ts";
import { applyMerge, prepareDaemonMerge, settleMerge, type MergePrepared, type MergeServices } from "../policy/merge-path.ts";
import type { DeliveryServices } from "../policy/services.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { batchLine, batchMembers, batchRef, batchRows, batchVerify, getBatch, liveBatch, type BatchRow, type BatchState } from "./batch-store.ts";
import { landingBatched, lightVerifyConfig, MAX_BATCH, MAX_INTEGRATIONS, verifyConfig } from "./config.ts";
import { likelyCulprit, numberClashes } from "./culprit.ts";
import type { LandingRow, LandingState } from "./landing-queue.ts";
import { mergeInStore } from "./object-merge.ts";
import { verifyPolicyId } from "./policy.ts";
import { autoVerifyPath, cancelRequest, findQueued, getRequest, insertRequest } from "./queue.ts";
import { autoRerunAt, cleanTail, queueAutoRerun, recordEscalation, routeVerifyOutcome, SENT_BACK_KIND, sendBackText, sentBackPayload, verifyVerdict } from "./route.ts";
import { finishedAtHead, getVerification, interruptedByStop, runningVerifications, type Verification } from "./store.ts";

/**
 * Landing batches (docs/notes/2026-11-21-landing-batches-one-27.md): on a local-only project with
 * `landing = "batch"`, every ready branch that passed its light check lands with the others in one
 * batch, verified once with the project's full verify steps. Plain code: git plumbing, the verify
 * queue and the merge verb's own path; no model.
 *
 * - Light check: each waiting, non-sensitive entry's delivered head is verified alone with
 *   `light_verify` (its own policy) in the verify runner's fresh worktree. A failing step sends the
 *   work back once per head, a timeout runs it once more, the rest holds the entry for the leader.
 * - Build: with no batch live, every eligible entry (delivery order, at most MAX_BATCH) is merged
 *   onto local main's tip in the object store, the batch so far as first parent and the branch as
 *   second, so main's first-parent history reads one merge commit per task. Two members adding the
 *   same numbered migration: the later goes back to renumber. A member that conflicts with main
 *   goes back to its worker; one that conflicts only with an earlier member waits for the next batch.
 *   No worker branch or worktree is ever written.
 * - Verify: one request for the batch head (ref batch:<project>/<id>). A pass lands it; a timeout
 *   runs once more; anything else holds it with the likely culprit for the leader (batch drop,
 *   batch retry).
 * - Land: every member passes the merge gate first (its verify evidence is the batch's, src/policy/merge.ts);
 *   then main fast-forwards to the batch head once and each member's merge is recorded through
 *   the merge verb's path, so each run lands, is cleaned up and moves in the backlog as today.
 * - A batch's head never changes: a member leaving, main moving under it or the leader dropping a
 *   branch ends it `dissolved` and builds a new one from the members left.
 *
 * Sensitive entries never join: they land one at a time through the local line (landing-queue.ts).
 */

/** The landing queue's own moves, so an entry's state and its events stay in one place. */
export interface LineOps {
  move(row: LandingRow, to: LandingState, fields: { batch_id?: string | null; batch_pos?: number | null; detail?: string | null; reason?: string | null }, now: number, source?: EventSource): LandingRow;
  leave(row: LandingRow, reason: string, detail: string, now: number, hold?: { next: string }): LandingRow;
  /** The entry conflicts with main: it leaves and its worker is sent back naming the paths. */
  sendConflict(row: LandingRow, run: RunWithPolicy, delivered: Delivered, base: string, files: string[]): boolean;
  refreshLine(projectId: string): void;
}

export interface BatchDeps {
  db: Db;
  config(): FlowrynConfig;
  git: GitRunner;
  now(): number;
  log(message: string): void;
  kickScheduler(): void;
  /** The merge verb's services; without them (a test of the line alone) a green batch waits. */
  delivery?: DeliveryServices;
}

/** How much of a hold's reason its item line keeps, so the next commands after it stay on the line. */
const HELD_DETAIL_CHARS = 90;
/** Verifies of one batch head the queue may cancel before the batch is held: the loss keeps happening. */
const MAX_VERIFY_LOSSES = 3;
/** Gate refusals that are the project checkout's or the moment's, not a member's: the batch waits and tries again. */
const RETRY_CODES = new Set(["checks_pending", "forge_unavailable", "merge_in_flight", "not_ready"]);
/** Gate refusals about the verify evidence: the batch is verified again. */
const REVERIFY_CODES = new Set(["verify_failed", "verify_stale", "red_checks"]);

function todaysPolicies(config: FlowrynConfig, projectId: string): { full: string; light: string | null } | null {
  try {
    const verify = verifyConfig(config, projectId);
    if (!verify) return null;
    const light = lightVerifyConfig(verify);
    return { full: verifyPolicyId(verify), light: light ? verifyPolicyId(light) : null };
  } catch {
    return null;
  }
}

export function batchMergeMessage(branch: string, task: string, main: string): string {
  return `Merge ${branch} (${task}) into the landing batch on main ${main.slice(0, 8)} (Flowryn)`;
}

/**
 * Where an entry's light check stands, for the views: "light check passed", "light check running
 * (v9)", or null when none was queued for it (the project has none, or the pass has not reached it).
 * Read by the policy its landing.light_queued event recorded, so a view needs no config.
 */
export function lightCheckState(db: Db, row: LandingRow): string | null {
  const queued = db
    .query("SELECT json_extract(payload, '$.policy') AS policy FROM events WHERE run_id = ?1 AND kind = 'landing.light_queued' AND json_extract(payload, '$.landing') = ?2 AND json_extract(payload, '$.head') = ?3 ORDER BY seq DESC LIMIT 1")
    .get(row.run_id, row.id, row.head_sha) as { policy: string } | null;
  if (!queued) return null;
  if (findQueued(db, row.ref, row.head_sha, queued.policy)) return "light check queued";
  const running = runningVerifications(db).find((v) => v.pr_url === row.ref && v.head_sha === row.head_sha && v.policy_id === queued.policy);
  if (running) return `light check running (${running.id})`;
  const done = finishedAtHead(db, row.ref, row.head_sha, queued.policy);
  if (!done || interruptedByStop(done)) return "light check queued";
  return done.state === "passed" ? "light check passed" : `light check ${done.state} (${done.id})`;
}

/** What `show`, the pr_ready line and the fleet say of an entry on a batch project. */
export function batchProgress(db: Db, row: LandingRow): string {
  const batch = row.batch_id ? getBatch(db, row.batch_id) : null;
  if (row.state === "landing" && batch) {
    const members = batchMembers(db, batch.id);
    const at = members.findIndex((m) => m.id === row.id);
    return `landing batch ${batch.id}: ${at + 1} of ${members.length}, ${batch.state === "verifying" ? (batchVerify(db, batch) ?? "verifying") : batch.state === "held" ? `held: ${batch.detail ?? "-"}` : "landing"} (${row.id})`;
  }
  if (row.state === "waiting") {
    const light = lightCheckState(db, row);
    return `landing queue: waiting for the next batch${light ? `, ${light}` : ""} (${row.id})`;
  }
  return `landing queue ${row.state}${row.reason ? ` (${row.reason})` : ""}${row.detail ? `: ${row.detail}` : ""}`;
}

/** The fleet's needs cell: "batch lb3 2/4 verifying v41", "next batch, light check passed". */
export function batchCell(db: Db, row: LandingRow): string {
  const batch = row.batch_id ? getBatch(db, row.batch_id) : null;
  if (row.state === "landing" && batch) {
    const members = batchMembers(db, batch.id);
    return `batch ${batch.id} ${members.findIndex((m) => m.id === row.id) + 1}/${members.length} ${batch.state === "verifying" ? (batchVerify(db, batch) ?? "verifying") : batch.state}`;
  }
  const light = lightCheckState(db, row);
  return `next batch${light ? `, ${light}` : ""}`;
}

/** A live batch's members, each with the files it changed against main: for the culprit hint and the clash check. */
interface MemberFiles {
  row: LandingRow;
  changed: string[];
  added: string[];
}

/** The paths git listed, one per line; none when it failed. */
function fileList(r: { code: number; stdout: string }): string[] {
  return r.code === 0 ? r.stdout.split("\n").map((f) => f.trim()).filter((f) => f.length > 0) : [];
}

export class LandingBatches {
  private readonly deps: BatchDeps;
  private readonly ops: LineOps;

  constructor(deps: BatchDeps, ops: LineOps) {
    this.deps = deps;
    this.ops = ops;
  }

  /**
   * Drive the project's live batch. Returns whether one is still live (nothing else lands on the
   * project meanwhile).
   */
  async drive(project: ProjectRow): Promise<boolean> {
    const { db } = this.deps;
    const batch = liveBatch(db, project.id);
    if (!batch) return false;
    if (!landingBatched(this.deps.config(), project.id, project.delivery_mode) || !todaysPolicies(this.deps.config(), project.id)) {
      tx(db, () => this.dissolve(batch, "batching_off", `project ${project.id} no longer lands in batches`, "waiting"));
      return false;
    }
    if (batch.state === "landing") {
      await this.land(batch, project);
      return liveBatch(db, project.id) !== null;
    }
    const rows = batchRows(db, batch.id);
    const left = rows.filter((r) => r.state === "left");
    const live = rows.filter((r) => r.state === "landing");
    if (live.length === 0) {
      tx(db, () => this.dissolve(batch, "emptied", "every branch left it", "waiting"));
      return false;
    }
    if (left.length > 0) {
      await this.rebuild(batch, project, `${left.map((r) => r.task_id).join(", ")} left it`, batch.integrations);
      return true;
    }
    if (batch.state === "held") return true;
    const main = await this.mainTip(project);
    if (!main) return true;
    if (!(await this.isAncestor(project.path, main, batch.head_sha))) {
      if (batch.integrations + 1 > MAX_INTEGRATIONS) {
        tx(db, () => this.hold(getBatch(db, batch.id)!, "base_moving", `main moved under the batch ${batch.integrations + 1} times; it is at ${main.slice(0, 8)}`, null));
        return true;
      }
      await this.rebuild(batch, project, `main moved to ${main.slice(0, 8)}`, batch.integrations + 1);
      return true;
    }
    const outcome = this.verifyOutcome(batch);
    if (outcome === "pending") return true;
    if (outcome.state === "passed") {
      tx(db, () => this.moveBatch(getBatch(db, batch.id)!, "landing", { verification_id: outcome.id, detail: `verify ${outcome.id} passed` }, this.deps.now()));
      await this.land(getBatch(db, batch.id)!, project);
      return liveBatch(db, project.id) !== null;
    }
    await this.failed(batch, project, outcome, main);
    return true;
  }

  /**
   * The batch's verify: still to come ("pending", queuing a request when none waits or runs),
   * or the finished verification that judges it. A run a daemon stop cut off is followed by the
   * runner's own re-run, or a new request.
   */
  private verifyOutcome(batch: BatchRow): "pending" | Verification {
    const { db } = this.deps;
    const policies = todaysPolicies(this.deps.config(), batch.project_id)!;
    const ref = batchRef(batch.project_id, batch.id);
    const request = batch.request_id ? getRequest(db, batch.request_id) : null;
    if (request && request.policy_id === policies.full) {
      if (request.state === "queued") return "pending";
      if (request.state === "started" && request.verification_id) {
        const v = getVerification(db, request.verification_id);
        if (v?.state === "running") return "pending";
        if (v && !interruptedByStop(v)) return v;
      }
    } else {
      const done = finishedAtHead(db, ref, batch.head_sha, policies.full);
      if (done && !interruptedByStop(done) && batch.retried_head !== batch.head_sha) return done;
    }
    const running = runningVerifications(db).find((v) => v.pr_url === ref && v.head_sha === batch.head_sha && v.policy_id === policies.full);
    if (running) return "pending";
    const cancelled = (db.query("SELECT COUNT(*) AS n FROM verify_queue WHERE pr_url = ?1 AND head_sha = ?2 AND state = 'cancelled'").get(ref, batch.head_sha) as { n: number }).n;
    if (cancelled >= MAX_VERIFY_LOSSES && !findQueued(db, ref, batch.head_sha, policies.full)) {
      tx(db, () => this.hold(batch, "verify_cancelled", `its verify was cancelled ${cancelled} times; the last: ${request?.detail ?? "-"}`, null));
      return "pending";
    }
    tx(db, () => {
      const now = this.deps.now();
      const next = findQueued(db, ref, batch.head_sha, policies.full) ?? this.queueVerify(batch, policies.full, now);
      db.query("UPDATE landing_batches SET request_id = ?2, updated_at = ?3 WHERE id = ?1").run(batch.id, next.id, now);
    });
    this.deps.kickScheduler();
    return "pending";
  }

  private queueVerify(batch: BatchRow, policy: string, now: number) {
    const { db } = this.deps;
    return insertRequest(db, { project_id: batch.project_id, pr_url: batchRef(batch.project_id, batch.id), task_id: null, head_sha: batch.head_sha, policy_id: policy, pr_number: null, head_ref: null, worktree: null, source: "auto", path: autoVerifyPath(db, batch.project_id), now });
  }

  /** A verify that did not pass: a timeout runs once more; anything else holds the batch with its likely culprit. */
  private async failed(batch: BatchRow, project: ProjectRow, v: Verification, main: string): Promise<void> {
    const { db } = this.deps;
    const verdict = verifyVerdict(v);
    if ("rerun" in verdict && !autoRerunAt(db, v.pr_url, v.head_sha)) {
      tx(db, () => {
        const request = queueAutoRerun(db, this.deps.config(), v, verdict.rerun, null, this.deps.now());
        db.query("UPDATE landing_batches SET request_id = ?2, updated_at = ?3 WHERE id = ?1").run(batch.id, request.id, this.deps.now());
      });
      this.deps.kickScheduler();
      return;
    }
    const step = v.steps.find((s) => s.state === "failed") ?? null;
    const tail = step ? cleanTail(join(v.dir, step.log)) : "";
    const files = await this.memberFiles(project, batchMembers(db, batch.id), main);
    const culprit = likelyCulprit(tail, files.map((f) => ({ task: f.row.task_id, files: f.changed })));
    const what = step ? `verify ${v.id} failed at \`${step.name}\`${step.exit !== null ? ` (exit ${step.exit})` : ""}` : `verify ${v.id} ${v.state}: ${v.detail ?? "no detail"}`;
    const hint = culprit.task ? `likely ${culprit.task}: ${culprit.why}` : culprit.why;
    tx(db, () => {
      const fresh = getBatch(db, batch.id);
      if (fresh?.state !== "verifying") return;
      this.hold(fresh, "verify_failed", `${what}; ${hint}`, culprit.task, v.id);
    });
  }

  /** Hold the batch for the leader, with one landing_batch_held item naming the next commands. Call inside a transaction. */
  private hold(batch: BatchRow, reason: string, detail: string, culprit: string | null, verification: string | null = null): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const members = batchMembers(db, batch.id);
    const drop = culprit ?? members[0]?.task_id ?? "<task>";
    const next = `flowryn batch drop ${batch.id} ${drop}${reason === "verify_failed" && batch.retried_head !== batch.head_sha ? ` | flowryn batch retry ${batch.id}` : ""}`;
    const seq = this.moveBatch(batch, "held", { reason, detail, culprit, verification_id: verification ?? batch.verification_id }, now);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_held", now);
    // The digest keeps the next commands whole: the reason is cut first (the batch keeps it whole, show lb<N> prints it).
    const line = `Landing batch ${batch.id} (${batch.project_id}, ${members.length}) held: ${sanitizeLine(detail, HELD_DETAIL_CHARS)}. Next: ${next}`;
    const item = openItem(db, { kind: "landing_batch_held", eventSeq: seq, line, now });
    db.query("UPDATE landing_batches SET item_id = ?2 WHERE id = ?1").run(batch.id, item);
  }

  /**
   * Land a green batch: every member passes the merge gate, then local main fast-forwards to the
   * batch head once, then each member's merge is recorded through the merge verb's path (its own
   * fast-forward is then a no-op: its head is on main). A member the gate refuses leaves and the
   * batch is rebuilt without it, unless main already holds the batch, when it is held for the leader.
   */
  private async land(batch: BatchRow, project: ProjectRow): Promise<void> {
    const { db, git } = this.deps;
    const delivery = this.deps.delivery;
    if (!delivery) {
      this.deps.log(`landing batch ${batch.id}: no merge services in this process; it waits`);
      return;
    }
    const services: MergeServices = { db, config: this.deps.config, delivery, now: this.deps.now, log: this.deps.log };
    const main = await this.mainTip(project);
    if (!main) return;
    const onMain = await this.isAncestor(project.path, batch.head_sha, main);
    if (!onMain && !(await this.isAncestor(project.path, main, batch.head_sha))) {
      await this.rebuild(batch, project, `main moved to ${main.slice(0, 8)} before it landed`, batch.integrations + 1);
      return;
    }
    const prepared: { row: LandingRow; prepared: MergePrepared }[] = [];
    for (const row of batchMembers(db, batch.id)) {
      const run = getRunWithPolicy(db, row.run_id);
      if (!run || run.state === "landed" || run.state === "cleaned") continue;
      try {
        prepared.push({ row, prepared: await prepareDaemonMerge(services, row.task_id) });
      } catch (error) {
        if (!(error instanceof FlowrynError)) throw error;
        if (error.refusalEvent) {
          tx(db, () => appendEvent(db, error.refusalEvent!));
          return;
        }
        if (RETRY_CODES.has(error.code)) return;
        if (REVERIFY_CODES.has(error.code) && !onMain) {
          await this.rebuild(batch, project, `the gate refused its verify for ${row.task_id}: ${error.message}`, batch.integrations);
          return;
        }
        if (error.code === "primary_checkout_tangle" || onMain) {
          tx(db, () => this.landingStuck(getBatch(db, batch.id)!, `${row.task_id}: ${error.message}`));
          return;
        }
        tx(db, () => this.ops.leave(row, `gate:${error.code}`, `the merge gate refused it in landing batch ${batch.id}: ${error.message}`, this.deps.now(), { next: error.help ?? `flowryn show ${row.task_id}` }));
        await this.rebuild(getBatch(db, batch.id)!, project, `the merge gate refused ${row.task_id} (${error.code})`, batch.integrations);
        return;
      }
    }
    if (!onMain) {
      const forwarded = await git(["merge", "--ff-only", "--quiet", batch.head_sha], project.path);
      if (forwarded.code !== 0) {
        tx(db, () => this.landingStuck(getBatch(db, batch.id)!, `git could not fast-forward ${project.default_branch} to ${batch.head_sha.slice(0, 8)}: ${(forwarded.stderr || forwarded.stdout).trim()}`));
        return;
      }
      tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_forwarded", payload: { batch: batch.id, project: project.id, from: main, to: batch.head_sha }, ts: this.deps.now() }));
    }
    for (const { row, prepared: p } of prepared) {
      try {
        const applied = tx(db, () => applyMerge(services, p, DAEMON_CALLER));
        await settleMerge(services, applied, DAEMON_CALLER);
      } catch (error) {
        if (!(error instanceof FlowrynError)) throw error;
        this.deps.log(`landing batch ${batch.id}: ${row.task_id}: ${error.message}`);
      }
    }
    tx(db, () => this.settleLanded(batch.id));
  }

  /** Members whose runs landed are landed; once every member is, the batch is. Call inside a transaction. */
  private settleLanded(batchId: string): void {
    const { db } = this.deps;
    const batch = getBatch(db, batchId);
    if (batch?.state !== "landing") return;
    const now = this.deps.now();
    let open = 0;
    for (const row of batchMembers(db, batch.id)) {
      const run = getRunWithPolicy(db, row.run_id);
      if (run && (run.state === "landed" || run.state === "cleaned")) this.ops.move(row, "landed", {}, now);
      else open++;
    }
    if (open > 0) return;
    const landed = batchRows(db, batch.id).filter((r) => r.state === "landed");
    this.moveBatch(batch, "landed", { detail: `${landed.length} branch${landed.length === 1 ? "" : "es"} landed at ${batch.head_sha.slice(0, 8)}` }, now);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_landed", now);
    this.ops.refreshLine(batch.project_id);
  }

  /** A green batch that cannot land now (the project checkout, or a member on main the gate refused): an item for the leader, retried each pass. Call inside a transaction. */
  private landingStuck(batch: BatchRow, why: string): void {
    const { db } = this.deps;
    if (batch.detail === why && batch.item_id) return;
    const now = this.deps.now();
    const seq = this.moveBatch(batch, "landing", { detail: why }, now);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_stuck", now);
    const item = openItem(db, { kind: "landing_batch_held", eventSeq: seq, line: `Landing batch ${batch.id} (${batch.project_id}) passed but cannot land: ${sanitizeLine(why, HELD_DETAIL_CHARS)}; it tries again each pass. Next: flowryn show ${batch.id}`, now });
    db.query("UPDATE landing_batches SET item_id = ?2 WHERE id = ?1").run(batch.id, item);
  }

  /**
   * Start a batch from the project's waiting entries: judge their light checks, then merge every
   * eligible one onto main. `members` are the waiting, non-sensitive entries in line order.
   */
  async build(project: ProjectRow, waiting: LandingRow[]): Promise<void> {
    const eligible = await this.lightChecks(project, waiting);
    if (eligible.length === 0) return;
    await this.assemble(project, eligible.slice(0, MAX_BATCH), 0);
  }

  /**
   * Each waiting entry's light check: queue one where none waits, runs or finished at its head;
   * judge one that did not pass. Runs while a batch is in flight too, so the next batch is ready
   * when it lands. Returns the entries whose light check passed (all of them when
   * the project has none), in line order.
   */
  async lightChecks(project: ProjectRow, waiting: LandingRow[]): Promise<LandingRow[]> {
    const { db } = this.deps;
    const policies = todaysPolicies(this.deps.config(), project.id);
    if (!policies) return [];
    if (!policies.light) return waiting;
    const light = policies.light;
    const eligible: LandingRow[] = [];
    let queued = false;
    for (const row of waiting) {
      if (findQueued(db, row.ref, row.head_sha, light)) continue;
      if (runningVerifications(db).some((v) => v.pr_url === row.ref && v.head_sha === row.head_sha && v.policy_id === light)) continue;
      const done = finishedAtHead(db, row.ref, row.head_sha, light);
      if (done && !interruptedByStop(done)) {
        if (done.state === "passed") eligible.push(row);
        else tx(db, () => this.judgeLight(row, done, light));
        continue;
      }
      tx(db, () => {
        const now = this.deps.now();
        insertRequest(db, { project_id: row.project_id, pr_url: row.ref, task_id: row.task_id, head_sha: row.head_sha, policy_id: light, pr_number: null, head_ref: null, worktree: null, source: "auto", path: autoVerifyPath(db, row.project_id), now });
        appendEvent(db, { source: "daemon", kind: "landing.light_queued", runId: row.run_id, taskId: row.task_id, payload: { landing: row.id, head: row.head_sha, policy: light }, ts: now });
      });
      queued = true;
    }
    if (queued) {
      tx(db, () => this.ops.refreshLine(project.id));
      this.deps.kickScheduler();
    }
    return eligible;
  }

  /** A light check that did not pass: back to the worker (a failing step, once per head), once more (a timeout), or held. Call inside a transaction. */
  private judgeLight(row: LandingRow, v: Verification, policy: string): void {
    const { db } = this.deps;
    const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(row.id) as LandingRow | null;
    const run = getRunWithPolicy(db, row.run_id);
    if (fresh?.state !== "waiting" || !run || run.state !== "ready") return;
    const now = this.deps.now();
    const route = routeVerifyOutcome(db, v, run);
    if (route.route === "rerun") {
      queueAutoRerun(db, this.deps.config(), v, route.step, run.id, now, policy);
      this.deps.kickScheduler();
      return;
    }
    if (route.route === "send_back") {
      this.ops.leave(fresh, "light_failed", `light check ${v.id} failed: \`${route.step.name}\` exited ${route.step.exit}`, now);
      sendBack(
        db,
        run,
        {
          text: `${sendBackText(v, route.step, "Light check")}\nIt ran on your branch as delivered, before it may join a landing batch.`,
          feedback: `light check ${v.id} failed`,
          why: `the light check ${v.id} failed`,
          event: { source: "daemon", kind: SENT_BACK_KIND, payload: sentBackPayload(v, route.step, "auto_merge", { landing: row.id, light: true }) },
        },
        now,
      );
      this.deps.kickScheduler();
      return;
    }
    if (route.route === "escalate") {
      recordEscalation(db, v, route, run.id, "auto_merge", now, { landing: row.id, light: true });
      this.ops.leave(fresh, `held:${route.code}`, `light check: ${route.detail}`, now, { next: `flowryn verify show ${v.id}` });
    }
  }

  /**
   * Merge `members` onto main's tip in the object store and start the batch: the clash check,
   * then one merge commit per member (the first taken as it is when it holds main). Members may
   * be waiting, or landing in the batch this one replaces.
   */
  private async assemble(project: ProjectRow, members: LandingRow[], integrations: number, replaces: BatchRow | null = null): Promise<void> {
    const { db, git } = this.deps;
    const policies = todaysPolicies(this.deps.config(), project.id);
    const main = await this.mainTip(project);
    if (!policies || !main) return;
    const files = await this.memberFiles(project, members, main);
    const clashes = numberClashes(files.map((f) => ({ task: f.row.task_id, files: f.added })));
    let tip = main;
    const taken: LandingRow[] = [];
    const skipped: { task: string; why: string }[] = [];
    for (const member of members) {
      const clash = clashes.find((c) => c.task === member.task_id);
      if (clash) {
        tx(db, () => this.sendClash(member, clash.path, clash.with, clash.withPath));
        continue;
      }
      const run = getRunWithPolicy(db, member.run_id);
      if (!run) continue;
      if (taken.length === 0 && (await this.isAncestor(project.path, main, member.head_sha))) {
        tip = member.head_sha;
        taken.push(member);
        continue;
      }
      const merged = await mergeInStore(git, project.path, tip, member.head_sha, batchMergeMessage(run.branch, member.task_id, main));
      if ("head" in merged) {
        tip = merged.head;
        taken.push(member);
        continue;
      }
      if ("error" in merged) {
        this.deps.log(`landing batch: ${member.task_id}: ${merged.error}`);
        skipped.push({ task: member.task_id, why: merged.error });
        continue;
      }
      // A conflict: with main itself it goes back to its worker; with an earlier member it waits for the next batch.
      const alone = taken.length === 0 ? merged : await mergeInStore(git, project.path, main, member.head_sha, "probe");
      const delivered = deliveredOf(db, member.task_id);
      if ("conflict" in alone && delivered) {
        if (member.state === "landing") tx(db, () => this.ops.move(member, "waiting", { batch_id: null, batch_pos: null }, this.deps.now()));
        const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(member.id) as LandingRow;
        this.ops.sendConflict(fresh, run, delivered, project.default_branch, alone.conflict);
        continue;
      }
      const why = `merging it onto ${taken.map((t) => t.task_id).join(", ")} conflicts in ${merged.conflict.slice(0, 5).join(", ")}`;
      skipped.push({ task: member.task_id, why });
      tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_skipped", runId: member.run_id, taskId: member.task_id, payload: { landing: member.id, head: member.head_sha, main, with: taken.map((t) => t.task_id), files: merged.conflict.slice(0, 20), why }, ts: this.deps.now() }));
    }
    tx(db, () => {
      const now = this.deps.now();
      const old = replaces ? getBatch(db, replaces.id) : null;
      if (replaces && old && (old.state === "verifying" || old.state === "landing" || old.state === "held")) this.dissolve(old, "rebuilt", replaces.detail ?? "rebuilt", null);
      // What stayed out of the new batch goes back to waiting for the next one.
      for (const member of members) {
        const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(member.id) as LandingRow | null;
        if (fresh?.state === "landing" && !taken.some((t) => t.id === fresh.id)) this.ops.move(fresh, "waiting", { batch_id: null, batch_pos: null }, now);
      }
      const current = taken
        .map((t) => db.query("SELECT * FROM landing_queue WHERE id = ?1").get(t.id) as LandingRow | null)
        .filter((r): r is LandingRow => r !== null && r.head_sha === members.find((m) => m.id === r.id)?.head_sha && (r.state === "waiting" || r.state === "landing"));
      if (current.length !== taken.length || current.length === 0) {
        for (const r of current) if (r.state === "landing") this.ops.move(r, "waiting", { batch_id: null, batch_pos: null }, now);
        return;
      }
      if (liveBatch(db, project.id)) {
        for (const r of current) if (r.state === "landing") this.ops.move(r, "waiting", { batch_id: null, batch_pos: null }, now);
        return;
      }
      const next = Number(getMeta(db, "next_landing_batch_no") ?? "1");
      setMeta(db, "next_landing_batch_no", String(next + 1));
      const id = `lb${next}`;
      db.query(
        `INSERT INTO landing_batches (id, project_id, state, base_sha, head_sha, integrations, created_at, state_since, updated_at)
         VALUES (?1, ?2, 'verifying', ?3, ?4, ?5, ?6, ?6, ?6)`,
      ).run(id, project.id, main, tip, integrations, now);
      const batch = getBatch(db, id)!;
      const request = findQueued(db, batchRef(project.id, id), tip, policies.full) ?? this.queueVerify(batch, policies.full, now);
      db.query("UPDATE landing_batches SET request_id = ?2 WHERE id = ?1").run(id, request.id);
      current.forEach((row, i) => this.ops.move(row, "landing", { batch_id: id, batch_pos: i + 1, detail: `in landing batch ${id}`, reason: null }, now));
      appendEvent(db, {
        source: "daemon",
        kind: "landing.batch_built",
        payload: { batch: id, project: project.id, base: main, head: tip, request: request.id, members: current.map((r, i) => ({ task: r.task_id, head: r.head_sha, pos: i + 1 })), left_out: skipped, replaces: replaces?.id ?? null, integrations },
        ts: now,
      });
      this.ops.refreshLine(project.id);
    });
    this.deps.kickScheduler();
  }

  /** A batch whose members changed or whose base moved: a new batch of the members left, built on main as it is now. */
  private async rebuild(batch: BatchRow, project: ProjectRow, why: string, integrations: number): Promise<void> {
    const { db } = this.deps;
    const members = batchMembers(db, batch.id);
    tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_rebuilt", payload: { batch: batch.id, project: project.id, why, members: members.map((m) => m.task_id) }, ts: this.deps.now() }));
    if (members.length === 0) {
      tx(db, () => this.dissolve(getBatch(db, batch.id)!, "emptied", why, "waiting"));
      return;
    }
    await this.assemble(project, members, integrations, { ...batch, detail: why });
  }

  /**
   * End a live batch: its queued verify cancelled, its item resolved, and its members (when `members`
   * says so) back to waiting for the next batch, with nothing sent back. Call inside a transaction.
   */
  private dissolve(batch: BatchRow, reason: string, detail: string, members: "waiting" | null): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const request = batch.request_id ? getRequest(db, batch.request_id) : null;
    if (request?.state === "queued") cancelRequest(db, request, `landing batch ${batch.id} ended: ${detail}`, now);
    if (batch.item_id) resolveItem(db, batch.item_id, `landing.batch_${reason}`, now);
    if (members === "waiting") for (const row of batchMembers(db, batch.id)) this.ops.move(row, "waiting", { batch_id: null, batch_pos: null, detail: `landing batch ${batch.id} ended: ${detail}` }, now);
    this.moveBatch(batch, "dissolved", { reason, detail }, now);
    this.ops.refreshLine(batch.project_id);
  }

  /** The later of two members adding the same numbered migration goes back to renumber it. Call inside a transaction. */
  private sendClash(row: LandingRow, path: string, withTask: string, withPath: string): void {
    const { db } = this.deps;
    const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(row.id) as LandingRow | null;
    const run = getRunWithPolicy(db, row.run_id);
    if (!fresh || (fresh.state !== "waiting" && fresh.state !== "landing") || !run || run.state !== "ready") return;
    const now = this.deps.now();
    const detail = `${path} takes the same migration number as ${withTask}'s ${withPath}`;
    this.ops.leave(fresh, "number_clash", detail, now);
    sendBack(
      db,
      run,
      {
        text: `Landing batch: your branch adds ${path}, and ${withTask}, ahead of you in the landing batch, adds ${withPath} with the same migration number. Renumber yours (the next free number after main and ${withTask}), commit, and deliver again.`,
        feedback: "migration number clash in a landing batch",
        why: `its migration number clashes with ${withTask}`,
        event: { source: "daemon", kind: "landing.batch_clash", payload: { landing: row.id, path, with: withTask, with_path: withPath } },
      },
      now,
    );
    this.deps.kickScheduler();
  }

  // --- the leader's verbs -------------------------------------------------------------------

  /**
   * `flowryn batch drop <batch> <task>`: the member leaves and goes back to its worker with the
   * failing step's tail; a new batch of the rest is built and verified on the next pass. Call
   * inside a transaction.
   */
  drop(batchId: string, taskId: string, source: EventSource = "cli"): { batch: BatchRow; dropped: LandingRow } {
    const { db } = this.deps;
    const batch = getBatch(db, batchId);
    if (!batch) throw new FlowrynError("not_found", `no landing batch ${batchId}`, "flowryn fleet");
    if (batch.state !== "held") throw new FlowrynError("not_ready", `landing batch ${batchId} is ${batch.state}; only a held batch drops a branch`, `flowryn show ${batchId}`);
    const row = batchMembers(db, batch.id).find((r) => r.task_id === taskId);
    if (!row) throw new FlowrynError("not_found", `${taskId} is not in landing batch ${batchId} (it has ${batchMembers(db, batch.id).map((r) => r.task_id).join(", ") || "no branches"})`, `flowryn show ${batchId}`);
    const now = this.deps.now();
    const v = batch.verification_id ? getVerification(db, batch.verification_id) : null;
    const step = v?.steps.find((s) => s.state === "failed") ?? null;
    const dropped = this.ops.leave(row, "dropped", `the leader dropped it from landing batch ${batch.id}${batch.detail ? `: ${batch.detail}` : ""}`, now);
    const run = getRunWithPolicy(db, row.run_id);
    if (run && run.state === "ready") {
      const why = batch.culprit === taskId && batch.detail ? ` It was named the likely culprit: ${batch.detail}.` : "";
      sendBack(
        db,
        run,
        {
          text: `${v && step ? sendBackText(v, step, "Landing batch") : `Landing batch ${batch.id} failed its verify.`}\nYour leader dropped your branch from landing batch ${batch.id}.${why} The batch's verify ran on main with every branch in it merged; merge main into your branch to reproduce it, fix it, commit, and deliver again.`,
          feedback: `dropped from landing batch ${batch.id}`,
          why: `dropped from landing batch ${batch.id}`,
          event: { source, kind: "landing.batch_dropped", payload: { batch: batch.id, landing: row.id, verification: v?.id ?? null, step: step?.name ?? null } },
        },
        now,
      );
    } else {
      appendEvent(db, { source, kind: "landing.batch_dropped", runId: row.run_id, taskId: row.task_id, payload: { batch: batch.id, landing: row.id, verification: v?.id ?? null, step: step?.name ?? null }, ts: now });
    }
    this.deps.kickScheduler();
    return { batch: getBatch(db, batch.id)!, dropped };
  }

  /** `flowryn batch retry <batch>`: verify the held batch's head once more (a load flake); once per head. Call inside a transaction. */
  retry(batchId: string, source: EventSource = "cli"): BatchRow {
    const { db } = this.deps;
    const batch = getBatch(db, batchId);
    if (!batch) throw new FlowrynError("not_found", `no landing batch ${batchId}`, "flowryn fleet");
    if (batch.state !== "held") throw new FlowrynError("not_ready", `landing batch ${batchId} is ${batch.state}; only a held batch is retried`, `flowryn show ${batchId}`);
    if (batch.retried_head === batch.head_sha) throw new FlowrynError("not_ready", `landing batch ${batchId} was already retried at ${batch.head_sha.slice(0, 8)}; drop a branch instead`, `flowryn batch drop ${batchId} ${batch.culprit ?? "<task>"}`);
    const policies = todaysPolicies(this.deps.config(), batch.project_id);
    if (!policies) throw new FlowrynError("not_ready", `project ${batch.project_id} has no verify steps now`);
    const now = this.deps.now();
    const request = findQueued(db, batchRef(batch.project_id, batch.id), batch.head_sha, policies.full) ?? this.queueVerify(batch, policies.full, now);
    db.query("UPDATE landing_batches SET retried_head = ?2, request_id = ?3, culprit = NULL WHERE id = ?1").run(batch.id, batch.head_sha, request.id);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_retried", now);
    this.moveBatch({ ...batch, request_id: request.id, retried_head: batch.head_sha, culprit: null }, "verifying", { reason: null, detail: `retried by the leader (${request.id})` }, now, source, "landing.batch_retried");
    this.deps.kickScheduler();
    return getBatch(db, batch.id)!;
  }

  // --- helpers --------------------------------------------------------------------------------

  /**
   * Move a batch to `to` with its event (`landing.batch_<to>`, or `kind`); returns the event's seq.
   * Call inside a transaction.
   */
  private moveBatch(
    batch: BatchRow,
    to: BatchState,
    fields: { reason?: string | null; detail?: string | null; culprit?: string | null; verification_id?: string | null },
    now: number,
    source: EventSource = "daemon",
    kind = `landing.batch_${to}`,
  ): number {
    const { db } = this.deps;
    const next = { ...batch, ...fields };
    db.query("UPDATE landing_batches SET state = ?2, reason = ?3, detail = ?4, culprit = ?5, verification_id = ?6, state_since = ?7, updated_at = ?8, item_id = CASE WHEN ?2 IN ('landed','dissolved') THEN NULL ELSE item_id END WHERE id = ?1").run(
      batch.id,
      to,
      next.reason,
      next.detail,
      next.culprit,
      next.verification_id,
      to === batch.state ? batch.state_since : now,
      now,
    );
    return appendEvent(db, { source, kind, payload: { batch: batch.id, project: batch.project_id, from: batch.state, head: batch.head_sha, reason: next.reason, detail: next.detail, culprit: next.culprit, verification: next.verification_id }, ts: now }).seq;
  }

  /** Each member's changed and added files against main (merge-base diffs), for the clash check and the culprit hint. */
  private async memberFiles(project: ProjectRow, members: LandingRow[], main: string): Promise<MemberFiles[]> {
    const out: MemberFiles[] = [];
    for (const row of members) {
      const changed = await this.deps.git(["diff", "--name-only", "--no-renames", `${main}...${row.head_sha}`], project.path);
      const added = await this.deps.git(["diff", "--name-only", "--no-renames", "--diff-filter=A", `${main}...${row.head_sha}`], project.path);
      if (changed.code !== 0) this.deps.log(`landing batch: cannot list ${row.task_id}'s changes: git exited ${changed.code}`);
      out.push({ row, changed: fileList(changed), added: fileList(added) });
    }
    return out;
  }

  private async mainTip(project: ProjectRow): Promise<string | null> {
    const read = await this.deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${project.default_branch}^{commit}`], project.path);
    const sha = read.stdout.trim();
    if (read.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    this.deps.log(`landing batch ${project.id}: cannot read local ${project.default_branch}: ${read.stderr.trim() || `git exited ${read.code}`}`);
    return null;
  }

  private async isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
    if (ancestor === of) return true;
    return (await this.deps.git(["merge-base", "--is-ancestor", ancestor, of], cwd)).code === 0;
  }
}

/**
 * The board's LANDING section (src/cli/commands/board.ts): per project that batches, its live
 * batch with its members, then the entries forming the next batch with their light checks.
 * Empty when no project batches.
 */
export function landingBoardLines(db: Db): string[] {
  const projects = db.query("SELECT DISTINCT project_id FROM landing_batches ORDER BY 1").all() as { project_id: string }[];
  const lines: string[] = [];
  for (const { project_id: project } of projects) {
    const batch = liveBatch(db, project);
    const waiting = db.query("SELECT * FROM landing_queue WHERE project_id = ?1 AND state = 'waiting' ORDER BY enqueued_at, CAST(substr(id, 3) AS INTEGER)").all(project) as LandingRow[];
    if (!batch && waiting.length === 0) continue;
    if (batch) {
      lines.push(`  ${project}  ${batchLine(db, batch)}`);
      for (const row of batchMembers(db, batch.id)) lines.push(`    ${row.batch_pos ?? "-"} ${row.task_id}`);
    } else lines.push(`  ${project}  no batch in flight`);
    if (waiting.length > 0) lines.push(`    next batch: ${waiting.length} waiting · ${waiting.slice(0, 4).map((r) => `${r.task_id} ${lightCheckState(db, r) ?? "waiting"}`).join(" · ")}${waiting.length > 4 ? " · …" : ""}`);
  }
  return lines;
}

/** `show lb<N>`: the batch, its members and where its verify stands. */
export function batchView(db: Db, batch: BatchRow): Record<string, unknown> {
  const rows = batchRows(db, batch.id);
  return {
    batch: batch.id,
    project: batch.project_id,
    state: batch.state,
    line: batchLine(db, batch),
    base: batch.base_sha,
    head: batch.head_sha,
    verify: batchVerify(db, batch) ?? "-",
    request: batch.request_id ?? "-",
    culprit: batch.culprit ?? "-",
    reason: batch.reason ?? "-",
    detail: batch.detail ?? "-",
    integrations: batch.integrations,
    retried: batch.retried_head === batch.head_sha,
    members: rows.map((r) => ({ task: r.task_id, pos: r.batch_pos, head: r.head_sha.slice(0, 8), state: r.state, ...(r.reason ? { reason: r.reason } : {}) })),
  };
}

