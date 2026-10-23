import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CLAUDE_CREDENTIAL_ENV } from "../../config/accounts.ts";
import type { WorkersConfig } from "../../config/workers.ts";
import type { PaneProcess } from "../../runtime/herdr/runtime.ts";
import { HOOK_SIGNALS, type HarnessAdapter, type HookName, type LaunchPlan, type RunContext, type Trust } from "../types.ts";
import { claudeConfigDir, checkOrRegisterTrust } from "./trust.ts";

/** Claude's Notification types about a claude.ai usage limit ending (Claude Code 2.1.234 and later). */
export const USAGE_NOTIFICATIONS = "quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled";

/** Claude's Notification type when a permission dialog waits for an answer (cutover C2, spike c12). */
export const PROMPT_NOTIFICATIONS = "permission_prompt";

/** The asyncRewake waiter's timeout: 8 h, re-armed by every turn start and Stop (design section 5, M0 c01). */
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
 * off. `deny` is the toolkit's static layer (src/policy/static.ts): Claude
 * permission rules that hold in bypassPermissions, and hide a denied MCP
 * server's tools from the model.
 */
export function workerSettings(
  bin: string,
  access: { socket: string; writable: string[]; readOnly?: string[]; deny?: string[] } = { socket: "", writable: [] },
): Record<string, unknown> {
  const command = (hook: string) => ({ type: "command", command: hookCommand(bin, hook) });
  const waiter = { ...command("wait-steer"), asyncRewake: true, timeout: WAITER_TIMEOUT_S };
  return {
    ...(access.deny && access.deny.length > 0 ? { permissions: { deny: access.deny } } : {}),
    hooks: {
      SessionStart: [{ hooks: [command("worker-start")] }],
      // The waiter is armed at every turn start as well as every Stop: Claude fires no hook on an
      // interrupt (M0 c04), so a turn a waiter woke and Flowryn then interrupted would otherwise
      // leave no waiter to deliver an idle steer. The newest waiter supersedes the older ones, and
      // the daemon fires one only while the worker is idle.
      UserPromptSubmit: [{ hooks: [command("prompt"), waiter] }],
      PreToolUse: [{ matcher: "*", hooks: [command("pre-tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [command("post-tool")] }],
      // Claude fires PostToolUseFailure, not PostToolUse, for a tool that failed (a command exiting non-zero): it ends the tool's clock too.
      PostToolUseFailure: [{ matcher: "*", hooks: [command("tool-failed")] }],
      Stop: [{ hooks: [command("stop"), waiter] }],
      StopFailure: [{ hooks: [command("stop-failure")] }],
      SessionEnd: [{ hooks: [command("session-end")] }],
      // Claude continued after a usage limit reset: Flowryn's pause on Claude work lifts (design section 16).
      // permission_prompt: a confirmation dialog is waiting mid-run (cutover C2, spike c12).
      Notification: [{ matcher: `${USAGE_NOTIFICATIONS}|${PROMPT_NOTIFICATIONS}`, hooks: [command("notify")] }],
    },
    ...(access.socket
      ? { sandbox: { network: { allowUnixSockets: [access.socket] }, filesystem: { allowWrite: access.writable, denyWrite: access.readOnly ?? [] } } }
      : {}),
  };
}

function sharedArgs(run: RunContext, config: WorkersConfig, settingsPath: string): string[] {
  const claude = config.claude;
  const args = ["--settings", settingsPath, "--append-system-prompt-file", run.contractFile, "--permission-mode", claude.permission_mode];
  if (run.stagePlugin) args.push("--plugin-dir", run.stagePlugin);
  if (claude.model) args.push("--model", claude.model);
  if (claude.effort) args.push("--effort", claude.effort);
  args.push(...claude.extra_args);
  return args;
}

/**
 * The login's environment. A pinned login unsets the credentials Claude ranks
 * above it, and Claude's default login unsets CLAUDE_CONFIG_DIR: an empty
 * value is not unset to Claude (2.1.x reads it as a relative config
 * directory), and a pane can only be given values, so the worker pane shell
 * unsets the names in FLOWRYN_UNSET before Claude is typed (src/lifecycle/pane-shell.ts).
 */
export function loginEnv(claude: WorkersConfig["claude"]): Record<string, string> {
  const env: Record<string, string> = {};
  if (claude.config_dir) env.CLAUDE_CONFIG_DIR = claude.config_dir;
  if (claude.pin_login) env.FLOWRYN_UNSET = [...CLAUDE_CREDENTIAL_ENV, ...(claude.config_dir ? [] : ["CLAUDE_CONFIG_DIR"])].join(" ");
  return env;
}

function plan(run: RunContext, config: WorkersConfig, sessionArgs: string[], prompt: string): LaunchPlan {
  const settingsPath = join(run.runDir, "claude-settings.json");
  const env = loginEnv(config.claude);
  return {
    kind: "claude",
    args: [...sessionArgs, ...sharedArgs(run, config, settingsPath), prompt],
    env,
    files: [{ path: settingsPath, content: JSON.stringify(workerSettings(run.flowrynBin, { socket: run.daemonSocket, writable: run.writable, readOnly: run.readOnly, deny: run.permissionsDeny }), null, 2) + "\n", mode: 0o600 }],
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
    return plan(run, config, ["--resume", run.sessionId], run.resumePrompt ?? RESUME_PROMPT);
  },

  async preTrust(run, config): Promise<Trust> {
    return checkOrRegisterTrust({
      worktree: run.worktree,
      project: run.projectPath,
      // A pinned default login has CLAUDE_CONFIG_DIR unset, so Claude reads ~/.claude.json whatever the daemon's own environment says.
      storeDir: config.claude.config_dir ?? (config.claude.pin_login ? homedir() : claudeConfigDir(process.env)),
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
