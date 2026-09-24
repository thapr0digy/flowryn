import { encode } from "@toon-format/toon";
import type { Reply } from "../api/envelope.ts";
import { EXIT, exitCodeFor, type ExitCode } from "../api/errors.ts";

export interface RenderOptions {
  json: boolean;
  /** A first line such as the read-only banner when the daemon is down. */
  banner?: string;
}

/**
 * Render a reply. TOON by default, in axi house style: data first, then at
 * most two next-step hints as `help`. Errors print `error`, `code` and `help`.
 * --json prints the reply object itself, for hooks, bridges and scripts.
 */
export function renderReply(reply: Reply, options: RenderOptions): string {
  if (options.json) {
    const out: Record<string, unknown> = { ...reply };
    if (options.banner) out.banner = options.banner;
    return JSON.stringify(out) + "\n";
  }
  if (!reply.ok) {
    const error = reply.error ?? { code: "internal", message: "unknown error" };
    const body: Record<string, unknown> = { error: error.message, code: error.code };
    if (error.help) body.help = error.help;
    return encode(body) + "\n";
  }
  const body: Record<string, unknown> = {};
  if (options.banner) body.banner = options.banner;
  if (reply.data && typeof reply.data === "object" && !Array.isArray(reply.data)) Object.assign(body, reply.data);
  else if (reply.data !== undefined) body.result = reply.data;
  const text = Object.keys(body).length > 0 ? encode(body) + "\n" : "";
  return text + renderHints(reply.hints ?? []);
}

const NEEDS_QUOTES = /^[\s-]|\s$|[:"\\[\]{},#]/;

/** Hints as a TOON list, one per line, the way axi tools print them. */
function renderHints(hints: string[]): string {
  if (hints.length === 0) return "";
  const items = hints.map((h) => `  - ${NEEDS_QUOTES.test(h) ? JSON.stringify(h) : h}`);
  return `help[${hints.length}]:\n${items.join("\n")}\n`;
}

export function exitCodeOf(reply: Reply): ExitCode {
  if (reply.ok) return EXIT.ok;
  return exitCodeFor(reply.error?.code ?? "internal");
}
