import { existsSync } from "node:fs";
import type { GitResult, GitRunner } from "./landed.ts";

/**
 * A git runner for the cleanup guard and the merge: the configured git, a
 * timeout, no terminal prompts, and a missing working directory reported as a
 * failed call rather than thrown (a worktree may already be gone).
 */
export function gitRunner(gitPath: string, timeoutMs = 60_000, env: Record<string, string> = {}): GitRunner {
  return async (args: string[], cwd: string, input?: string): Promise<GitResult> => {
    if (!existsSync(cwd)) return { code: 128, stdout: "", stderr: `no such directory: ${cwd}` };
    let proc;
    try {
      proc = Bun.spawn([gitPath, ...args], {
        cwd,
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      });
    } catch (error) {
      return { code: 127, stdout: "", stderr: (error as Error).message };
    }
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
}
