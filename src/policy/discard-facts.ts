import { FlowrynError } from "../api/errors.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { recordEvidence, type RunRow } from "../lifecycle/runs.ts";
import { sha256Hex } from "../util/hash.ts";
import type { GitRunner } from "./landed.ts";

/**
 * What a discard would remove, as a chat question shows it and a chat grant binds to
 * (docs/notes/2026-11-09-chat-answer-approvals-wa.md): the worktree's HEAD and its uncommitted
 * files. `flowryn cleanup` records it when it refuses unlanded work (and `--discard` when it lacks your word), so the
 * pure-read `chat-question discard:<task>` can print it; the leader's hooks and the cleanup
 * itself read it again live and refuse when it moved. Plain code: git and a hash.
 */

export const DISCARD_EVIDENCE = "discard";

export interface DiscardFacts {
  head: string;
  /** Uncommitted entries (`git status --porcelain`), or -1 when status could not be read. */
  uncommitted: number;
  /** sha256 of `git status --porcelain=v1 -z`: which files are uncommitted, and how. */
  digest: string;
  worktree: string;
  branch: string;
}

export interface RecordedDiscardFacts extends DiscardFacts {
  observed_at: number;
}

/** The worktree's HEAD; once the worktree is gone, the tip of its branch in the primary checkout; else "none". */
export async function worktreeHead(git: GitRunner, run: Pick<RunRow, "worktree_path" | "branch">, project: Pick<ProjectRow, "path">): Promise<string> {
  const head = await git(["rev-parse", "HEAD"], run.worktree_path);
  if (head.code === 0) return head.stdout.trim();
  const branch = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`], project.path);
  return branch.code === 0 ? branch.stdout.trim() : "none";
}

/** Read the facts live. A status that cannot be read counts -1 entries and a digest of the failure, which never matches a readable one. */
export async function readDiscardFacts(git: GitRunner, run: Pick<RunRow, "worktree_path" | "branch">, project: Pick<ProjectRow, "path">): Promise<DiscardFacts> {
  const head = await worktreeHead(git, run, project);
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], run.worktree_path);
  const entries = status.code === 0 ? status.stdout.split("\0").filter((e) => e.length > 0) : [];
  return {
    head,
    uncommitted: status.code === 0 ? entries.length : -1,
    digest: status.code === 0 ? sha256Hex(`flowryn-discard-status\n${status.stdout}`) : sha256Hex(`flowryn-discard-status-unreadable\n${status.code}`),
    worktree: run.worktree_path,
    branch: run.branch,
  };
}

/** What a discard grant binds to: the head and the status digest. */
export function discardBinds(facts: Pick<DiscardFacts, "head" | "digest">): string {
  return `${facts.head} ${facts.digest}`;
}

export function sameDiscardFacts(a: DiscardFacts, b: DiscardFacts): boolean {
  return a.head === b.head && a.digest === b.digest && a.uncommitted === b.uncommitted && a.worktree === b.worktree && a.branch === b.branch;
}

/** The recorded facts for a run, or null. */
export function discardFacts(db: Db, runId: string): RecordedDiscardFacts | null {
  const row = db.query("SELECT value, observed_at FROM run_evidence WHERE run_id = ?1 AND source = ?2").get(runId, DISCARD_EVIDENCE) as { value: string; observed_at: number } | null;
  if (!row) return null;
  const value = JSON.parse(row.value) as DiscardFacts;
  return { ...value, observed_at: row.observed_at };
}

/** Record what a discard would remove, with its event. Call inside a transaction. */
export function recordDiscardFacts(db: Db, run: Pick<RunRow, "id" | "task_id">, facts: DiscardFacts, source: "cli" | "hook", now: number): void {
  recordEvidence(db, run.id, DISCARD_EVIDENCE, 1, facts, now);
  appendEvent(db, { source, kind: "discard.observed", runId: run.id, taskId: run.task_id, payload: { head: facts.head, uncommitted: facts.uncommitted, digest: facts.digest }, ts: now });
}

/** Outside a transaction: record the facts in their own one (a refusal that follows still leaves them). */
export function noteDiscardFacts(db: Db, run: Pick<RunRow, "id" | "task_id">, facts: DiscardFacts, source: "cli" | "hook", now: number): void {
  const recorded = discardFacts(db, run.id);
  if (recorded && sameDiscardFacts(recorded, facts)) return;
  tx(db, () => recordDiscardFacts(db, run, facts, source, now));
}

/** Why a grant's discard binding no longer holds, or null. */
export function discardBindsProblem(grantId: string, binds: string | null, live: DiscardFacts): string | null {
  const [head, digest] = (binds ?? "").split(" ");
  if (head !== live.head) return `grant ${grantId} was for head ${head?.slice(0, 8) || "?"}; the head is now ${live.head.slice(0, 8)}`;
  if (digest !== live.digest) return `grant ${grantId} was for the worktree as shown; its uncommitted files have changed since (now ${live.uncommitted < 0 ? "unreadable" : live.uncommitted})`;
  return null;
}

export function requireDiscardFacts(db: Db, run: Pick<RunRow, "id" | "task_id">): RecordedDiscardFacts {
  const facts = discardFacts(db, run.id);
  if (!facts) throw new FlowrynError("not_ready", `nothing records what discarding ${run.task_id} would remove`, `run flowryn cleanup ${run.task_id} first; its refusal records it`);
  return facts;
}
