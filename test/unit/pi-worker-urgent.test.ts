import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";

/**
 * The Pi worker extension and urgent steers (Tier 2), against a stand-in Pi
 * and a stand-in flowryn: an urgent steer delivered into a busy turn blocks
 * every tool call until it is seen, and once the oldest running tool has run
 * preempt_after_ms the extension asks hook preempt and aborts only on go.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

const AFTER_MS = 100;
let dir: string;
let log: string;
const handlers = new Map<string, Handler[]>();
const sent: { content: string; options: Record<string, unknown> }[] = [];
let idle = false;
let aborts = 0;
const ctx = {
  isIdle: () => idle,
  abort: () => {
    aborts++;
  },
  cwd: "/w",
  sessionManager: { getSessionId: () => "s1", getSessionFile: () => null },
};

function line(id: string): string {
  return `Flowryn steer [${id}]: stop the migration (when done: $FLOWRYN_BIN ack ${id})`;
}

/** The stand-in daemon's next wait-steer reply. */
function offer(id: string): void {
  writeFileSync(join(dir, "next"), JSON.stringify({ steer: { id, line: line(id), urgent: true, preempt_after_ms: AFTER_MS } }));
}

function preemptReply(reply: Record<string, unknown>): void {
  writeFileSync(join(dir, "preempt"), JSON.stringify(reply));
}

async function emit(name: string, event: Record<string, unknown> = {}): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
  return results;
}

function calls(prefix: string): string[] {
  return (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []).filter((c) => c.startsWith(prefix));
}

function steerMessage(id: string) {
  return { role: "custom", customType: "flowryn-steer", content: line(id) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fw-piurg-"));
  log = join(dir, "calls.log");
  const bin = join(dir, "flowryn");
  const next = JSON.stringify(join(dir, "next"));
  writeFileSync(
    bin,
    `#!/bin/sh
input=$(cat)
# A preempt's reply is read before the call is logged, so a test that sees the call can change the next reply.
case "$2" in
  preempt) reply=$(cat ${JSON.stringify(join(dir, "preempt"))}) ;;
esac
echo "$* $input" >> ${JSON.stringify(log)}
case "$2" in
  wait-steer)
    if [ -f ${JSON.stringify(join(dir, "stop"))} ]; then echo '{"exit":true}'; exit 0; fi
    if [ -f ${next} ]; then cat ${next}; rm -f ${next}; else sleep 0.05; echo '{"wait":true}'; fi ;;
  preempt) echo "$reply" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  preemptReply({ defer: "a permission dialog is open" });
  process.env.FLOWRYN_BIN = bin;
  process.env.FLOWRYN_WORKTREE = "/w";
  const extension = join(dir, "flowryn-worker.ts");
  copyFileSync(join(import.meta.dir, "../../src/harness/pi/extension/flowryn-worker.ts"), extension);
  const factory = (await import(extension)).default as (pi: unknown) => void;
  factory({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(message: { content: string }, options: Record<string, unknown>) {
      sent.push({ content: message.content, options });
    },
  });
  await emit("session_start", { reason: "startup" });
});

afterAll(async () => {
  writeFileSync(join(dir, "stop"), "");
  await Bun.sleep(200);
  await emit("session_shutdown");
  delete process.env.FLOWRYN_BIN;
  delete process.env.FLOWRYN_WORKTREE;
  rmSync(dir, { recursive: true, force: true });
});

describe("the Pi worker extension's urgent steers", () => {
  test("into a busy turn between tools: queued as a steer, every tool call blocked until a context event shows it", async () => {
    idle = false;
    offer("m1");
    await waitUntil(() => sent.length === 1, 5_000, "the steer delivered");
    expect(sent[0]).toEqual({ content: line("m1"), options: { deliverAs: "steer" } });
    const blocked = await emit("tool_call", { toolName: "bash", input: { command: "make test" } });
    expect(blocked[0]).toMatchObject({ block: true });
    expect(String((blocked[0] as { reason: string }).reason)).toContain("[m1]");
    // No tool runs, so nothing is timed: the block alone delivers it.
    await Bun.sleep(AFTER_MS + 100);
    expect(calls("hook preempt")).toEqual([]);
    await emit("context", { messages: [steerMessage("m1")] });
    expect((await emit("tool_call", { toolName: "bash", input: {} }))[0]).toBeUndefined();
    await waitUntil(() => calls("hook steer-seen").length === 1, 5_000, "seen");
  });

  test("a tool past the threshold: the extension asks hook preempt, defers while a dialog may be open, and aborts only on go", async () => {
    idle = false;
    preemptReply({ defer: "a permission dialog is open" });
    // Taken before the event: the extension's clock starts inside its handler, a moment later.
    const started = Date.now();
    await emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
    offer("m2");
    await waitUntil(() => calls("hook preempt").length === 1, 5_000, "the first ask");
    expect(Date.now() - started).toBeGreaterThanOrEqual(AFTER_MS);
    expect(calls("hook preempt")[0]).toContain('"steer":"m2"');
    expect(aborts).toBe(0);
    preemptReply({ go: true });
    await waitUntil(() => aborts === 1, 5_000, "the abort after the deferral");
    expect(calls("hook preempt")).toHaveLength(2);
    // The abort settles the turn: the daemon hears the stop and rings the dropped steer again.
    await emit("agent_settled");
    await waitUntil(() => calls("hook stop").length === 1, 5_000, "the stop");
    expect((await emit("tool_call", { toolName: "bash", input: {} }))[0]).toBeUndefined();
    await Bun.sleep(1_200);
    expect(aborts).toBe(1);
  });

  test("a tool that ends before the threshold is never cut; an idle agent gets a followUp and no block", async () => {
    idle = false;
    offer("m3");
    await waitUntil(() => sent.some((m) => m.content === line("m3")), 5_000, "m3 delivered");
    await emit("tool_execution_start", { toolCallId: "c2", toolName: "bash" });
    await Bun.sleep(AFTER_MS / 3);
    await emit("tool_execution_end", { toolCallId: "c2", toolName: "bash" });
    await Bun.sleep(AFTER_MS + 100);
    expect(calls("hook preempt").filter((c) => c.includes("m3"))).toEqual([]);
    await emit("agent_settled");

    idle = true;
    offer("m4");
    await waitUntil(() => sent.some((m) => m.content === line("m4")), 5_000, "m4 delivered");
    expect(sent.find((m) => m.content === line("m4"))!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect((await emit("tool_call", { toolName: "bash", input: {} }))[0]).toBeUndefined();
  });
});
