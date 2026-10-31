import { existsSync } from "node:fs";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import type { GitRunner } from "../policy/landed.ts";

/**
 * Sync a primary checkout (spec 3, phase 3): dispatch branches new runs from
 * the local default branch, so a checkout left behind origin starts every run
 * on stale code. The daemon fetches the default branch and fast-forwards the
 * checkout to it, and only when that cannot lose or rewrite anything: the
 * checkout is on its default branch, has no tracked changes, and its branch
 * is behind origin's (never ahead or diverged). Git's own refusal (an
 * untracked file in the way, a lock) is a skip too. Plain git, no model.
 */

/** Skips you should hear about: the checkout stays stale until you act. */
const SHOWN_SKIPS = ["dirty", "ahead", "diverged", "merge_refused"] as const;

export type SyncSkip = (typeof SHOWN_SKIPS)[number] | "no_checkout" | "no_origin" | "fetch_failed" | "off_branch" | "no_branch";

export type SyncOutcome =
  | { outcome: "synced"; from: string; to: string }
  | { outcome: "current"; at: string }
  | { outcome: "skipped"; reason: SyncSkip; detail: string };

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 160) ?? "";
}

/** Fetch origin's default branch, then fast-forward the checkout to it when that is safe. Changes nothing otherwise. */
export async function syncPrimary(git: GitRunner, project: ProjectRow): Promise<SyncOutcome> {
  const cwd = project.path;
  const branch = project.default_branch;
  if (!existsSync(cwd)) return { outcome: "skipped", reason: "no_checkout", detail: `${cwd} does not exist` };
  if ((await git(["remote", "get-url", "origin"], cwd)).code !== 0) return { outcome: "skipped", reason: "no_origin", detail: "the checkout has no origin remote" };
  const fetched = await git(["fetch", "--quiet", "origin", branch], cwd);
  if (fetched.code !== 0) return { outcome: "skipped", reason: "fetch_failed", detail: `git fetch origin ${branch}: ${firstLine(fetched.stderr)}` };
  const current = (await git(["branch", "--show-current"], cwd)).stdout.trim();
  if (current !== branch) return { outcome: "skipped", reason: "off_branch", detail: `it is on ${current || "a detached HEAD"}, not ${branch}` };
  const local = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], cwd)).stdout.trim();
  const remote = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], cwd)).stdout.trim();
  if (!local || !remote) return { outcome: "skipped", reason: "no_branch", detail: `cannot resolve ${branch} or origin/${branch}` };
  if (local === remote) return { outcome: "current", at: local };
  const status = await git(["status", "--porcelain", "--untracked-files=no"], cwd);
  if (status.code !== 0 || status.stdout.trim() !== "") return { outcome: "skipped", reason: "dirty", detail: "it has uncommitted changes" };
  if ((await git(["merge-base", "--is-ancestor", local, remote], cwd)).code !== 0) {
    const ahead = (await git(["merge-base", "--is-ancestor", remote, local], cwd)).code === 0;
    return ahead
      ? { outcome: "skipped", reason: "ahead", detail: `its ${branch} has commits that are not on origin/${branch}` }
      : { outcome: "skipped", reason: "diverged", detail: `its ${branch} and origin/${branch} have diverged` };
  }
  const merged = await git(["merge", "--ff-only", "--quiet", `refs/remotes/origin/${branch}`], cwd);
  if (merged.code !== 0) return { outcome: "skipped", reason: "merge_refused", detail: `git merge --ff-only refused: ${firstLine(merged.stderr || merged.stdout)}` };
  return { outcome: "synced", from: local, to: remote };
}

function itemKey(project: ProjectRow): string {
  return `project:${project.id}`;
}

/**
 * Record a sync: a fast-forward is an event; a skip you should hear about
 * opens one `checkout_unsynced` P1 info item per project (replaced when the
 * reason changes), closed once the checkout is in step again. Off its default
 * branch is left to dispatch's `checkout_tangle`; a missing origin or a failed
 * fetch is only logged. Call inside a transaction; returns a log line or null.
 */
export function recordSync(db: Db, project: ProjectRow, sync: SyncOutcome, now: number): string | null {
  const key = itemKey(project);
  if (sync.outcome === "current" || sync.outcome === "synced") {
    resolveItems(db, "checkout_unsynced", key, sync.outcome === "synced" ? "upkeep.synced" : "in step with origin", now);
    if (sync.outcome === "current") return null;
    appendEvent(db, { source: "daemon", kind: "upkeep.synced", payload: { project: project.id, from: sync.from, to: sync.to }, ts: now });
    return `sync ${project.id}: fast-forwarded ${project.default_branch} ${sync.from.slice(0, 8)}..${sync.to.slice(0, 8)}`;
  }
  if (!(SHOWN_SKIPS as readonly string[]).includes(sync.reason)) return `sync ${project.id}: skipped (${sync.reason}: ${sync.detail})`;
  const line = `Primary checkout of ${project.id} not synced with origin/${project.default_branch}: ${sync.detail}; new runs branch from it as it is; tell the user`;
  const open = findOpenItem(db, "checkout_unsynced", key);
  if (open?.line === line) return null;
  if (open) resolveItems(db, "checkout_unsynced", key, `now ${sync.reason}`, now);
  const event = appendEvent(db, { source: "daemon", kind: "upkeep.sync_skipped", payload: { project: project.id, reason: sync.reason, detail: sync.detail }, ts: now });
  openItem(db, { kind: "checkout_unsynced", eventSeq: event.seq, taskId: key, line, now });
  return `sync ${project.id}: ${line}`;
}
