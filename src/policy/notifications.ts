/**
 * Telling a message you typed from one Claude Code injects as a user turn
 * (docs/notes/2026-10-17-chat-answers-survive-es.md): background task and Monitor
 * notices, subagent hand-backs. Claude runs UserPromptSubmit for both, and its hook
 * input carries only the text, so the prompt hook judges the text's shape and the
 * transcript, read when a grant is used, says who sent each one. Plain code: no
 * model reads a message.
 */

/** A notice block Claude writes around a background event or a hand-back. */
const NOTICE_BLOCKS = [/<task-notification>[\s\S]*?<\/task-notification>/g, /<agent-message from="[^"<>]*">[\s\S]*?<\/agent-message>/g];
/** The reminder Claude wraps a notice in ("[SYSTEM NOTIFICATION - NOT USER INPUT]"), or appends Stop-hook feedback in. */
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** The line Claude puts before another session's message. */
const PEER_PREAMBLE = /^Another Claude session sent a message:$/gm;

/**
 * A prompt that is nothing but notice blocks (with their reminders): at least one
 * `<task-notification>` or `<agent-message>` block, and nothing else once those and any
 * `<system-reminder>` blocks are removed. Anything else counts as you.
 */
export function isNotificationPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  let rest = prompt;
  let notices = 0;
  for (const block of NOTICE_BLOCKS) {
    rest = rest.replace(block, () => {
      notices++;
      return "";
    });
  }
  if (notices === 0) return false;
  return rest.replace(REMINDER_BLOCK, "").replace(PEER_PREAMBLE, "").trim().length === 0;
}

/** The origins Claude records for a message nobody typed; any other, or none, is you. */
const NOTICE_ORIGINS: ReadonlySet<string> = new Set(["task-notification", "peer"]);

export type Sender = "you" | "notice";

function originKind(value: unknown): string | null {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" ? kind : null;
}

/** Text, an image or a command: a message, not only tool results. */
function hasMessage(content: unknown): boolean {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((part) => !part || typeof part !== "object" || (part as { type?: unknown }).type !== "tool_result");
}

/**
 * Who sent a transcript entry, or null when it is not a message (a tool result, a hook's
 * or the harness's own meta lines, a compaction summary). A message queued while Claude
 * was busy is an `attachment` of type `queued_command`; one typed while idle a `user`
 * entry. Each carries `origin.kind`; an older queued one only `commandMode`.
 */
export function senderOf(entry: Record<string, unknown>): Sender | null {
  if (entry.type === "attachment") {
    const attachment = (entry.attachment && typeof entry.attachment === "object" ? entry.attachment : {}) as Record<string, unknown>;
    if (attachment.type !== "queued_command") return null;
    const kind = originKind(attachment.origin);
    if (kind !== null) return NOTICE_ORIGINS.has(kind) ? "notice" : "you";
    return attachment.commandMode === "task-notification" ? "notice" : "you";
  }
  if (entry.type !== "user") return null;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!hasMessage(content)) return null;
  const kind = originKind(entry.origin);
  if (kind !== null && NOTICE_ORIGINS.has(kind)) return "notice";
  if (entry.isMeta === true || entry.isCompactSummary === true) return null;
  return "you";
}

/** How many messages you sent, and how many notices arrived, in these transcript lines. */
export function countSenders(lines: readonly string[]): { you: number; notices: number } {
  let you = 0;
  let notices = 0;
  for (const line of lines) {
    if (!line.includes('"user"') && !line.includes("queued_command")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const sender = senderOf(entry as Record<string, unknown>);
    if (sender === "you") you++;
    else if (sender === "notice") notices++;
  }
  return { you, notices };
}
