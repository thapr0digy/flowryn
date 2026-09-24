// Matching control characters is the point of these patterns.
// oxlint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export const MAX_LINE_CHARS = 200;

/**
 * Make untrusted text safe for a one-line digest: strip ANSI escapes and
 * control characters, collapse whitespace, and truncate (design section 7).
 */
export function sanitizeLine(text: string, max: number = MAX_LINE_CHARS): string {
  const cleaned = text
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1).trimEnd() + "…";
}

/** Strip ANSI escapes and control characters from multi-line text, keeping newlines and tabs. */
export function sanitizeBlock(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(ANSI_ESCAPE, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
