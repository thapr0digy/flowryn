import { existsSync, rmSync } from "node:fs";
import type { CleanupConfig } from "../config/delivery.ts";
import type { Forge } from "../forge/types.ts";
import type { PsRunner } from "../runtime/proc.ts";
import { indexLockPath, judgeCleanup, type GitRunner, type GuardInput, type GuardVerdict, type ReasonClass } from "./landed.ts";
import { provablyStale } from "./locks.ts";
import { concludeParkedRun } from "./nomistakes.ts";
import { reapUnder } from "./reap.ts";

/**
 * The cleanup procedure (design section 14, "cleanup order"): the landed-work
 * verdict first; then, only when it allows (or a human approved a discard),
 * a git index.lock left in the worktree is waited for, cleared only when
 * provably stale, and the verdict taken again; the task's own parked
 * no-mistakes run is aborted (proven its own, never another branch's); the
 * worker stops; leaked processes are reaped by identity; and last the
 * worktree is removed, with --force only for an approved discard, and its
 * branch deleted. Each refusal leaves the worktree, its branch and its HEAD
 * exactly as they were. An unexpected error at any step is a refusal too
 * (`guard_error`). fixtures/cleanup-order checks this order and every refusal
 * against any implementation.
 */

export type CleanupReason =
  | ReasonClass
  | "lock_not_provably_stale"
  | "nomistakes_unconfirmed"
  | "worker_did_not_exit"
  | "lsof_failed"
  | "identity_unverified"
  | "survivors"
  | "remove_failed"
  | "guard_error";

export interface CleanupRequest {
  guard: GuardInput;
  /** The project's primary checkout: git removes the worktree and deletes the branch from here. */
  primary: string;
}

export interface CleanupDeps {
  git: GitRunner;
  forge: Forge | null;
  webUrl: string;
  lsof: string | null;
  noMistakes: string | null;
  ps: PsRunner;
  config: CleanupConfig;
  log(line: string): void;
  /** Stop the worker's harness by its recorded identity; the fixtures have no worker. */
  exitWorker?(): Promise<{ ok: boolean; detail: string }>;
  kill?(pid: number, signal: NodeJS.Signals): void;
}

export type LockOutcome = "none" | "cleared" | "cleared_by_itself" | "kept";

export interface CleanupOutcome {
  outcome: "removed" | "refused";
  reason: CleanupReason;
  detail: string;
  verdict: GuardVerdict | null;
  lock: LockOutcome;
  aborted: string | null;
  reaped: number[];
  branchDeleted: boolean;
  /** The HEAD a discard threw away, so it can still be recovered while git keeps the objects. */
  discardedHead: string | null;
  steps: string[];
}

interface LockGate {
  ok: boolean;
  lock: LockOutcome;
  detail: string;
}

/**
 * A lock present at cleanup belongs to a git process that is still running or
 * one that died. Patience first: a lock that clears by itself was transient.
 * A provably stale one is removed. Anything else stays, and the cleanup stops.
 */
async function lockGate(req: CleanupRequest, deps: CleanupDeps, steps: string[]): Promise<LockGate> {
  const lock = await indexLockPath(deps.git, req.guard.worktree);
  if (!lock || !existsSync(lock)) return { ok: true, lock: "none", detail: "" };
  let why = "";
  for (let attempt = 1; attempt <= deps.config.lock_retries; attempt++) {
    if (!existsSync(lock)) {
      steps.push("lock_cleared_by_itself");
      deps.log(`git lock ${lock} cleared by itself`);
      return { ok: true, lock: "cleared_by_itself", detail: "" };
    }
    const staleness = await provablyStale(deps.lsof, lock, req.guard.worktree, deps.config.lock_age_ms);
    if (staleness.stale) {
      rmSync(lock, { force: true });
      steps.push("lock_removed");
      deps.log(`removed provably-stale git lock ${lock}: ${staleness.why}`);
      return { ok: true, lock: "cleared", detail: "" };
    }
    why = staleness.why;
    deps.log(`git lock ${lock} is not provably stale (${why}); waiting ${deps.config.lock_wait_ms} ms (${attempt}/${deps.config.lock_retries})`);
    await Bun.sleep(deps.config.lock_wait_ms);
  }
  if (!existsSync(lock)) {
    steps.push("lock_cleared_by_itself");
    return { ok: true, lock: "cleared_by_itself", detail: "" };
  }
  steps.push("lock_kept");
  return { ok: false, lock: "kept", detail: `git lock ${lock} persisted across ${deps.config.lock_retries} checks and is not provably stale (${why}); left in place` };
}

export async function runCleanup(req: CleanupRequest, deps: CleanupDeps): Promise<CleanupOutcome> {
  const steps: string[] = [];
  try {
    return await cleanupInOrder(req, deps, steps);
  } catch (error) {
    // A step that cannot run at all (a tool that will not start, say) refuses: never a half-known success, and never silence.
    const message = error instanceof Error ? error.message : String(error);
    steps.push("guard_error");
    deps.log(`the cleanup stopped at an unexpected error: ${error instanceof Error ? (error.stack ?? message) : message}`);
    const where = existsSync(req.guard.worktree) ? "the worktree is kept for inspection or a retry" : "the worktree is already gone";
    return { outcome: "refused", reason: "guard_error", detail: `the cleanup stopped at an unexpected error (${message}); ${where}`, verdict: null, lock: "none", aborted: null, reaped: [], branchDeleted: false, discardedHead: null, steps };
  }
}

