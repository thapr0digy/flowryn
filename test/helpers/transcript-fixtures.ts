import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Claude transcript lines for each way a message reaches a session, taken from real transcripts
 * (Claude 2.1.278 to 2.1.308) and scrubbed of ids, paths and text (test/fixtures/transcripts/).
 * Notices: a Monitor event, a background task done, a subagent hand-back, an older notice with
 * no origin (all queued while busy), and a notice delivered while idle. Yours: a message typed
 * while busy, one typed while idle, and an interrupt.
 */
export const NOTICE_FIXTURES = ["monitor-event", "background-task-done", "subagent-handback", "notification-no-origin", "notification-while-idle"] as const;
export const TYPED_FIXTURES = ["typed-while-busy", "typed-while-idle", "interrupt"] as const;
export type TranscriptFixture = (typeof NOTICE_FIXTURES)[number] | (typeof TYPED_FIXTURES)[number];

export function transcriptFixture(name: TranscriptFixture): Record<string, unknown> {
  const path = join(import.meta.dir, "..", "fixtures", "transcripts", `${name}.jsonl`);
  return JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
}
