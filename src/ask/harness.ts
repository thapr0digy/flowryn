import { CLAUDE_CREDENTIAL_ENV } from "../config/accounts.ts";
import type { WorkersConfig } from "../config/workers.ts";
import type { HarnessId } from "../harness/types.ts";

/**
 * How an ask's one model call is made and read (docs/notes/2026-10-30-ask-a-lightweight-4v.md):
 * print mode, reading tools only, the spend cap, the question on stdin, the reply on stdout.
 * Everything here is plain code; only the reply itself is the model's.
 */

/** Claude's built-in tools an ask may use: reading files and the web, never writing or running anything. */
export const CLAUDE_ASK_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"] as const;
/** Pi's built-in reading tools (0.87.1 has no web tools). */
export const PI_ASK_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The first line of a reply that asks to become a scout: the marker, then why. */
export const NEEDS_SCOUT = "NEEDS-SCOUT:";

/** The ask's whole contract, appended to the harness's system prompt. */
export function askContract(maxAnswerBytes: number): string {
  return [
    "You are a Flowryn ask: answer one question, then stop. Nobody reads anything but your final reply.",
    "You can only read: files in this project (start from its AGENTS.md or CLAUDE.md when the question is about the code) and, where your tools allow, the web.",
    `Reply in plain text or Markdown, at most ${maxAnswerBytes} bytes. Open with a one-sentence answer; then the detail, citing the file paths and URLs you relied on.`,
    "Say what you could not check; never guess silently.",
    `If answering truly needs writing files, running commands or tests, or changing anything, reply with exactly one line and nothing else: ${NEEDS_SCOUT} <why, in one sentence>`,
    "Flowryn then starts a full worker on the same question.",
  ].join("\n");
}

export interface AskCall {
  harness: HarnessId;
  binary: string;
  workers: WorkersConfig;
  contractFile: string;
  maxUsd: number;
}

/** Claude in print mode: JSON result, no saved session, no settings files, hooks or MCP servers, reading tools only, the native spend cap. */
export function claudeAskArgs(call: AskCall): string[] {
  const claude = call.workers.claude;
  const tools = CLAUDE_ASK_TOOLS.join(",");
  const args = [call.binary, "-p", "--output-format", "json", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--disable-slash-commands"];
  args.push("--tools", tools, "--allowedTools", tools, "--permission-mode", "dontAsk");
  args.push("--max-budget-usd", String(call.maxUsd), "--append-system-prompt-file", call.contractFile);
  if (claude.model) args.push("--model", claude.model);
  if (claude.effort) args.push("--effort", claude.effort);
  return args;
}

/** Pi in print mode with its JSON event stream (the cost meter reads it), no session file, reading tools only. */
export function piAskArgs(call: AskCall): string[] {
  const pi = call.workers.pi;
  const args = [call.binary, "-p", "--mode", "json", "--no-session", "--tools", PI_ASK_TOOLS.join(",")];
  for (const extension of pi.extensions) args.push("-e", extension);
  if (pi.provider) args.push("--provider", pi.provider);
  if (pi.model) args.push("--model", pi.model);
  if (pi.effort) args.push("--thinking", pi.effort);
  if (pi.no_extensions) args.push("--no-extensions");
  if (pi.no_skills) args.push("--no-skills");
  if (pi.no_context_files) args.push("--no-context-files");
  args.push("--append-system-prompt", call.contractFile);
  return args;
}

export function askArgs(call: AskCall): string[] {
  return call.harness === "claude" ? claudeAskArgs(call) : piAskArgs(call);
}

/**
 * The call's environment: the daemon's own (scrubbed by the caller) pointed at the account's
 * login, as a worker pane gets it: a pinned Claude login drops the credentials Claude ranks
 * above it; a Pi account names its agent directory.
 */
export function askEnv(harness: HarnessId, workers: WorkersConfig, base: Record<string, string>): Record<string, string> {
  const env = { ...base };
  if (harness === "claude") {
    const claude = workers.claude;
    if (claude.pin_login) for (const name of [...CLAUDE_CREDENTIAL_ENV, ...(claude.config_dir ? [] : ["CLAUDE_CONFIG_DIR"])]) delete env[name];
    if (claude.config_dir) env.CLAUDE_CONFIG_DIR = claude.config_dir;
    return env;
  }
  Object.assign(env, workers.pi.env);
  if (workers.pi.agent_dir) env.PI_CODING_AGENT_DIR = workers.pi.agent_dir;
  return env;
}

/** What one call came to, read from its output. */
export type AskOutcome =
  | { kind: "reply"; text: string; costUsd: number | null }
  | { kind: "over_cap"; costUsd: number | null; detail: string }
  | { kind: "error"; costUsd: number | null; detail: string };

/** Claude's JSON result (2.1.314): `subtype` success with `result`, or an error subtype such as error_max_budget_usd. */
export function readClaudeResult(stdout: string): AskOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { kind: "error", costUsd: null, detail: stdout.trim() ? "Claude's output was not its JSON result" : "Claude printed nothing" };
  }
  const result = (parsed ?? {}) as { type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; total_cost_usd?: unknown; errors?: unknown };
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
  if (result.subtype === "error_max_budget_usd") return { kind: "over_cap", costUsd, detail: errors[0] ?? "Claude reached the spend cap" };
  if (result.type !== "result") return { kind: "error", costUsd, detail: "Claude's output was not its JSON result" };
  if (result.subtype !== "success" || result.is_error === true || typeof result.result !== "string") {
    return { kind: "error", costUsd, detail: errors[0] ?? (typeof result.result === "string" && result.result ? result.result : `Claude ended with ${String(result.subtype ?? "no result")}`) };
  }
  return { kind: "reply", text: result.result, costUsd };
}

