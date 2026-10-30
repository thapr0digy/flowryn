import { findOpenRunItem, openItem, resolveRunItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { ForgeError, type Forge, type PullRequest } from "../forge/types.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { deliveredOf, prEvidence, projectRepo } from "./delivery.ts";
import { isDropped } from "./drop.ts";
import { waitingOn } from "./plans.ts";
import { getProject } from "./projects.ts";
import { getRunWithPolicy, runBase, taskTitle, type RunRow, type RunWithPolicy } from "./runs.ts";
import { sendBack } from "./send-back.ts";
import { createSteer } from "./steers.ts";

/**
 * Stacked plans (docs/notes/2026-10-27-stack-a-plan-4y.md, phase 2): a phase
 * of a plan filed with `stack: on` starts on the open PR of the one task it
 * still waits for, from that task's branch and with that branch as its base
 * (`runs.stacked_on`). Its merge is refused until the task beneath lands
 * (src/policy/merge.ts). When it lands, the delivery watcher's pass points
 * the stacked PR at the landed run's own base and sends the worker the exact
 * merges that take that base in cleanly after a squash merge. All plain code:
 * lookups over the database, git and the forge.
 */

/** A phase never stacks on more than this many open PRs (the task beneath it and the ones that one sits on). */
export const MAX_STACK_DEPTH = 3;

/** What a stacked phase starts on: the task beneath it, its run, branch and delivered head. */
export interface StackBase {
  task: string;
  run: string;
  branch: string;
  head: string;
  ref: string;
}

export type Readiness = { ready: true; stack: StackBase | null } | { ready: false; waiting: string[]; why: string | null };

const ENDED = ["landed", "cleaned", "failed", "cancelled"];

function latestRun(db: Db, taskId: string): RunRow | null {
  return db.query("SELECT * FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as RunRow | null;
}

/** Is the task a phase of a stacked plan? */
export function inStackedPlan(db: Db, taskId: string): boolean {
  return db.query("SELECT 1 FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1 AND pl.stack = 1").get(taskId) !== null;
}

/** The open PRs a run stacked on `taskId` would sit on: that task and the stacked tasks beneath it. */
export function depthBeneath(db: Db, taskId: string): number {
  const seen = new Set<string>();
  let task: string | null = taskId;
  while (task !== null && !seen.has(task)) {
    seen.add(task);
    const run = latestRun(db, task);
    task = run && !ENDED.includes(run.state) ? run.stacked_on : null;
  }
  return seen.size;
}

/**
 * Can `taskId` stack on `blocker` now? The blocker's latest run is a delivered
 * ship of the same project with an open, non-draft PR, and fewer than
 * MAX_STACK_DEPTH open PRs sit beneath the new one. A string says why not.
 */
export function stackBaseFor(db: Db, taskId: string, blocker: string): StackBase | string {
  const own = db.query("SELECT project_id, delivery_mode FROM task_policy WHERE task_id = ?1").get(taskId) as { project_id: string; delivery_mode: string } | null;
  if (own?.delivery_mode === "local-only") return "it ships local-only, which opens no PR to stack on";
  const policy = db.query("SELECT kind, project_id FROM task_policy WHERE task_id = ?1").get(blocker) as { kind: string; project_id: string } | null;
  if (!policy || policy.kind !== "ship") return `${blocker} is not a ship Flowryn runs`;
  if (own && own.project_id !== policy.project_id) return `${blocker} belongs to project ${policy.project_id}`;
  const run = latestRun(db, blocker);
  if (!run || run.state !== "ready") return `${blocker} has not delivered`;
  const delivered = deliveredOf(db, blocker);
  if (!delivered || delivered.kind !== "pr") return `${blocker} has no PR`;
  const evidence = prEvidence(db, run.id);
  if (evidence && (evidence.state !== "open" || evidence.draft)) return `${blocker}'s PR is ${evidence.draft ? "a draft" : evidence.state}`;
  if (depthBeneath(db, blocker) >= MAX_STACK_DEPTH) return `${MAX_STACK_DEPTH} stacked PRs already sit beneath it`;
  return { task: blocker, run: run.id, branch: run.branch, head: delivered.head, ref: delivered.ref };
}

/**
 * Is a queued phase ready to start? Ready when every blocker has landed; in a
 * stacked plan also when all have landed but one that can be stacked on
 * (stackBaseFor), and then it starts on that one.
 */
export function phaseReadiness(db: Db, taskId: string, backlog: BacklogTask[] | null, planDeps: string[]): Readiness {
  const waiting = waitingOn(db, taskId, backlog, planDeps);
  if (waiting.length === 0) return { ready: true, stack: null };
  if (waiting.length !== 1 || !inStackedPlan(db, taskId)) return { ready: false, waiting, why: null };
  const base = stackBaseFor(db, taskId, waiting[0]!);
  return typeof base === "string" ? { ready: false, waiting, why: base } : { ready: true, stack: base };
}

/**
 * The merges that take a landed base into a stacked branch with new commits.
 * After a squash merge a plain merge of the base conflicts wherever the
 * stacked work changed lines the task beneath added, so the worker merges
 * that task's final head, the base just before the landing, the landing
 * itself with the ours strategy (the branch already holds its content: the
 * gate merges exactly the delivered head), then the base. The same steps are
 * right for a merge-commit landing.
 */
export function takeBaseSteps(base: string, landedHead: string, mergeSha: string): string {
  return [
    `git fetch origin ${base}`,
    `git merge --no-edit ${landedHead}`,
    `git merge --no-edit ${mergeSha}^1`,
    `git merge --no-edit -s ours ${mergeSha}`,
    `git merge --no-edit origin/${base}`,
  ].join("\n");
}

/** The steer or send-back text for a stacked run whose base landed. */
export function retargetText(blocker: string, base: string, landedHead: string, mergeSha: string, delivered: boolean, landedPr: number | null): string {
  const missing = landedPr !== null ? `git fetch origin refs/pull/${landedPr}/head` : `git fetch origin ${landedHead}`;
  return [
    `${blocker}, the task beneath you, landed in ${base} at ${mergeSha.slice(0, 8)}. Your base is now ${base}${delivered ? ", and your PR now targets it" : ""}: open or keep your PR into ${base}, and pass --base-branch ${base} on a no-mistakes axi run only when ${base} is not the default branch.`,
    `Take it in with exactly these merges, each a new commit (never rebase), in your worktree. ${landedHead.slice(0, 8)} is ${blocker}'s final head; if git lacks it, first: ${missing}`,
    takeBaseSteps(base, landedHead, mergeSha),
    delivered ? "Then run the tests, ship, and deliver again." : "Then carry on.",
  ].join("\n");
}

/**
 * A task delivered a new head: every working run stacked on it is told to
 * merge it in. A delivered stacked run waits: the landing's merges take the
 * final head first. Returns the steered runs. Call inside a transaction.
 */
export function steerStackedOnRedelivery(db: Db, taskId: string, previousHead: string | null, head: string, branch: string, now: number): string[] {
  if (previousHead === null || previousHead === head) return [];
  const runs = db.query("SELECT * FROM runs WHERE stacked_on = ?1 AND state IN ('launching','running','validating')").all(taskId) as RunRow[];
  for (const run of runs) {
    createSteer(db, run, `${taskId}, the task beneath you, delivered a new head ${head.slice(0, 8)}. Take it in with a new commit (never rebase): git fetch origin ${branch} && git merge --no-edit origin/${branch}`, now);
    appendEvent(db, { source: "cli", kind: "stack.followed", runId: run.id, taskId: run.task_id, payload: { on: taskId, head }, ts: now });
  }
  return runs.map((r) => r.id);
}

export interface StackDeps {
  db: Db;
  forge(): Forge;
  webUrl(): string;
  now(): number;
  log(line: string): void;
  /** A sent-back run's last stage waits for a grant: the scheduler looks now. */
  kickScheduler(): void;
  /** A steer was recorded for a live run: ring it now. */
  notifySteer?(runId: string): void;
}

/** The landing proof's merge commit for a run, from its run.landed event. */
function landedMergeSha(db: Db, runId: string): string | null {
  const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.landed' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | null;
  if (!row) return null;
  const sha = (JSON.parse(row.payload) as { merge_sha?: unknown }).merge_sha;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

/** Why a stacked run's base can no longer land beneath it, or null while it still can. */
function baseLost(db: Db, blocker: string): string | null {
  if (isDropped(db, blocker)) return `${blocker} was dropped`;
  const run = latestRun(db, blocker);
  if (!run) return `${blocker} has no run`;
  if (run.state === "failed" || run.state === "cancelled") return `${blocker}'s run ${run.state}`;
  if (run.state === "ready" && prEvidence(db, run.id)?.state === "closed") return `${blocker}'s PR was closed without merging`;
  return null;
}

/**
 * One pass over the stacked runs (the delivery watcher's): a run whose base
 * landed has its open PRs pointed at the landed run's base, then its base
 * updated and `stacked_on` cleared (`run.retargeted`); a delivered run is
 * sent back with the merges to run, a working one steered. A forge failure
 * leaves the run stacked for the next pass. A base that can no longer land
 * opens one stack_base_lost P1, settled if it comes back.
 */
export async function retargetStacks(deps: StackDeps): Promise<void> {
  const { db } = deps;
  const ids = db.query(`SELECT id FROM runs WHERE stacked_on IS NOT NULL AND state NOT IN (${ENDED.map((s) => `'${s}'`).join(",")}) ORDER BY started_at`).all() as { id: string }[];
  for (const { id } of ids) {
    const run = getRunWithPolicy(db, id);
    if (!run?.stacked_on) continue;
    const blocker = latestRun(db, run.stacked_on);
    if (blocker && (blocker.state === "landed" || blocker.state === "cleaned")) {
      try {
        await retargetOne(deps, run, blocker);
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        deps.log(`stacks: retarget of ${run.task_id} waits: ${error.message}`);
      }
      continue;
    }
    const lost = baseLost(db, run.stacked_on);
    tx(db, () => {
      const open = findOpenRunItem(db, "stack_base_lost", run.id);
      if (lost && !open) {
        const event = appendEvent(db, { source: "daemon", kind: "stack.base_lost", runId: run.id, taskId: run.task_id, payload: { on: run.stacked_on, why: lost }, ts: deps.now() });
        openItem(db, { kind: "stack_base_lost", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Stacked on ${run.stacked_on}, which cannot land beneath it (${lost}): ${taskTitle(db, run.task_id)} (${run.project_id}) cannot merge; flowryn cancel ${run.task_id}, or run ${run.stacked_on} again`, now: deps.now() });
      } else if (!lost && open) resolveRunItems(db, run.id, ["stack_base_lost"], "stack.base_back", deps.now());
    });
  }
}

async function retargetOne(deps: StackDeps, run: RunWithPolicy, blocker: RunRow): Promise<void> {
  const { db } = deps;
  const project = getProject(db, run.project_id);
  const mergeSha = landedMergeSha(db, blocker.id);
  const landed = deliveredOf(db, blocker.task_id);
  const landedHead = landed?.head ?? null;
  const landedPr = landed?.kind === "pr" ? Number(/\/pull\/(\d+)$/.exec(landed.ref)?.[1] ?? Number.NaN) : Number.NaN;
  if (!project || !mergeSha || !landedHead) {
    deps.log(`stacks: ${run.task_id} waits: ${blocker.task_id} landed with no merge commit or delivered head on record`);
    return;
  }
  const base = runBase(blocker, project);
  const oldBase = run.base_branch;
  const repo = projectRepo(project, deps.webUrl());
  const moved: PullRequest[] = [];
  if (repo) {
    // Every open PR from the run's branch: one the pipeline opened before a delivery counts too.
    for (const pr of await deps.forge().pullsForBranch(repo, run.branch)) {
      if (pr.state !== "open" || pr.baseRef === base) continue;
      moved.push(await deps.forge().setBase({ ...repo, number: pr.number }, base));
    }
  }
  let rang: string | null = null;
  let sent = false;
  tx(db, () => {
    const now = deps.now();
    const fresh = getRunWithPolicy(db, run.id);
    if (!fresh || fresh.stacked_on !== blocker.task_id || ENDED.includes(fresh.state)) return;
    db.query("UPDATE runs SET base_branch = ?2, stacked_on = NULL, updated_at = ?3 WHERE id = ?1").run(run.id, base === project.default_branch ? null : base, now);
    appendEvent(db, { source: "daemon", kind: "run.retargeted", runId: run.id, taskId: run.task_id, payload: { from: oldBase, to: base, on: blocker.task_id, merge_sha: mergeSha, prs: moved.map((pr) => pr.url) }, ts: now });
    resolveRunItems(db, run.id, ["stack_base_lost"], "run.retargeted", now);
    fresh.base_branch = base === project.default_branch ? null : base;
    fresh.stacked_on = null;
    if (fresh.state === "ready") {
      const text = retargetText(blocker.task_id, base, landedHead, mergeSha, true, Number.isNaN(landedPr) ? null : landedPr);
      sendBack(db, fresh, { text, feedback: `stacked base ${blocker.task_id} landed; take ${base} in and deliver again`, why: `${blocker.task_id} landed: the PR now targets ${base}`, event: { source: "daemon", kind: "stack.sent_back", payload: { on: blocker.task_id, base, merge_sha: mergeSha } } }, now);
      sent = true;
    } else {
      rang = createSteer(db, fresh, retargetText(blocker.task_id, base, landedHead, mergeSha, false, Number.isNaN(landedPr) ? null : landedPr), now).id;
    }
  });
  if (sent) deps.kickScheduler();
  if (rang) deps.notifySteer?.(run.id);
}
