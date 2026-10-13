import { existsSync } from "node:fs";
import { runBounded } from "../runtime/bounded.ts";
import type { GitResult, GitRunner } from "./landed.ts";

const OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** `git <subcommand>` for logs and the ownership ledger, past git's global options and their values. */
export function gitLabel(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (OPTIONS_WITH_VALUE.has(arg)) i++;
    else if (!arg.startsWith("-")) return `git ${arg}`;
  }
  return "git";
}

/**
 * A git runner for the cleanup guard and the merge: the configured git, a
 * timeout (`runBounded`: git and its remote helper are stopped together, SIGTERM
 * first so git removes its own locks and half-made worktree), no terminal
 * prompts, and a missing working directory reported as a failed call rather
 * than thrown (a worktree may already be gone).
 */
export function gitRunner(gitPath: string, timeoutMs = 60_000, env: Record<string, string> = {}): GitRunner {
  return async (args: string[], cwd: string, input?: string): Promise<GitResult> => {
    if (!existsSync(cwd)) return { code: 128, stdout: "", stderr: `no such directory: ${cwd}` };
    const result = await runBounded([gitPath, ...args], { label: gitLabel(args), cwd, stdin: input, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}
