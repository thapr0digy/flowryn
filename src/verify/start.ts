import { join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import { capacityConfig } from "../config/workflows.ts";
import { restartHoldingVerifies } from "../daemon/restart.ts";
import { tx, type Db } from "../db/db.ts";
import { parsePrUrl } from "../forge/github.ts";
import { ForgeError, type Forge } from "../forge/types.ts";
import { isForgeOutage } from "../reconcile/forge-health.ts";
import type { HostVerdict } from "../sched/host.ts";
import { fullPools, grantJobLease, liveCounts, OverCapacity, poolHolders } from "../sched/pools.ts";
import { hostState } from "../sched/scheduler.ts";
import { verifyConfig, type VerifyConfig } from "./config.ts";
import { verifyPolicyId } from "./policy.ts";
import { cancelRequest, getRequest, markStarted, positionOf, queuedRequests, type VerifyRequest } from "./queue.ts";
import { initialSteps, runVerification, type VerifyDeps, type VerifyPlan } from "./runner.ts";
import { insertVerification, runningVerifications, type Verification } from "./store.ts";

/**
 * Starting verifications (docs/notes/2026-10-22-daemon-run-verify-y3.md): a
 * request starts in the same transaction as its verification row and its
 * `validation` slot, so concurrency is that pool's cap. `verify.start` starts
 * one at once when nothing waits ahead of it; otherwise the scheduler's pass
 * drains the queue, before it grants stages (drain before fill), FIFO within
 * rank, under the host check, and not while a restart waits to happen.
 */

/** The pool a verify takes a slot of: the ship stage's no-mistakes pipeline's. */
export const VERIFY_POOL = "validation";

export function verifyRoot(config: Pick<FlowrynConfig, "state_dir">): string {
  return join(config.state_dir, "verify");
}

/** Take the request's slot and insert its running verification. Call inside a transaction; throws OverCapacity when the pool is full. */
export function admitRequest(db: Db, request: VerifyRequest, config: VerifyConfig, caps: Record<string, number>, root: string, projectPath: string, now: number): Verification {
  const v = insertVerification(db, {
    project_id: request.project_id,
    pr_url: request.pr_url,
    task_id: request.task_id,
    head_sha: request.head_sha,
    steps: initialSteps(config.steps),
    policy_id: verifyPolicyId(config),
    dir: (id) => join(root, id),
    worktree: (id) => join(root, id, "wt"),
    project_path: projectPath,
    source: request.source === "cli" ? "cli" : "daemon",
    now,
  });
  // Same transaction as the row: the slot is counted here, so a scheduler grant cannot take it meanwhile.
  grantJobLease(db, { kind: "verify", id: v.id, taskId: v.task_id }, VERIFY_POOL, caps, now);
  markStarted(db, request, v.id, now);
  return v;
}

export function planOf(request: VerifyRequest, config: VerifyConfig): VerifyPlan {
  return { prNumber: request.pr_number, headRef: request.head_ref, binary: config.binary, timeoutMs: config.timeout_ms, path: request.path };
}

/** Why the queue's first request cannot start now, or null when it may (the host check aside: it is read when a start is tried). */
export function queueHold(db: Db, caps: Record<string, number>, now: number): string | null {
  const restart = restartHoldingVerifies(db, now);
  if (restart) return `a daemon restart asked for ${Math.max(0, Math.round((now - restart.since) / 60_000))} min ago waits for the running verifies first`;
  if (fullPools(db, caps, [VERIFY_POOL]).length > 0) return `the ${VERIFY_POOL} pool is full (${liveCounts(db)[VERIFY_POOL] ?? 0}/${caps[VERIFY_POOL] ?? 0}: ${poolHolders(db, VERIFY_POOL) || "nothing listed"})`;
  return null;
}

/** What a queued request waits on, for `verify show` and the queued reply. */
export function waitingOn(db: Db, request: VerifyRequest, caps: Record<string, number>, now: number): string {
  const place = positionOf(db, request.id);
  if (!place) return "-";
  if (place.ahead.length > 0) return `behind ${place.ahead.join(", ")}`;
  const hold = queueHold(db, caps, now);
  if (hold) return hold;
  const host = hostState(db);
  if (host && !host.ok) return `the host check fails (${host.reason})`;
  return "starting";
}

export interface QueueDeps extends VerifyDeps {
  config(): FlowrynConfig;
  forge(): Forge;
  webUrl(): string;
  projectPath(projectId: string): string | null;
  /** The scheduler's host check, as a stage grant reads it. */
  host(): Promise<HostVerdict>;
  /** True once the daemon shuts down: nothing more starts. */
  stopped?(): boolean;
  /** The steps' base environment (tests); by default the daemon's. */
  env?: NodeJS.ProcessEnv;
}

type Wanted = { start: VerifyConfig; projectPath: string } | { cancel: string } | { wait: string };

/** Is the request still worth running: its project still has verify steps, its PR is open at the same head (local-only work: the worktree HEAD)? */
async function stillWanted(deps: QueueDeps, request: VerifyRequest): Promise<Wanted> {
  const projectPath = deps.projectPath(request.project_id);
  if (!projectPath) return { cancel: `project ${request.project_id} is gone` };
  let config: VerifyConfig | null;
  try {
    config = verifyConfig(deps.config(), request.project_id);
  } catch (error) {
    return { wait: `the [projects.${request.project_id}] config is invalid: ${(error as Error).message}` };
  }
  if (!config) return { cancel: `project ${request.project_id} has no verify steps now` };
  if (request.pr_number === null) {
    const head = request.worktree ? await deps.git(["rev-parse", "HEAD"], request.worktree) : null;
    if (!head || head.code !== 0) return { cancel: `cannot read the head of ${request.pr_url}${request.worktree ? ` in ${request.worktree}` : ""}` };
    const sha = head.stdout.trim();
    if (sha !== request.head_sha) return { cancel: `the head moved from ${request.head_sha.slice(0, 8)} to ${sha.slice(0, 8)}; verify the new head` };
    return { start: config, projectPath };
  }
  const ref = parsePrUrl(request.pr_url, deps.webUrl());
  if (!ref) return { cancel: `${request.pr_url} is not a pull request URL` };
  try {
    const pr = await deps.forge().pull(ref);
    if (pr.state !== "open") return { cancel: `${request.pr_url} is ${pr.state}` };
    if (pr.headSha !== request.head_sha) return { cancel: `the PR head moved from ${request.head_sha.slice(0, 8)} to ${pr.headSha.slice(0, 8)}; verify the new head` };
  } catch (error) {
    if (error instanceof ForgeError && error.kind === "not_found") return { cancel: `GitHub has no ${request.pr_url}` };
    if (isForgeOutage(error)) return { wait: `GitHub is unavailable (${(error as Error).message})` };
    return { wait: `cannot read ${request.pr_url} (${(error as Error).message})` };
  }
  return { start: config, projectPath };
}

/** Run a started verification in the background; whatever happens is recorded on its row. */
export function launchVerification(deps: VerifyDeps, v: Verification, plan: VerifyPlan, env?: NodeJS.ProcessEnv): void {
  void runVerification(deps, v, plan, env).catch((error: unknown) => deps.log(`verify ${v.id}: ${(error as Error).message}`));
}

/**
 * Start queued requests while their turn comes and a slot is free: the first
 * request in line either starts, is cancelled (its PR closed, its head moved),
 * follows a running verification of its PR and head under today's policy,
 * or holds everything behind it (FIFO). Returns how many started.
 */
export async function drainVerifyQueue(deps: QueueDeps): Promise<number> {
  const { db } = deps;
  let started = 0;
  for (;;) {
    const first = queuedRequests(db)[0];
    if (!first) return started;
    const caps = capacityConfig(deps.config()).pools;
    if (queueHold(db, caps, deps.now())) return started;
    if (!(await deps.host()).ok) return started;
    const wanted = await stillWanted(deps, first);
    if ("wait" in wanted) {
      deps.log(`verify ${first.id}: waits: ${wanted.wait}`);
      return started;
    }
    if ("cancel" in wanted) {
      tx(db, () => cancelRequest(db, first, wanted.cancel, deps.now()));
      continue;
    }
    if (deps.stopped?.()) return started;
    let v: Verification | null;
    try {
      v = tx(db, () => {
        const fresh = getRequest(db, first.id);
        if (fresh?.state !== "queued") return null;
        const policy = verifyPolicyId(wanted.start);
        const same = runningVerifications(db).find((r) => r.pr_url === fresh.pr_url && r.head_sha === fresh.head_sha && r.policy_id === policy);
        if (same) {
          markStarted(db, fresh, same.id, deps.now());
          return null;
        }
        if (queueHold(db, caps, deps.now())) return null;
        return admitRequest(db, fresh, wanted.start, caps, deps.root, wanted.projectPath, deps.now());
      });
    } catch (error) {
      if (error instanceof OverCapacity) return started;
      throw error;
    }
    if (!v) {
      if (getRequest(db, first.id)?.state === "queued") return started;
      continue;
    }
    launchVerification(deps, v, planOf(first, wanted.start), deps.env);
    started++;
  }
}
