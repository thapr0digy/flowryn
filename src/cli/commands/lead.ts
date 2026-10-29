import { basename } from "node:path";
import { pinnedLink } from "../../daemon/caller-binary.ts";
import type { Reply } from "../../api/envelope.ts";
import { errorReply } from "../../api/envelope.ts";
import { EXIT } from "../../api/errors.ts";
import { boolArg, stringArg, type CliIo, type VerbSpec } from "../../api/verbs.ts";
import { FlowrynError } from "../../api/errors.ts";
import { harnessAccounts, type Account } from "../../config/accounts.ts";
import type { FlowrynConfig } from "../../config/config.ts";
import { applyLogin, leaderAccount, loginArgs, sessionProjectsDir } from "../../leader/login.ts";
import { scopeIds } from "../../leader/scope.ts";
import type { StaticLayers } from "../../policy/static.ts";
import { homedir } from "node:os";
import { writeLeaderFiles, type LeaderFiles } from "../../bridges/files.ts";
import { loadConfig, resolveTool } from "../../config/config.ts";
import { grantsConfig, leaderTiming } from "../../config/leader.ts";
import { styleBlock } from "../../config/workflows.ts";
import { flowrynHome, socketPath } from "../../config/paths.ts";
import { leaderStaticLayers } from "../../policy/static.ts";
import { BLANKED_ENV } from "../../lifecycle/launcher.ts";
import { selfCommand } from "../../service/launchd.ts";
import { request, TransportError } from "../../transport/unix.ts";
import { ulid } from "../../util/ulid.ts";
import { PROTO } from "../../version.ts";
import { notHumanReason } from "../human.ts";
import { exitCodeOf, renderReply } from "../render.ts";

/**
 * `flowryn lead [--pi] [--account <id>] [-- <harness args>]` (design sections 5
 * and 15): start a leader in your terminal. It picks the account the leader
 * runs on (`--account`, else the one whose login folder your terminal points
 * at; src/leader/login.ts), registers a leader session in that account's
 * scope with the daemon, writes the leader files, and runs Claude Code with
 * the leader-only settings file (--settings) or Pi with the leader extension
 * (-e), plus the flowryn skill and the terse style block, on that login. Your
 * global harness settings are never edited. The session's token reaches the
 * harness through its environment; the session claims its scope's lease at
 * its first hook if the lease is free.
 */

type Harness = "claude" | "pi";

export interface LeaderLaunch {
  args: string[];
  env: Record<string, string>;
}

export function claudeLeaderArgs(files: LeaderFiles, passthrough: string[]): string[] {
  // The leader always runs in auto mode: the approval channel needs it (design sections 7 and 18).
  const args = ["--settings", files.claudeSettings, "--permission-mode", "auto", "--plugin-dir", files.claudePlugin];
  return [...args, "--append-system-prompt-file", files.appendPrompt, ...passthrough];
}

export function piLeaderArgs(files: LeaderFiles, passthrough: string[]): string[] {
  // --append-system-prompt takes text or a file (M0 p05); -e scopes the extension to this process (M0 p12).
  const args = ["-e", files.piExtension, "--skill", files.skillDir];
  return [...args, "--append-system-prompt", files.appendPrompt, ...passthrough];
}

/**
 * The leader settings' static layers. The file is shared by every leader of the home, so it denies
 * writing the transcripts of every Claude account a leader may run on, and with more than one scope
 * it denies reading Flowryn's shared task stores (src/policy/static.ts).
 */
export function leaderToolkit(config: FlowrynConfig, env: NodeJS.ProcessEnv): StaticLayers {
  const fallback = grantsConfig(config, env).claude_projects_dir;
  const dirs = [fallback, ...harnessAccounts(config, "claude").map((a) => sessionProjectsDir(config, a.id, fallback, env.HOME ?? homedir()))];
  return leaderStaticLayers(config, dirs, { multiScope: scopeIds(config).length > 1 });
}

export interface LeaderEnvInput {
  token: string;
  session: string;
  files: LeaderFiles;
  inactiveMs: number;
  /** The account the leader runs on: its login goes into the harness's environment. */
  account?: Account;
}

/** The harness's environment: yours, minus an inherited Claude session identity (M0 finding 1), plus the session's credentials. */
export function leaderEnv(base: NodeJS.ProcessEnv, input: LeaderEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  for (const key of BLANKED_ENV) delete env[key];
  delete env.FLOWRYN_RUN;
  env.FLOWRYN_TOKEN = input.token;
  env.FLOWRYN_LEADER_SESSION = input.session;
  env.FLOWRYN_BIN = input.files.bin;
  env.FLOWRYN_LEADER_INACTIVE_MS = String(input.inactiveMs);
  env.PATH = `${input.files.binDir}:${env.PATH ?? "/usr/bin:/bin"}`;
  if (input.account) {
    applyLogin(env, input.account);
    // The hook process's toolkit check reads this scope's folder guard (src/policy/toolkit.ts scope-paths).
    env.FLOWRYN_LEADER_SCOPE = input.account.scope;
  }
  return env;
}

