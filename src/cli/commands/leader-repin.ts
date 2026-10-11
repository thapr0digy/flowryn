import { resolve } from "node:path";
import type { Reply } from "../../api/envelope.ts";
import { errorReply, okReply } from "../../api/envelope.ts";
import { stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { notHumanReason } from "../human.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { daemonCall, openDevTty, type Tty } from "./approve.ts";

/**
 * `flowryn leader repin [<dir>]` (docs/notes/2026-10-11-flowryn-leader-repin-xv.md): your word,
 * from your own terminal, the same channel as `flowryn approve`. It refuses inside an agent pane
 * (any FLOWRYN_* identity) or without a terminal on stdin and stdout, shows the leader's pinned
 * directory and the one its Claude transcript is really under, and reads a random four-letter code
 * back from /dev/tty, so piped input cannot answer it. The daemon binds the repin to exactly what
 * it showed you.
 */

const CODE_WAIT_MS = 115_000;

/** Show what the repin changes, read the code back, repin. The reply is the daemon's. */
export async function runRepinFlow(env: NodeJS.ProcessEnv, tty: Tty, flow: { dir: string | null; actor: string }): Promise<Reply> {
  const begun = await daemonCall(env, "leader.repin.begin", { dir: flow.dir ?? undefined });
  if (!begun.ok) return begun;
  const d = begun.data as Record<string, unknown>;
  const voids = Number(d.live_grants);
  const lines = [
    `Repin leader session ${d.session}${d.pane !== "-" ? ` (claude in pane ${d.pane})` : ""}`,
    `  transcript  ${d.transcript}`,
    `  Claude session ${d.claude_session}, its process runs in ${d.process_cwd}`,
    `  pinned now  ${d.old_cwd}`,
    `  repin to    ${d.new_cwd}   (${d.from === "argument" ? "the directory you named" : "the transcript's own cwd"})`,
    `  Every chat-answer grant from before now stops working${voids > 0 ? `; ${voids} live grant${voids === 1 ? " is" : "s are"} voided` : ""}.`,
  ];
  tty.write(`\n${lines.join("\n")}\n\nType ${d.code} to repin (anything else cancels): `);
  const typed = await tty.readLine(CODE_WAIT_MS);
  tty.write("\n");
  if (typed === null || typed.trim().toUpperCase() !== String(d.code)) {
    // Use up the challenge either way, so a stale code is never accepted later.
    await daemonCall(env, "leader.repin.confirm", { challenge: d.challenge, code: "-", actor: flow.actor }).catch(() => null);
    return errorReply({ code: "challenge_failed", message: typed === null ? "no code was typed in time; nothing was repinned" : "the code does not match; nothing was repinned", help: "flowryn leader repin" });
  }
  return daemonCall(env, "leader.repin.confirm", { challenge: d.challenge, code: typed.trim(), actor: flow.actor });
}

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

const leaderRepin: VerbSpec = {
  name: "leader repin",
  summary: "Move the leading Claude session's pinned directory to the one its transcript is under, in your own terminal: reads a code from /dev/tty",
  positionals: [{ name: "dir", required: false, help: "the directory to pin; default: the one the transcript names" }],
  flags: {},
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
    if (reason || !io.stdinIsTty || !io.stdoutIsTty) {
      return print(io, errorReply({ code: "human_only", message: `leader repin runs only in your own terminal: ${reason ?? "stdin and stdout must both be a terminal"}` }));
    }
    let tty: Tty;
    try {
      tty = openDevTty();
    } catch (error) {
      return print(io, errorReply({ code: "human_only", message: `cannot open /dev/tty: ${(error as Error).message}` }));
    }
    try {
      const dir = stringArg(args, "dir");
      const reply = await runRepinFlow(io.env, tty, { dir: dir ? resolve(dir) : null, actor: io.env.USER || io.env.LOGNAME || "you" });
      return print(io, reply.ok ? okReply(reply.data, reply.hints) : reply);
    } finally {
      tty.close();
    }
  },
};

export const LEADER_REPIN_VERBS: VerbSpec[] = [leaderRepin];
