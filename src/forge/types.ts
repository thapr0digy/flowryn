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
  /**
   * GitHub's word on an open PR: false when it conflicts with its base, true
   * when it merges cleanly, null while GitHub is still computing it (or for a
   * PR that is not open).
   */
  mergeable: boolean | null;
  /** The login that opened the PR; absent when the forge did not say. */
  author?: string;
}

export type CheckState = "green" | "red" | "pending";

export interface Check {
  name: string;
  state: CheckState;
  /** The forge's own word: a check run's conclusion or status, a commit status's state. */
  detail: string;
  /** A check run's id (a commit status has none), for its annotations. */
  id?: number;
  /** The app that made the check run, such as github-actions. */
  app?: string;
  /** How many annotations the check run has. */
  annotations?: number;
}

export interface Annotation {
  level: string;
  message: string;
}

export interface ChecksSummary {
  /** red if any is red, else pending if any is pending, else green; none when the head has no checks. */
  state: CheckState | "none";
  checks: Check[];
}

/** Who wrote a review or a comment. */
export interface FeedbackAuthor {
  login: string;
  /** A GitHub App or bot account (user.type Bot). */
  bot: boolean;
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE… */
  association: string;
}

/** A submitted PR review. */
export interface Review {
  id: number;
  author: FeedbackAuthor;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  body: string;
  /** submitted_at, ISO 8601. */
  at: string;
  url: string;
}

/** An inline review comment, on a line of the diff. */
export interface ReviewComment {
  id: number;
  author: FeedbackAuthor;
  body: string;
  at: string;
  url: string;
  path: string;
  line: number | null;
  /** The comment this one replies to; null for the first comment of a thread. */
  inReplyTo: number | null;
}

/** A comment on the PR's conversation tab. */
export interface IssueComment {
  id: number;
  author: FeedbackAuthor;
  body: string;
  at: string;
  url: string;
}

/** Everything reviewers wrote on a PR, as the three REST lists give it. */
export interface PrFeedback {
  reviews: Review[];
  reviewComments: ReviewComment[];
  issueComments: IssueComment[];
}

/** An inline review thread: whether it is resolved, named by its first comment. */
export interface ReviewThread {
  resolved: boolean;
  rootCommentId: number | null;
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
  /** A check run's annotations: how the merge gate tells a job GitHub never started from one that failed. */
  annotations(repo: RepoRef, checkRunId: number): Promise<Annotation[]>;
  /** Merge at exactly `sha`: the forge refuses when the head moved (design section 7: bound to the head). */
  merge(ref: PrRef, sha: string, method: string, title: string): Promise<MergeResult>;
  /** Point an open PR at another base branch (a stacked PR whose base landed); the PR as GitHub has it after. */
  setBase(ref: PrRef, base: string): Promise<PullRequest>;
  /** A PR's reviews, inline review comments and conversation comments (src/forge/feedback.ts reads them). */
  feedback(ref: PrRef): Promise<PrFeedback>;
  /** A PR's inline review threads and whether each is resolved: only GitHub's GraphQL API says. */
  reviewThreads(ref: PrRef): Promise<ReviewThread[]>;
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