async function cleanupInOrder(req: CleanupRequest, deps: CleanupDeps, steps: string[]): Promise<CleanupOutcome> {
  const result = (outcome: CleanupOutcome["outcome"], reason: CleanupReason, detail: string, extra: Partial<CleanupOutcome> = {}): CleanupOutcome => ({
    outcome,
    reason,
    detail,
    verdict: null,
    lock: "none",
    aborted: null,
    reaped: [],
    branchDeleted: false,
    discardedHead: null,
    steps,
    ...extra,
  });
  const judge = async () => {
    const verdict = await judgeCleanup(req.guard, { git: deps.git, forge: deps.forge, webUrl: deps.webUrl });
    steps.push(`verdict:${verdict.verdict}:${verdict.reason}`);
    return verdict;
  };

  let verdict = await judge();
  let lock: LockOutcome = "none";
  // A refusal on the work itself touches nothing; only an uninspectable worktree may be a lock's doing.
  if (verdict.verdict === "refuse" && verdict.reason !== "uninspectable") return result("refused", verdict.reason, verdict.detail, { verdict });

  const gate = async (): Promise<CleanupOutcome | null> => {
    const g = await lockGate(req, deps, steps);
    if (g.lock !== "none") lock = g.lock === "kept" ? "kept" : g.lock;
    if (!g.ok) return result("refused", "lock_not_provably_stale", g.detail, { verdict, lock });
    if (g.lock !== "none") {
      // The lock may have hidden uncommitted work: take the verdict again before anything else.
      verdict = await judge();
      if (verdict.verdict === "refuse") return result("refused", verdict.reason, verdict.detail, { verdict, lock });
    }
    return null;
  };
  const blocked = await gate();
  if (blocked) return blocked;
  if (verdict.verdict === "refuse") return result("refused", verdict.reason, verdict.detail, { verdict, lock });

  let aborted: string | null = null;
  if (req.guard.kind === "ship") {
    const concluded = await concludeParkedRun({ noMistakes: deps.noMistakes, git: deps.git, timeoutMs: deps.config.nomistakes_timeout_ms, log: deps.log }, req.guard.worktree);
    aborted = concluded.aborted;
    if (aborted) steps.push(`nomistakes_aborted:${aborted}`);
    if (!concluded.ok) return result("refused", "nomistakes_unconfirmed", concluded.detail, { verdict, lock, aborted });
  }

  if (deps.exitWorker) {
    const exited = await deps.exitWorker();
    steps.push(`worker_exit:${exited.ok ? "ok" : "failed"}`);
    if (!exited.ok) return result("refused", "worker_did_not_exit", `the worker did not stop: ${exited.detail}`, { verdict, lock, aborted });
  }

  const reap = await reapUnder([req.guard.worktree], { lsof: deps.lsof, ps: deps.ps, graceMs: deps.config.reap_grace_ms, passes: deps.config.reap_passes, kill: deps.kill, log: deps.log });
  steps.push(`reap:${reap.ok ? "ok" : reap.reason}:${reap.reaped.join(",")}`);
  if (!reap.ok) return result("refused", reap.reason, `${reap.detail}; the worktree is kept for inspection or a retry`, { verdict, lock, aborted, reaped: reap.reaped });

  // A process reaped a moment ago can leave a lock of its own.
  const again = await gate();
  if (again) return { ...again, aborted, reaped: reap.reaped };

  const discard = verdict.verdict === "discard";
  const head = (await deps.git(["rev-parse", "HEAD"], req.guard.worktree)).stdout.trim() || null;
  if (existsSync(req.guard.worktree)) {
    const removed = await deps.git(["worktree", "remove", ...(discard ? ["--force"] : []), req.guard.worktree], req.primary);
    steps.push(`worktree_remove:${removed.code === 0 ? "ok" : "failed"}`);
    if (removed.code !== 0) {
      return result("refused", "remove_failed", `git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim()}`, { verdict, lock, aborted, reaped: reap.reaped });
    }
  } else {
    await deps.git(["worktree", "prune"], req.primary);
    steps.push("worktree_prune");
  }
  let branchDeleted = false;
  if ((await deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${req.guard.branch}`], req.primary)).code === 0) {
    branchDeleted = (await deps.git(["branch", "-D", req.guard.branch], req.primary)).code === 0;
    steps.push(`branch_delete:${branchDeleted ? "ok" : "failed"}`);
  }
  deps.log(`removed worktree ${req.guard.worktree}${branchDeleted ? ` and branch ${req.guard.branch}` : ""} (${verdict.reason})`);
  return result("removed", verdict.reason, verdict.detail, { verdict, lock, aborted, reaped: reap.reaped, branchDeleted, discardedHead: discard ? head : null });
}
