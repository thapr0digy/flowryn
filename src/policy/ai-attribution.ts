/**
 * AI attribution in commits and PR bodies (docs/notes/2026-11-08-never-commit-claude-ks.md):
 * a Co-authored-by line naming Claude or Anthropic's no-reply address, the
 * "Generated with Claude Code" line, or a commit authored by that address
 * (GitHub turns a distinct commit author into a squash co-author line). The
 * merge gate refuses any of them. Messages are worker-written text: they are
 * only matched here, never executed. The Claude-Session line is a session
 * link, not a co-author, and never matches.
 */

import type { CommitInfo } from "../forge/types.ts";

export const ANTHROPIC_NOREPLY = "noreply@anthropic.com";

export interface AiAttributionHit {
  /** The commit's sha, or null for the PR body. */
  sha: string | null;
  /** The offending line, cleaned for display. */
  line: string;
}

const CO_AUTHOR = /^co-authored-by\s*:(.*)$/i;
const GENERATED = /generated\s+with\s+\[?\s*claude\s+code\b/i;
const AI_NAME = /\bclaude\b|noreply@anthropic\.com/i;
const MAX_LINE = 120;

/** A line safe to quote in a refusal: control characters dropped, cut to MAX_LINE. */
function displayLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE - 1)}…` : clean;
}

/** Every line of `text` that attributes it to Claude or another Anthropic-addressed AI. */
export function aiAttributionLines(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const coAuthor = CO_AUTHOR.exec(line);
    if ((coAuthor && AI_NAME.test(coAuthor[1]!)) || GENERATED.test(line)) hits.push(displayLine(line));
  }
  return hits;
}

export function isAiAuthorEmail(email: string): boolean {
  return email.trim().toLowerCase() === ANTHROPIC_NOREPLY;
}

/** Every AI attribution in the commits and the PR body, commits first in the order given. */
export function findAiAttribution(commits: readonly CommitInfo[], prBody: string | null): AiAttributionHit[] {
  const hits: AiAttributionHit[] = [];
  for (const commit of commits) {
    for (const line of aiAttributionLines(commit.message)) hits.push({ sha: commit.sha, line });
    if (isAiAuthorEmail(commit.authorEmail)) hits.push({ sha: commit.sha, line: `author ${ANTHROPIC_NOREPLY}` });
    else if (isAiAuthorEmail(commit.committerEmail)) hits.push({ sha: commit.sha, line: `committer ${ANTHROPIC_NOREPLY}` });
  }
  if (prBody) for (const line of aiAttributionLines(prBody)) hits.push({ sha: null, line });
  return hits;
}
