/**
 * The Claude leader bridge (design sections 5, 7 and 12): a hook set in a
 * leader-only settings file that `flowryn lead` passes with --settings, which
 * scopes it to that one session and merges it with your own hooks (M0 c11).
 * Your global settings are never edited. Every hook calls a `flowryn hook`
 * verb; the bridge itself decides nothing.
 */

/** The asyncRewake waiter's timeout: 8 h, re-armed by every Stop (design section 5, M0 c01). */
export const LEADER_WAITER_TIMEOUT_S = 28_800;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Permission rules (design section 12): the leader may run flowryn, merges and
 * gate passes and discards ask you (a content-matching ask rule still prompts
 * in auto mode, M0 c08), and it can never run approve or a hook verb itself.
 * Deny beats ask beats allow.
 */
export const LEADER_PERMISSIONS = {
  allow: ["Bash(flowryn *)"],
  ask: ["Bash(flowryn merge *)", "Bash(flowryn gate pass *)", "Bash(flowryn cleanup * --discard*)"],
  deny: ["Bash(flowryn approve*)", "Bash(flowryn hook *)"],
} as const;

export interface LeaderSettingsInput {
  /** Absolute path of the flowryn command the hooks run. */
  bin: string;
  /** The daemon socket: a sandboxed Bash tool must be allowed to reach it (found live in M2). */
  socket: string;
}

export function leaderSettings(input: LeaderSettingsInput): Record<string, unknown> {
  const command = (hook: string) => ({ type: "command", command: `${shellQuote(input.bin)} hook ${hook} --harness claude` });
  const waiter = { ...command("wait-p0"), asyncRewake: true, timeout: LEADER_WAITER_TIMEOUT_S };
  return {
    permissions: {
      allow: [...LEADER_PERMISSIONS.allow],
      ask: [...LEADER_PERMISSIONS.ask],
      deny: [...LEADER_PERMISSIONS.deny],
    },
    hooks: {
      // Arming the waiter at SessionStart also wakes a fresh idle session (M0 c01).
      SessionStart: [{ hooks: [command("session-start"), waiter] }],
      UserPromptSubmit: [{ hooks: [command("prompt")] }],
      PreToolUse: [{ matcher: "*", hooks: [command("pre-tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [command("post-tool")] }],
      Stop: [{ hooks: [command("stop"), waiter] }],
      StopFailure: [{ hooks: [command("stop-failure")] }],
      SessionEnd: [{ hooks: [command("session-end")] }],
      Notification: [{ matcher: "idle_prompt", hooks: [command("notify")] }],
    },
    sandbox: { network: { allowUnixSockets: [input.socket] } },
  };
}
