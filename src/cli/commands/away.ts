import type { Reply } from "../../api/envelope.ts";
import { errorReply, okReply } from "../../api/envelope.ts";
import { SERVER_VERBS } from "../../api/registry.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { agentIdentity, notHumanReason } from "../human.ts";
import { runServerVerb } from "../client.ts";
import { exitCodeOf, renderReply } from "../render.ts";
import { daemonCall, openDevTty, type Tty } from "./approve.ts";

/**
 * `flowryn away` as the CLI runs it (docs/notes/2026-11-05-unattended-mode-one-9e.md). Plain
 * `away`, and any call from an agent pane (the leader's, with its token), goes to the daemon's
 * verb unchanged. `away --autonomous` in your own terminal grants unattended mode the way
 * `flowryn approve` approves: it shows the terms (projects, end time, what parks), and reads a
 * four-letter code back from /dev/tty, so piped input cannot answer it.
 */

const CODE_WAIT_MS = 115_000;

function serverAway(): VerbSpec {
  const spec = SERVER_VERBS.find((v) => v.name === "away");
  if (!spec) throw new Error("no server verb away");
  return spec;
}

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

export interface AutonomyFlow {
  until?: string;
  projects?: string;
  words?: string;
  actor: string;
}

/** Show what would be granted, read the code back, record the grant. The reply is the daemon's. */
export async function runAutonomyFlow(env: NodeJS.ProcessEnv, tty: Tty, flow: AutonomyFlow): Promise<Reply> {
  const begun = await daemonCall(env, "autonomy.begin", { until: flow.until, projects: flow.projects, body: flow.words });
  if (!begun.ok) return begun;
  const d = begun.data as Record<string, unknown>;
  const lines = [
    `Start unattended mode until ${d.until} (${d.in}) for: ${d.projects}`,
    `  ${d.summary}`,
    `  Questions of these kinds park their task for you: ${d.reserved}.`,
  ];
  tty.write(`\n${lines.join("\n")}\n\nType ${d.code} to grant it (anything else cancels): `);
  const typed = await tty.readLine(CODE_WAIT_MS);
  tty.write("\n");
  if (typed === null || typed.trim().toUpperCase() !== String(d.code)) {
    // Use up the challenge either way, so a stale code is never accepted later.
    await daemonCall(env, "autonomy.confirm", { challenge: d.challenge, code: "-", actor: flow.actor }).catch(() => null);
    return errorReply({ code: "challenge_failed", message: typed === null ? "no code was typed in time; nothing was granted" : "the code does not match; nothing was granted", help: "flowryn away --autonomous" });
  }
  return daemonCall(env, "autonomy.confirm", { challenge: d.challenge, code: typed.trim(), actor: flow.actor });
}

const away: VerbSpec = {
  ...serverAway(),
  kind: "local",
  async local(args, io) {
    // An agent pane (a leader's token) and plain away go to the daemon as they are.
    if (!boolArg(args, "autonomous") || agentIdentity(io.env) !== null) return runServerVerb(serverAway(), args, io);
    const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
    if (reason || !io.stdinIsTty || !io.stdoutIsTty) {
      return print(io, errorReply({ code: "human_only", message: `away --autonomous runs only in your own terminal: ${reason ?? "stdin and stdout must both be a terminal"}`, help: "or ask the leader, which asks you once in chat" }));
    }
    let tty: Tty;
    try {
      tty = openDevTty();
    } catch (error) {
      return print(io, errorReply({ code: "human_only", message: `cannot open /dev/tty: ${(error as Error).message}` }));
    }
    try {
      const reply = await runAutonomyFlow(io.env, tty, { until: stringArg(args, "until"), projects: stringArg(args, "projects"), words: stringArg(args, "body"), actor: io.env.USER || io.env.LOGNAME || "you" });
      return print(io, reply.ok ? okReply(reply.data, reply.hints) : reply);
    } finally {
      tty.close();
    }
  },
};

export const AWAY_CLI_VERBS: VerbSpec[] = [away];
