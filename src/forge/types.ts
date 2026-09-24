/**
 * The forge (design section 6, rank 1: a system of record). v1 speaks to
 * GitHub only; the interface is what the named-head gate, the watcher, the
 * merge gate and the cleanup guard need, so a test or a fixture can put a
 * fake forge behind it.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PrRef extends RepoRef {
  number: number;
}

export type PrState = "open" | "closed" | "merged";

export interface PullRequest {
  number: number;
  /** The canonical web URL, <web_url>/<owner>/<repo>/pull/<n>. */
  url: string;
  title: string;
  state: PrState;
  draft: boolean;
  headSha: string;
  headRef: string;
  /** owner/repo the head branch lives in (a fork differs from the base repo). */
  headRepo: string;
  baseRef: string;
  /** Set only once the PR reads merged: the merge commit, the proof that it landed. */
  mergeSha: string | null;
  mergedAt: string | null;
}

export type CheckState = "green" | "red" | "pending";

export interface Check {
  name: string;
  state: CheckState;
  /** The forge's own word: a check run's conclusion or status, a commit status's state. */
  detail: string;
}

export interface ChecksSummary {
  /** red if any is red, else pending if any is pending, else green; none when the head has no checks. */
  state: CheckState | "none";
  checks: Check[];
}

export interface MergeResult {
  /** The forge said it merged; the proof is still the PR reading merged with a merge commit. */
  merged: boolean;
  sha: string | null;
  message: string;
}

export type ForgeErrorKind = "unreachable" | "rate_limited" | "not_found" | "auth" | "refused" | "conflict" | "protocol";

export class ForgeError extends Error {
  readonly kind: ForgeErrorKind;
  readonly status: number | null;
  /** When a rate limit ends (ms), if the forge said. */
  readonly retryAt: number | null;

  constructor(kind: ForgeErrorKind, message: string, status: number | null = null, retryAt: number | null = null) {
    super(message);
    this.name = "ForgeError";
    this.kind = kind;
    this.status = status;
    this.retryAt = retryAt;
  }
}

export interface Forge {
  pull(ref: PrRef): Promise<PullRequest>;
  /** PRs whose head is `branch` in this repo, newest first, any state. */
  pullsForBranch(repo: RepoRef, branch: string): Promise<PullRequest[]>;
  checks(repo: RepoRef, sha: string): Promise<ChecksSummary>;
  /** Merge at exactly `sha`: the forge refuses when the head moved (design section 7: bound to the head). */
  merge(ref: PrRef, sha: string, method: string, title: string): Promise<MergeResult>;
}

/** Summarise checks: red if any is red, else pending if any is pending, else green, or none. */
export function summarize(checks: Check[]): ChecksSummary {
  const state = checks.length === 0 ? "none" : checks.some((c) => c.state === "red") ? "red" : checks.some((c) => c.state === "pending") ? "pending" : "green";
  return { state, checks };
}

/** "green", "pending: ci/test", "red: lint, ci/test": one line for a prompt, a digest or `show`. */
export function checksLine(summary: ChecksSummary): string {
  if (summary.state === "none") return "no checks";
  if (summary.state === "green") return `green (${summary.checks.length})`;
  const names = summary.checks.filter((c) => c.state === summary.state).map((c) => c.name);
  return `${summary.state}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4}` : ""}`;
}
