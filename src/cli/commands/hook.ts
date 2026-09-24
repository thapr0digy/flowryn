import type { Reply } from "../../api/envelope.ts";
import { stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { flowrynHome, socketPath } from "../../config/paths.ts";
import { request, TransportError } from "../../transport/unix.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";

/**
 * `flowryn hook <name>`: the Claude hooks and Pi extensions of workers and
 * leaders call these (design section 12, role "hook"). They read the hook's
 * JSON input on stdin, call the daemon with the pane's run token or the leader
 * session's token, and print what the harness expects. With the daemon down
 * or slow they step aside: exit 0, no output (design section 12), so a hook
 * never stalls a worker or your prompt. The waiters are the exception: they
 * keep reconnecting, because a waiter that gave up could not wake an idle
 * session until its next turn ends.
 */

const HOOK_TIMEOUTS = { connectMs: 300, replyMs: 2_000 };
/** The daemon answers a waiter within its wait_poll_ms; this only bounds a hung connection. */
const WAITER_TIMEOUTS = { connectMs: 300, replyMs: 120_000 };
const WAITER_RETRY_MS = 2_000;
const WAITER_MAX_MS = 8 * 60 * 60 * 1000;

type Harness = "claude" | "pi";

/** Claude hook events whose additionalContext reaches the model (M0 c02, c06, c07; SessionStart for the briefing). */
const HOOK_EVENT: Record<string, string> = { "session-start": "SessionStart", prompt: "UserPromptSubmit", "post-tool": "PostToolUse", stop: "Stop" };

/** When this process started (ms): a digest the hook cannot hand over in time must not count as carried. */
function processStart(): number {
  return Math.round(performance.timeOrigin);
}

async function call(io: CliIo, verb: string, args: Record<string, unknown>, timeouts: { connectMs: number; replyMs: number }): Promise<Reply | null> {
  const token = io.env.FLOWRYN_TOKEN;
  if (!token) return null;
  try {
    return (await request(socketPath(flowrynHome(io.env), io.env), { proto: PROTO, ulid: ulid(), verb, token, args }, timeouts)) as Reply;
  } catch (error) {
    if (error instanceof TransportError) return null;
    throw error;
  }
}

async function readInput(io: CliIo): Promise<string> {
  if (io.stdinIsTty || !io.stdin) return "";
  try {
    return await io.stdin();
  } catch {
    return "";
  }
}

function harnessOf(value: string | undefined): Harness {
  return value === "pi" ? "pi" : "claude";
}

function signalHook(name: string, summary: string): VerbSpec {
  return {
    name: `hook ${name}`,
    summary,
    positionals: [],
    flags: { harness: { type: "string", help: "claude (default) or pi", placeholder: "harness" } },
    kind: "local",
    roles: ["worker", "hook"],
    async local(args, io) {
      const harness = harnessOf(stringArg(args, "harness"));
      const input = await readInput(io);
      const reply = await call(io, `hook.${name}`, { harness, input, "started-at": processStart() }, HOOK_TIMEOUTS).catch(() => null);
      if (!reply || !reply.ok) return 0;
      const data = (reply.data ?? {}) as Record<string, unknown>;
      if (io.json) {
        io.stdout(JSON.stringify(data) + "\n");
        return 0;
      }
      const event = HOOK_EVENT[name];
      if (harness === "claude" && event && typeof data.context === "string") {
        io.stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: data.context } }) + "\n");
      }
      return 0;
    },
  };
}

/**
 * The waiter. Claude: an asyncRewake Stop hook; exit 2 with one line on stderr
 * wakes the idle session (M0 c01). Pi: the extension's long poll; one JSON
 * line on stdout with the steer or a control command.
 */
