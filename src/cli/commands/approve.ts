import { closeSync, createReadStream, openSync, writeSync } from "node:fs";
import type { Reply } from "../../api/envelope.ts";
import { errorReply, okReply } from "../../api/envelope.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { flowrynHome, socketPath } from "../../config/paths.ts";
import { request, TransportError } from "../../transport/unix.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";
import { notHumanReason } from "../human.ts";
import { LineReader } from "../line-reader.ts";
import { exitCodeOf, renderReply } from "../render.ts";

/**
 * `flowryn approve <task> [--allow-red <check>] [--discard]` (design section
 * 7): your word, from your own shell. It refuses inside an agent pane (any
 * FLOWRYN_* identity) or without a terminal on stdin and stdout, shows what
 * you would approve (PR, head, checks), and reads a random four-letter code
 * back from /dev/tty, so piped input cannot answer it. The daemon binds the
 * approval to exactly what it showed you. The board's approve key runs the
 * same two steps with channel `board`.
 */

/** A terminal to talk to you on: /dev/tty for approve, the board's own raw keys for the board. */
export interface Tty {
  write(text: string): void;
  /** One line you typed, or null when the input ended or timed out. */
  readLine(timeoutMs: number): Promise<string | null>;
  close(): void;
}

/** The controlling terminal itself, never stdin: a pipe into flowryn cannot answer. */
export function openDevTty(): Tty {
  const fd = openSync("/dev/tty", "r+");
  const stream = createReadStream("/dev/tty", { encoding: "utf8" });
  const lines = new LineReader(stream);
  return {
    write: (text) => void writeSync(fd, text),
    async readLine(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const line = await Promise.race([lines.next(), timeout]);
      clearTimeout(timer);
      return line;
    },
    close() {
      lines.close();
      stream.destroy();
      closeSync(fd);
    },
  };
}

export async function daemonCall(env: NodeJS.ProcessEnv, verb: string, args: Record<string, unknown>, replyMs = 60_000): Promise<Reply> {
  try {
    return (await request(socketPath(flowrynHome(env), env), { proto: PROTO, ulid: ulid(), verb, token: null, channel: "tty", args }, { connectMs: 1_000, replyMs })) as Reply;
  } catch (error) {
    if (error instanceof TransportError) return errorReply({ code: "daemon_unavailable", message: `the daemon is not running (${error.message})`, help: "flowryn daemon start" });
    throw error;
  }
}

const CODE_WAIT_MS = 115_000;

export interface ApprovalFlow {
  task: string;
  allowRed?: string;
  discard?: boolean;
  channel: "cli-tty" | "board";
  actor: string;
}

/** Show what would be approved, read the code back, record the approval. The reply is the daemon's. */
export async function runApprovalFlow(env: NodeJS.ProcessEnv, tty: Tty, flow: ApprovalFlow): Promise<Reply> {
  const begun = await daemonCall(env, "approve.begin", { task: flow.task, "allow-red": flow.allowRed, discard: flow.discard || undefined, channel: flow.channel });
  if (!begun.ok) return begun;
  const d = begun.data as Record<string, unknown>;
  const lines =
    d.action === "discard"
      ? [
          `Discard the unlanded work of ${d.task}: ${d.title}`,
          `  worktree ${d.worktree}`,
          `  branch ${d.branch} at ${String(d.head).slice(0, 12)}, ${d.uncommitted} uncommitted change(s)`,
          "  This cannot be undone once the worktree is removed.",
        ]
      : [
          `Merge ${d.task}: ${d.title} (${d.project})`,
          `  ${d.kind === "local" ? "branch" : "PR"} ${d.target}`,
          `  head ${String(d.head).slice(0, 12)}  checks ${d.checks}${d.sensitive ? "  SENSITIVE" : ""}`,
          ...(d.waive && d.waive !== "-" ? [`  waiving the failing check ${d.waive}`] : []),
        ];
  tty.write(`\n${lines.join("\n")}\n\nType ${d.code} to approve (anything else cancels): `);
  const typed = await tty.readLine(CODE_WAIT_MS);
  tty.write("\n");
  if (typed === null || typed.trim().toUpperCase() !== String(d.code)) {
    // Use up the challenge either way, so a stale code is never accepted later.
    await daemonCall(env, "approve.confirm", { challenge: d.challenge, code: "-", actor: flow.actor }).catch(() => null);
    return errorReply({ code: "challenge_failed", message: typed === null ? "no code was typed in time; nothing was approved" : "the code does not match; nothing was approved", help: `flowryn approve ${flow.task}` });
  }
  return daemonCall(env, "approve.confirm", { challenge: d.challenge, code: typed.trim(), actor: flow.actor });
}

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

const approve: VerbSpec = {
  name: "approve",
  summary: "Approve a merge (or a discard) in your own terminal: shows the PR, head and checks, reads a code from /dev/tty",
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: {
    "allow-red": { type: "string", help: "waive exactly one failing check; every other check must be green", placeholder: "check" },
    discard: { type: "boolean", help: "approve discarding the task's unlanded work (flowryn cleanup --discard)" },
    gate: { type: "string", help: "review gates arrive with workflows in M5", placeholder: "stage" },
  },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
    if (reason || !io.stdinIsTty || !io.stdoutIsTty) {
      return print(io, errorReply({ code: "human_only", message: `approve runs only in your own terminal: ${reason ?? "stdin and stdout must both be a terminal"}` }));
    }
    if (stringArg(args, "gate")) return print(io, errorReply({ code: "not_supported", message: "review gates arrive with workflows in M5" }));
    let tty: Tty;
    try {
      tty = openDevTty();
    } catch (error) {
      return print(io, errorReply({ code: "human_only", message: `cannot open /dev/tty: ${(error as Error).message}` }));
    }
    try {
      const reply = await runApprovalFlow(io.env, tty, {
        task: stringArg(args, "task")!,
        allowRed: stringArg(args, "allow-red"),
        discard: boolArg(args, "discard"),
        channel: "cli-tty",
        actor: io.env.USER || io.env.LOGNAME || "you",
      });
      return print(io, reply.ok ? okReply(reply.data, reply.hints) : reply);
    } finally {
      tty.close();
    }
  },
};

export const APPROVE_VERBS: VerbSpec[] = [approve];
