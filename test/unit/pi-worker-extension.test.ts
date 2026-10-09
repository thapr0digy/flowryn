import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { TURN_END_REMINDER } from "../../src/harness/contract-text.ts";

/**
 * The Pi worker extension against a stand-in Pi and a stand-in flowryn: it
 * delivers the steer its long poll returns, says how (hook steer-carried),
 * and reports the steer seen once a context event shows it in a model request;
 * and sends the turn-end guard's reminder, when its stop hook returns one.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

let dir: string;
let log: string;
const handlers = new Map<string, Handler[]>();
const sent: { content: string; options: Record<string, unknown>; customType?: string }[] = [];
let idle = true;
const ctx = { isIdle: () => idle, cwd: "/w", sessionManager: { getSessionId: () => "s1", getSessionFile: () => null } };
const LINE = "Flowryn steer [m1]: use the new API (when done: $FLOWRYN_BIN ack m1)";

async function emit(name: string, event: Record<string, unknown> = {}): Promise<void> {
  for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
}

/** A tool_call as Pi emits it: what its handlers return (a {block, reason} blocks the call). */
async function toolCall(toolName: string, input: Record<string, unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers.get("tool_call") ?? []) results.push(await handler({ type: "tool_call", toolName, input }, ctx));
  return results;
}

/** The stand-in flowryn's calls: "hook <name> --harness pi ... <stdin>", one per line. */
function calls(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fw-piext-"));
  log = join(dir, "calls.log");
  const bin = join(dir, "flowryn");
  // The first wait-steer returns the steer, every later one tells the loop to exit. A stop returns the reminder once.
  writeFileSync(
    bin,
    `#!/bin/sh
input=$(cat)
echo "$* $input" >> ${JSON.stringify(log)}
case "$2" in
  wait-steer)
    if [ -f ${JSON.stringify(join(dir, "fired"))} ]; then echo '{"exit":true}'; else touch ${JSON.stringify(join(dir, "fired"))}; echo '${JSON.stringify({ steer: { id: "m1", line: LINE } })}'; fi ;;
  tool-check)
    case "$input" in
      *'gh pr'*) echo '{"block":true,"reason":"use gh-axi","rule":"github"}' ;;
      *'no answer'*) ;;
      *) echo '{}' ;;
    esac ;;
  stop)
    if [ -f ${JSON.stringify(join(dir, "reminded"))} ]; then echo '{"run":"r1"}'; else touch ${JSON.stringify(join(dir, "reminded"))}; echo '${JSON.stringify({ run: "r1", reminder: true, context: TURN_END_REMINDER })}'; fi ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  process.env.FLOWRYN_BIN = bin;
  process.env.FLOWRYN_WORKTREE = "/w";
  // A copy, loaded as Pi loads it: the adapter imports the original as a file, so its module is not code here.
  const extension = join(dir, "flowryn-worker.ts");
  copyFileSync(join(import.meta.dir, "../../src/harness/pi/extension/flowryn-worker.ts"), extension);
  const factory = (await import(extension)).default as (pi: unknown) => void;
  factory({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(message: { content: string; customType?: string }, options: Record<string, unknown>) {
      sent.push({ content: message.content, options, customType: message.customType });
    },
  });
});

afterAll(() => {
  delete process.env.FLOWRYN_BIN;
  delete process.env.FLOWRYN_WORKTREE;
  rmSync(dir, { recursive: true, force: true });
});

describe("the Pi worker extension's steer delivery", () => {
  test("an idle agent gets a followUp that starts a turn, reported as carried, then as seen from its context event", async () => {
    idle = true;
    await emit("session_start", { reason: "startup" });
    await waitUntil(() => calls().some((c) => c.startsWith("hook steer-carried")), 5_000, "steer-carried");
    expect(sent).toEqual([{ content: LINE, options: { deliverAs: "followUp", triggerTurn: true }, customType: "flowryn-steer" }]);
    expect(calls().find((c) => c.startsWith("hook steer-carried"))).toContain('{"steer":"m1","mode":"followUp"}');

    // A model request without the steer says nothing; the one carrying it reports it seen, once.
    await emit("context", { messages: [{ role: "user", content: "hello" }] });
    await emit("context", { messages: [{ role: "custom", customType: "flowryn-steer", content: LINE }] });
    await emit("context", { messages: [{ role: "custom", customType: "flowryn-steer", content: LINE }] });
    await waitUntil(() => calls().some((c) => c.startsWith("hook steer-seen")), 5_000, "steer-seen");
    await Bun.sleep(200);
    const seen = calls().filter((c) => c.startsWith("hook steer-seen"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('{"steers":["m1"]}');
  });

  test("a turn end the stop hook answers with the turn-end reminder gets it as a followUp that starts a turn; a plain one gets nothing", async () => {
    sent.length = 0;
    await emit("agent_settled");
    await waitUntil(() => sent.length === 1, 5_000, "the reminder sent");
    expect(sent[0]).toEqual({ content: TURN_END_REMINDER, options: { deliverAs: "followUp", triggerTurn: true }, customType: "flowryn-reminder" });
    expect(calls().find((c) => c.startsWith("hook stop"))).toContain("--harness pi --json");
    await emit("agent_settled");
    await waitUntil(() => calls().filter((c) => c.startsWith("hook stop")).length === 2, 5_000, "the second stop");
    await Bun.sleep(200);
    expect(sent).toHaveLength(1);
  });
});

describe("the Pi worker extension's toolkit check", () => {
  test("every tool call asks hook tool-check with the tool, its input and the cwd, and blocks what it denies", async () => {
    expect(await toolCall("bash", { command: "gh pr list" })).toEqual([{ block: true, reason: "use gh-axi" }]);
    const asked = calls().filter((c) => c.startsWith("hook tool-check")).at(-1)!;
    expect(asked).toStartWith("hook tool-check --harness pi ");
    expect(JSON.parse(asked.slice("hook tool-check --harness pi ".length))).toEqual({ tool_name: "bash", tool_input: { command: "gh pr list" }, cwd: "/w" });
    expect(await toolCall("edit", { path: "src/a.ts" })).toEqual([undefined]);
  });

  test("a check that does not answer blocks the call (fails closed)", async () => {
    const [result] = (await toolCall("bash", { command: "echo no answer" })) as { block: boolean; reason: string }[];
    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toContain("tool check did not answer");
  });
});
