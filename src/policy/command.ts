import { existsSync } from "node:fs";
import { basename } from "node:path";
import { runBounded } from "../runtime/bounded.ts";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command with a timeout (`runBounded`: its process group is stopped at the deadline, and a cut-off or
 * incomplete read is a non-zero code); a missing binary or directory is a failed result, never a throw.
 */
export async function runCommand(argv: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<CommandResult> {
  if (options.cwd && !existsSync(options.cwd)) return { code: 128, stdout: "", stderr: `no such directory: ${options.cwd}` };
  const result = await runBounded(argv, { label: basename(argv[0] ?? "command"), cwd: options.cwd, timeoutMs: options.timeoutMs ?? 10_000, env: { ...process.env, ...options.env } });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}