async function call(io: CliIo, verb: string, args: Record<string, unknown>, token: string | null): Promise<Reply | null> {
  const sock = socketPath(flowrynHome(io.env), io.env);
  try {
    return (await request(sock, { proto: PROTO, ulid: ulid(), verb, token, channel: token ? null : "tty", args }, { connectMs: 1_000, replyMs: 10_000 })) as Reply;
  } catch (error) {
    if (error instanceof TransportError) return null;
    throw error;
  }
}

function ignore(): void {}

function print(io: CliIo, reply: Reply): number {
  io.stdout(renderReply(reply, { json: io.json }));
  return exitCodeOf(reply);
}

const lead: VerbSpec = {
  name: "lead",
  summary: "Start a leader here: Claude Code, or Pi with --pi (words after -- go to the harness)",
  positionals: [],
  flags: {
    pi: { type: "boolean", help: "lead with Pi instead of Claude Code" },
    account: { type: "string", help: "the account to lead on; default: the one whose login folder your terminal points at (its scope is what the leader sees)", placeholder: "id", complete: "account" },
  },
  rest: { name: "args", help: "arguments for the harness, after --" },
  kind: "local",
  roles: ["human"],
  async local(args, io) {
    const reason = notHumanReason({ env: io.env, stdinIsTty: io.stdinIsTty, stdoutIsTty: io.stdoutIsTty });
    if (reason || !io.stdinIsTty || !io.stdoutIsTty) {
      return print(io, errorReply({ code: "human_only", message: `lead runs only in your own terminal: ${reason ?? "it needs a terminal for the harness"}` }));
    }
    const harness: Harness = boolArg(args, "pi") ? "pi" : "claude";
    const passthrough = Array.isArray(args.args) ? (args.args as string[]) : [];
    const home = flowrynHome(io.env);
    const { config } = loadConfig(home);
    const binary = resolveTool(config, harness);
    if (!binary) return print(io, errorReply({ code: "tool_missing", message: `${harness} is not installed or not in [tools]`, help: "flowryn init" }));
    let account: Account;
    try {
      account = leaderAccount(config, harness, stringArg(args, "account") ?? null, io.env);
    } catch (error) {
      if (error instanceof FlowrynError) return print(io, errorReply(error.toBody()));
      throw error;
    }

    const opened = await call(io, "lead.open", { harness, pane: io.env.HERDR_PANE_ID || undefined, cwd: process.cwd(), account: account.id }, null);
    if (!opened) return print(io, errorReply({ code: "daemon_unavailable", message: "the daemon is not running", help: "flowryn daemon start" }));
    if (!opened.ok) return print(io, opened);
    const { session, token } = opened.data as { session: string; token: string };

    // A compiled leader's hooks run the build the daemon runs (src/daemon/caller-binary.ts), so a rebuild never strands them on a newer protocol.
    const self = selfCommand();
    const command = self.length === 1 ? [pinnedLink(config.state_dir) ?? self[0]!] : self;
    const files = await writeLeaderFiles({ home, socket: socketPath(home, io.env), command, style: styleBlock(config), toolkit: leaderToolkit(config, io.env) });
    const launchArgs = harness === "claude" ? claudeLeaderArgs(files, passthrough) : piLeaderArgs(files, [...loginArgs(account), ...passthrough]);
    const env = leaderEnv(io.env, { token, session, files, inactiveMs: leaderTiming(config).inactive_ms, account });
    io.stderr(`flowryn: leader session ${session} (${harness}, account ${account.id}, scope ${account.scope}); ${basename(binary)} starting\n`);

    const child = Bun.spawn([binary, ...launchArgs], { stdio: ["inherit", "inherit", "inherit"], env });
    // Ctrl+C belongs to the harness (it interrupts a turn); this process only waits and cleans up.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onTerm = forward("SIGTERM");
    const onHup = forward("SIGHUP");
    process.on("SIGINT", ignore);
    process.on("SIGQUIT", ignore);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
    try {
      await call(io, "lead.attach", { pid: child.pid }, token).catch(() => null);
      const code = await child.exited;
      await call(io, "lead.close", { reason: `harness exited ${code}` }, token).catch(() => null);
      return code ?? EXIT.failure;
    } finally {
      process.off("SIGINT", ignore);
      process.off("SIGQUIT", ignore);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
    }
  },
};

export const LEAD_VERBS: VerbSpec[] = [lead];
