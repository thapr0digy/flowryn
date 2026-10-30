#!/usr/bin/env bun
/**
 * A stand-in for `claude -p` and `pi -p` in test homes: the print-mode call an ask makes
 * (src/ask/harness.ts). The fleet's stand-in harness binaries exec it for `-p` (fleet-env.ts
 * versionScript); nothing reaches a model. It writes what Claude 2.1.314 and Pi 0.87.1 write
 * (Claude: one JSON result; Pi: its JSON event stream), read live in the build of
 * docs/notes/2026-10-30-ask-a-lightweight-4v.md.
 *
 * argv: <claude|pi> <call log> <the harness's own argv...>; the question is on stdin.
 * It follows the question by fixed rules:
 *   - "Reply with the single word X": the reply is X (the contract suite's ask step);
 *   - Pi's `FLOWRYN-SCRIPT: say X ;; ...`: each `say` is one assistant message;
 *   - `ASK: <directive>` lines: reply <text> (`\n` for a newline), scout <why> (the reply asks
 *     for a scout), fail <message>, overcap (Claude: its budget error; Pi: costly messages until
 *     stopped), cost <usd> (each Pi message's cost), sleep <ms> (before replying), argv (the
 *     reply is this call's argv, cwd and login env as JSON), big <bytes> (a reply that long).
 * Every call appends {harness, argv, cwd, stdin} to the call log.
 */
import { appendFileSync } from "node:fs";

const [harness, log, ...argv] = process.argv.slice(2);
const question = await new Response(Bun.stdin.stream()).text();
appendFileSync(log!, JSON.stringify({ harness, argv, cwd: process.cwd(), stdin: question }) + "\n");

function directive(name: string): string | null {
  const line = question.split("\n").find((l) => l.startsWith(`ASK: ${name}`));
  return line === undefined ? null : line.slice(`ASK: ${name}`.length).trim();
}

function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

const sleep = directive("sleep");
if (sleep) await Bun.sleep(Number(sleep));

function replies(): string[] {
  const script = /FLOWRYN-SCRIPT:(.*)$/m.exec(question);
  if (harness === "pi" && script) {
    return script[1]!
      .split(";;")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("say "))
      .map((s) => s.slice(4));
  }
  const reply = directive("reply");
  if (reply !== null) return [reply.replaceAll("\\n", "\n")];
  const scout = directive("scout");
  if (scout !== null) return [`NEEDS-SCOUT: ${scout}`];
  const big = directive("big");
  if (big !== null) return [`Big answer. ${"x".repeat(Number(big))}`];
  if (directive("argv") !== null) {
    const login = Object.fromEntries(["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "ANTHROPIC_API_KEY", "FLOWRYN_HOME", "CLAUDECODE"].map((k) => [k, process.env[k] ?? null]));
    return [JSON.stringify({ argv, cwd: process.cwd(), env: login })];
  }
  const word = /Reply with the single word (\S+?)[ .]/.exec(question);
  if (word) return [word[1]!];
  return ["I have no rule for this question."];
}

const fail = directive("fail");
const overcap = directive("overcap") !== null;
const cost = Number(directive("cost") ?? "0.001");

if (harness === "claude") {
  const cap = Number(flag("--max-budget-usd") ?? "0");
  if (overcap) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: null, total_cost_usd: cap + 0.01, errors: [`Reached maximum budget ($${cap})`], terminal_reason: "budget_exhausted" }) + "\n");
    process.exit(1);
  }
  if (fail !== null) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: null, total_cost_usd: 0.002, errors: [fail] }) + "\n");
    process.exit(1);
  }
  const text = replies().at(-1)!;
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.0123, num_turns: 1, terminal_reason: "completed" }) + "\n");
  process.exit(0);
}

// Pi: its event stream, one JSON object per line.
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
const usage = (c: number) => ({ input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: c, cacheRead: 0, cacheWrite: 0, total: c } });
const assistant = (text: string, c: number, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], usage: usage(c), stopReason: "stop", ...extra });
emit({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: question }] } });
if (overcap) {
  for (let i = 0; i < 400; i++) {
    emit({ type: "message_update", usage: usage(cost), assistantMessageEvent: { type: "text_delta" } });
    emit({ type: "message_end", message: assistant(`step ${i}`, cost) });
    await Bun.sleep(25);
  }
  process.exit(0);
}
if (fail !== null) {
  emit({ type: "message_end", message: { ...assistant("", cost), content: [], stopReason: "error", errorMessage: fail } });
  emit({ type: "agent_end", messages: [], willRetry: false });
  process.exit(1);
}
for (const text of replies()) {
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", usage: usage(cost), assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({ type: "message_end", message: assistant(text, cost) });
}
emit({ type: "agent_end", messages: [], willRetry: false });
emit({ type: "agent_settled" });
