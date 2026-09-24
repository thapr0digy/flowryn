import { existsSync } from "node:fs";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one command with a timeout; a missing binary or directory is a failed result, never a throw. */
export async function runCommand(argv: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<CommandResult> {
  if (options.cwd && !existsSync(options.cwd)) return { code: 128, stdout: "", stderr: `no such directory: ${options.cwd}` };
  let proc;
  try {
    proc = Bun.spawn(argv, { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env } });
  } catch (error) {
    return { code: 127, stdout: "", stderr: (error as Error).message };
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs ?? 10_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}
