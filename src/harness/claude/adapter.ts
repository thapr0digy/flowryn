import { basename, join } from "node:path";
import type { WorkersConfig } from "../../config/workers.ts";
import type { PaneProcess } from "../../runtime/herdr/runtime.ts";
import { HOOK_SIGNALS, type HarnessAdapter, type HookName, type LaunchPlan, type RunContext, type Trust } from "../types.ts";
import { claudeConfigDir, checkOrRegisterTrust } from "./trust.ts";

/** The asyncRewake waiter's timeout: 8 h, re-armed by every Stop (design section 5, M0 c01). */
export const WAITER_TIMEOUT_S = 28_800;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function hookCommand(bin: string, hook: string): string {
  return `${shellQuote(bin)} hook ${hook} --harness claude`;
}

/**
 * The per-run settings file carrying the worker hooks. It is passed with
 * --settings, which scopes it to this one session and merges it with the
 * user's own hooks (M0 c11); nothing is written to global settings.
 *
 * When the user runs Claude's Bash sandbox, a worker's `$FLOWRYN_BIN` calls
 * run inside it, while hooks do not. Found live in M2: the sandbox refused the
 * daemon socket, so every worker verb failed. The settings therefore allow
 * this one socket, and writes to the run's spool and report directories (for a
 * ship, also what a commit in its linked worktree writes, while the project's
 * git hooks and config stay denied); they change nothing when the sandbox is
 * off.
 */
export function workerSettings(bin: string, access: { socket: string; writable: string[]; readOnly?: string[] } = { socket: "", writable: [] }): Record<string, unknown> {
  const command = (hook: string) => ({ type: "command", command: hookCommand(bin, hook) });
  return {
    hooks: {
      SessionStart: [{ hooks: [command("worker-start")] }],
      UserPromptSubmit: [{ hooks: [command("prompt")] }],
      PreToolUse: [{ matcher: "*", hooks: [command("pre-tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [command("post-tool")] }],
      Stop: [{ hooks: [command("stop"), { ...command("wait-steer"), asyncRewake: true, timeout: WAITER_TIMEOUT_S }] }],
      StopFailure: [{ hooks: [command("stop-failure")] }],
      SessionEnd: [{ hooks: [command("session-end")] }],
    },
    ...(access.socket
      ? { sandbox: { network: { allowUnixSockets: [access.socket] }, filesystem: { allowWrite: access.writable, denyWrite: access.readOnly ?? [] } } }
      : {}),
  };
}

function sharedArgs(run: RunContext, config: WorkersConfig, settingsPath: string): string[] {
  const claude = config.claude;
  const args = ["--settings", settingsPath, "--append-system-prompt-file", run.contractFile, "--permission-mode", claude.permission_mode];
  if (claude.model) args.push("--model", claude.model);
  if (claude.effort) args.push("--effort", claude.effort);
  args.push(...claude.extra_args);
  return args;
}

function plan(run: RunContext, config: WorkersConfig, sessionArgs: string[], prompt: string): LaunchPlan {
  const settingsPath = join(run.runDir, "claude-settings.json");
  const env: Record<string, string> = {};
  if (config.claude.config_dir) env.CLAUDE_CONFIG_DIR = config.claude.config_dir;
  return {
    kind: "claude",
    args: [...sessionArgs, ...sharedArgs(run, config, settingsPath), prompt],
    env,
    files: [{ path: settingsPath, content: JSON.stringify(workerSettings(run.flowrynBin, { socket: run.daemonSocket, writable: run.writable, readOnly: run.readOnly }), null, 2) + "\n", mode: 0o600 }],
  };
}

export const RESUME_PROMPT = "Flowryn restarted you after your process stopped. Continue your task from where you left off.";

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  busySource: "hooks",
  interruptVia: "keys",

  launch(run, config) {
    return plan(run, config, ["--session-id", run.sessionId], run.promptLine);
  },

  /** claude --resume <session_id> in the same worktree (design section 5). */
  resume(run, config) {
    return plan(run, config, ["--resume", run.sessionId], RESUME_PROMPT);
  },

  async preTrust(run, config): Promise<Trust> {
    return checkOrRegisterTrust({
      worktree: run.worktree,
      project: run.projectPath,
      storeDir: config.claude.config_dir ?? claudeConfigDir(process.env),
      mode: config.claude.pretrust,
    });
  },

  /** Claude's foreground process reports argv0 `claude` (its process title is its version, M0 h02). */
  matchesProcess(process: PaneProcess, binary: string): boolean {
    const names = new Set(["claude", basename(binary)]);
    return names.has(basename(process.argv0)) || names.has(basename(process.argv[0] ?? ""));
  },

  parseVersion(output: string): string | null {
    return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
  },

  translate(hook: HookName) {
    return HOOK_SIGNALS[hook];
  },
};
