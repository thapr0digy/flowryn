/** Environment variables that mark an agent pane: a worker run or a leader session. */
export const IDENTITY_VARS = ["FLOWRYN_TOKEN", "FLOWRYN_RUN"] as const;

export interface TerminalFacts {
  env: NodeJS.ProcessEnv;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

/** Why this process is not your own terminal, or null when it is. */
export function notHumanReason(facts: TerminalFacts): string | null {
  const identity = IDENTITY_VARS.find((name) => (facts.env[name] ?? "").length > 0);
  if (identity) return `${identity} is set, so this is an agent pane`;
  if (!facts.stdinIsTty && !facts.stdoutIsTty) return "neither stdin nor stdout is a terminal";
  return null;
}

/** Agent-pane check for human-only local verbs that may run without a TTY (launchd runs `daemon run`). */
export function agentIdentity(env: NodeJS.ProcessEnv): string | null {
  return IDENTITY_VARS.find((name) => (env[name] ?? "").length > 0) ?? null;
}