/**
 * Pi's JSON event stream, read line by line as it arrives: each finished assistant message adds
 * its `usage.cost.total`, so the caller can stop the call once the sum passes the cap (Pi has no
 * cap of its own). The reply is the last assistant message's text.
 */
export class PiMeter {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  costUsd = 0;
  private lastText: string | null = null;
  private lastError: string | null = null;
  private sawEvent = false;

  /** Feed a chunk of stdout; returns the cost so far. */
  feed(chunk: Uint8Array | string): number {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
      this.line(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    return this.costUsd;
  }

  private line(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    let event: { type?: unknown; message?: { role?: unknown; content?: unknown; usage?: { cost?: { total?: unknown } }; stopReason?: unknown; errorMessage?: unknown } };
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    this.sawEvent = true;
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const message = event.message;
    const cost = message.usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) this.costUsd += cost;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      this.lastError = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : `Pi's model call ended with ${String(message.stopReason)}`;
      return;
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    const said = parts
      .filter((p): p is { type: string; text: string } => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("");
    if (said.trim()) {
      this.lastText = said;
      this.lastError = null;
    }
  }

  /** The outcome once the call ended (whatever is left in the buffer is read first). */
  outcome(): AskOutcome {
    if (this.buffer) this.feed("\n");
    const costUsd = this.sawEvent ? this.costUsd : null;
    if (this.lastError !== null) return { kind: "error", costUsd, detail: this.lastError };
    if (this.lastText === null) return { kind: "error", costUsd, detail: this.sawEvent ? "Pi gave no answer" : "Pi printed no events" };
    return { kind: "reply", text: this.lastText, costUsd };
  }
}

/** A reply that asks for a scout: its first non-blank line is the marker; the reason follows it. */
export function scoutRequest(text: string): string | null {
  const first = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!first.toUpperCase().startsWith(NEEDS_SCOUT)) return null;
  const reason = first.slice(NEEDS_SCOUT.length).trim();
  return reason || "the ask said it needs to write or run something";
}

/** The answer's first sentence, for its digest line. */
export function firstSentence(text: string, max = 160): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*(#+|[-*>]|\d+\.)\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  const sentence = match ? match[1]! : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Cut a reply to at most `max` bytes of UTF-8 on a character boundary; whether it was cut. */
export function capBytes(text: string, max: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  let end = max;
  // Step back over continuation bytes (10xxxxxx) so a multi-byte character is never split.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}
