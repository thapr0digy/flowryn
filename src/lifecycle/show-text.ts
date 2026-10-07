import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";

/**
 * Text for `flowryn show`: each line cut to a width and a body to its first
 * lines by default, or whole with --full. It remembers whether it cut
 * anything, so the view can say how to see the rest.
 */
export class ShowText {
  cut = false;

  constructor(readonly full: boolean) {}

  /** One line, sanitized; cut to `max` characters unless --full. */
  line(text: string, max: number): string {
    const whole = sanitizeLine(text, Number.POSITIVE_INFINITY);
    if (this.full || whole.length <= max) return whole;
    this.cut = true;
    return sanitizeLine(text, max);
  }

  /** A line stored already cut, with its whole text kept beside it (an item's `full_line`). */
  stored(line: string, whole: string | null, max: number): string {
    if (this.full) return whole ?? line;
    if (whole !== null) this.cut = true;
    return this.line(line, max);
  }

  /** A body: its first `maxLines` lines, each cut to `max`, by default; every line as written with --full. */
  block(text: string, maxLines: number, max: number): string {
    if (this.full) return sanitizeBlock(text);
    const lines = text.split("\n");
    if (lines.length > maxLines) this.cut = true;
    return lines
      .slice(0, maxLines)
      .map((l) => this.line(l, max))
      .join("\n");
  }

  /** The view's last field, when it cut something: how to see it whole. */
  pointer(target: string): { truncated?: string } {
    return this.cut && !this.full ? { truncated: `flowryn show ${target} --full for the complete text` } : {};
  }
}
