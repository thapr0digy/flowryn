import type { FeedbackAuthor, PrFeedback, ReviewThread } from "./types.ts";

/**
 * What a delivered PR's reviewers wrote, read as plain rules (task
 * read-pr-reviews-fn; docs/notes/2026-10-23-read-pr-reviews-fn.md): who
 * counts, what steers the worker, which threads stay open until answered.
 * No model: the author, the review state, the thread and the time decide.
 *
 * - Inline review comment: steers; tracked until its thread is resolved or a
 *   later worker reply in that thread.
 * - Review requesting changes, with text: steers; tracked until a later
 *   worker reply anywhere on the PR, or the same reviewer approves.
 * - Review commenting with text, conversation comment: steers once.
 * - Approval, an empty review or an empty change request (its inline
 *   comments carry it): never.
 *
 * A worker's own GitHub replies end with REPLY_MARKER (the steer tells it
 * to), since Flowryn opens PRs and the worker replies as you: a marked text
 * from the PR's author account is a worker reply, never feedback. A marked
 * text from anyone else is judged like any other text.
 */

/** The hidden marker a worker ends each GitHub reply with: invisible on GitHub, plain to match. */
export const REPLY_MARKER = "<!-- flowryn:reply -->";

/** Write access on the repository: their words reach a worker. */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type FeedbackKind = "inline" | "changes" | "review" | "comment";

export interface FeedbackItem {
  /** Stable per PR: `comment:<id>` (inline), `review:<id>`, `issue-comment:<id>`. */
  key: string;
  kind: FeedbackKind;
  author: string;
  url: string;
  /** When it was written (ms). */
  at: number;
  body: string;
  /** Inline only: the file and line it is on. */
  path?: string;
  line?: number | null;
  /** Raised again until answered (inline, changes); otherwise steers once. */
  tracked: boolean;
  /** Whether its author's words may reach a worker (counts()). */
  counts: boolean;
  /** For a tracked item, how it was answered (resolved, worker reply, approved…); null while it waits. */
  answered: string | null;
}

/** A worker reply: written by the PR's author account (the worker replies as you), its text carrying REPLY_MARKER. */
export function isWorkerReply(text: { author: FeedbackAuthor; body: string }, prAuthor: string | null): boolean {
  return prAuthor !== null && text.author.login === prAuthor && text.body.includes(REPLY_MARKER);
}

/**
 * Whether feedback from `author` reaches a worker: you (the PR's author
 * account), anyone with write access, and a bot's reviews and inline comments
 * (not its conversation comments: coverage reports, deploy previews). Anyone
 * else, such as a stranger on a public repository, never does.
 */
export function counts(author: FeedbackAuthor, prAuthor: string | null, kind: FeedbackKind): boolean {
  if (prAuthor !== null && author.login === prAuthor) return true;
  if (WRITERS.has(author.association)) return true;
  return author.bot && kind !== "comment";
}

/** A thread is named by its first comment's id. */
function rootOf(comment: { id: number; inReplyTo: number | null }): number {
  return comment.inReplyTo ?? comment.id;
}

function ms(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every review and comment that could steer the worker, with its verdict.
 * `threads` is null when resolution was not read this time: a thread then
 * counts as unresolved, and only replies answer it.
 */
export function feedbackItems(feedback: PrFeedback, prAuthor: string | null, threads: ReviewThread[] | null): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  const resolved = new Set((threads ?? []).filter((t) => t.resolved && t.rootCommentId !== null).map((t) => t.rootCommentId!));
  const isReply = (text: { author: FeedbackAuthor; body: string }) => isWorkerReply(text, prAuthor);
  const workerReplyTimes = [...feedback.issueComments, ...feedback.reviewComments, ...feedback.reviews].filter(isReply).map((t) => ms(t.at));

  for (const c of feedback.reviewComments) {
    if (isReply(c) || c.body.trim() === "") continue;
    const root = rootOf(c);
    const replied = feedback.reviewComments.some((r) => r.id > c.id && rootOf(r) === root && isReply(r));
    const answered = resolved.has(root) ? "thread resolved" : replied ? "worker replied in the thread" : null;
    items.push({ key: `comment:${c.id}`, kind: "inline", author: c.author.login, url: c.url, at: ms(c.at), body: c.body, path: c.path, line: c.line, tracked: true, counts: counts(c.author, prAuthor, "inline"), answered });
  }

  for (const r of feedback.reviews) {
    if (isReply(r) || r.body.trim() === "") continue;
    if (r.state === "CHANGES_REQUESTED") {
      const at = ms(r.at);
      const approved = feedback.reviews.some((later) => later.id > r.id && later.author.login === r.author.login && later.state === "APPROVED");
      const answered = approved ? "the reviewer approved" : workerReplyTimes.some((t) => t >= at) ? "worker replied" : null;
      items.push({ key: `review:${r.id}`, kind: "changes", author: r.author.login, url: r.url, at, body: r.body, tracked: true, counts: counts(r.author, prAuthor, "changes"), answered });
    } else if (r.state === "COMMENTED") {
      items.push({ key: `review:${r.id}`, kind: "review", author: r.author.login, url: r.url, at: ms(r.at), body: r.body, tracked: false, counts: counts(r.author, prAuthor, "review"), answered: null });
    }
  }

  for (const c of feedback.issueComments) {
    if (isReply(c) || c.body.trim() === "") continue;
    items.push({ key: `issue-comment:${c.id}`, kind: "comment", author: c.author.login, url: c.url, at: ms(c.at), body: c.body, tracked: false, counts: counts(c.author, prAuthor, "comment"), answered: null });
  }
  return items.toSorted((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
