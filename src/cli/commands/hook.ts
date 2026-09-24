import type { Reply } from "../../api/envelope.ts";
import { stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { flowrynHome, socketPath } from "../../config/paths.ts";
import { request, TransportError } from "../../transport/unix.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";

/**
 * `flowryn hook <name>`: the worker's Claude hooks and Pi extension call these
 * (design section 12, role "hook"). They read the hook's JSON input on stdin,
 * call the daemon with the pane's run token, and print what the harness
 * expects. With the daemon down or slow they step aside: exit 0, no output
 * (design section 12), so a hook never stalls a worker. The waiter is the
 * exception: it keeps reconnecting, because a waiter that gave up could not
 * wake an idle worker until its next turn ends.
 */

const HOOK_TIMEOUTS = { connectMs: 300, replyMs: 2_000 };
/** The daemon answers a waiter within its wait_poll_ms; this only bounds a hung connection. */
const WAITER_TIMEOUTS = { connectMs: 300, replyMs: 120_000 };
const WAITER_RETRY_MS = 2_000;
const WAITER_MAX_MS = 8 * 60 * 60 * 1000;

type Harness = "claude" | "pi";

const HOOK_EVENT: Record<string, string> = { "post-tool": "PostToolUse", stop: "Stop" };

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
    roles: ["worker"],
    async local(args, io) {
      const harness = harnessOf(stringArg(args, "harness"));
      const input = await readInput(io);
      const reply = await call(io, `hook.${name}`, { harness, input }, HOOK_TIMEOUTS).catch(() => null);
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

export const HOOK_CLI_VERBS: VerbSpec[] = [
  signalHook("worker-start", "Worker hook: session start; reports the session id and cwd for the isolation check"),
  signalHook("prompt", "Worker hook: a turn started"),
  signalHook("pre-tool", "Worker hook: a tool is about to run"),
  signalHook("post-tool", "Worker hook: a tool finished; may print a pending steer as context"),
  signalHook("stop", "Worker hook: a turn ended; may continue it with a pending steer"),
  signalHook("stop-failure", "Worker hook: a turn ended in an API error"),
  signalHook("session-end", "Worker hook: the harness session ended"),
  waitSteer,
];