const waitSteer: VerbSpec = {
  name: "hook wait-steer",
  summary: "Wait for a steer and wake the worker (Claude asyncRewake waiter, Pi long poll)",
  positionals: [],
  flags: { harness: { type: "string", help: "claude (default) or pi", placeholder: "harness" } },
  kind: "local",
  roles: ["worker"],
  async local(args, io) {
    const harness = harnessOf(stringArg(args, "harness"));
    await readInput(io);
    if (!io.env.FLOWRYN_TOKEN) return 0;
    const waiter = ulid();
    const deadline = Date.now() + WAITER_MAX_MS;
    while (Date.now() < deadline) {
      const reply = await call(io, "hook.wait-steer", { harness, waiter }, WAITER_TIMEOUTS).catch(() => null);
      if (!reply) {
        await Bun.sleep(WAITER_RETRY_MS);
        continue;
      }
      if (!reply.ok) {
        const code = reply.error?.code;
        // The run ended or its token changed: nothing left to wait for.
        if (code === "bad_token" || code === "not_found" || code === "protocol_mismatch") return 0;
        await Bun.sleep(WAITER_RETRY_MS);
        continue;
      }
      const data = (reply.data ?? {}) as { exit?: boolean; wait?: boolean; command?: string; fire?: { id: string; line: string } };
      if (data.exit) {
        if (harness === "pi") io.stdout(JSON.stringify({ exit: true }) + "\n");
        return 0;
      }
      if (data.command) {
        io.stdout(JSON.stringify({ command: data.command }) + "\n");
        return 0;
      }
      if (data.fire) {
        if (harness === "pi") {
          io.stdout(JSON.stringify({ steer: data.fire }) + "\n");
          return 0;
        }
        io.stderr(`${data.fire.line}\n`);
        return 2;
      }
    }
    return 0;
  },
};

/**
 * The leader's P0 waiter. Claude: an asyncRewake hook at SessionStart and
 * every Stop; exit 2 with the one P0 line on stderr wakes an idle session
 * (M0 c01). Pi: the leader extension's long poll; one JSON line on stdout.
 * Exits 0 silently when superseded, when the session ends or loses the lease.
 */
const waitP0: VerbSpec = {
  name: "hook wait-p0",
  summary: "Leader: wait for a P0 to push (Claude asyncRewake waiter, Pi long poll)",
  positionals: [],
  flags: { harness: { type: "string", help: "claude (default) or pi", placeholder: "harness" } },
  kind: "local",
  roles: ["hook"],
  async local(args, io) {
    const harness = harnessOf(stringArg(args, "harness"));
    await readInput(io);
    if (!io.env.FLOWRYN_TOKEN) return 0;
    const waiter = ulid();
    const deadline = Date.now() + WAITER_MAX_MS;
    const exit = () => {
      if (harness === "pi") io.stdout(JSON.stringify({ exit: true }) + "\n");
      return 0;
    };
    while (Date.now() < deadline) {
      const reply = await call(io, "hook.wait-p0", { harness, waiter }, WAITER_TIMEOUTS).catch(() => null);
      if (!reply) {
        await Bun.sleep(WAITER_RETRY_MS);
        continue;
      }
      if (!reply.ok) {
        const code = reply.error?.code;
        if (code === "bad_token" || code === "not_found" || code === "protocol_mismatch" || code === "role_refused") return exit();
        await Bun.sleep(WAITER_RETRY_MS);
        continue;
      }
      const data = (reply.data ?? {}) as { exit?: boolean; wait?: boolean; fire?: { id: string; line: string; mode: string } };
      if (data.exit) return exit();
      if (data.fire) {
        if (harness === "pi") {
          io.stdout(JSON.stringify({ deliver: data.fire }) + "\n");
          return 0;
        }
        io.stderr(`${data.fire.line}\n`);
        return 2;
      }
    }
    return exit();
  },
};

export const HOOK_CLI_VERBS: VerbSpec[] = [
  signalHook("worker-start", "Worker hook: session start; reports the session id and cwd for the isolation check"),
  signalHook("prompt", "Hook: a turn started; a leader gets its P1 digest"),
  signalHook("pre-tool", "Hook: a tool is about to run"),
  signalHook("post-tool", "Hook: a tool finished; may print a pending steer as context"),
  signalHook("stop", "Hook: a turn ended; may continue it with a steer (worker) or a P0 (leader)"),
  signalHook("stop-failure", "Hook: a turn ended in an API error"),
  signalHook("session-end", "Hook: the harness session ended"),
  waitSteer,
  signalHook("session-start", "Leader hook: session start or compaction; prints the briefing"),
  signalHook("notify", "Leader hook: you went inactive (Claude idle_prompt) or came back (Pi)"),
  signalHook("delivered", "Leader hook (Pi): a pushed P0 was delivered or declined"),
  waitP0,
];
