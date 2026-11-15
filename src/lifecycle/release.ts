import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "../config/config.ts";
import { runBounded, TIMED_OUT } from "../runtime/bounded.ts";

/**
 * `[projects.<id>] release` (docs/notes/2026-11-15-pool-worktrees-release-fc.md): the commands
 * that free a worktree's own services (a per-worktree test database, say) before the worktree
 * goes back to the pool or is removed. The cleanup runs them after the worker has stopped and
 * before the reap (src/policy/cleanup.ts); a verification runs them before its worktree goes
 * (src/verify/runner.ts). Each runs as argv, no shell, with its own deadline; a failure is
 * recorded and never stops the cleanup.
 */

export const RELEASE_TIMEOUT_MS = 60_000;
/** Lines of a command's output kept in its result, and their cap in bytes. */
const TAIL_LINES = 20;
const TAIL_BYTES = 4_096;
/** What a shell would read differently from a split on whitespace: such a command belongs in a script. */
const SHELL_CHARS = /["'`$|&;<>()*\\]/;

export interface ReleaseResult {
  command: string;
  code: number;
  ok: boolean;
  timedOut: boolean;
  /** The last lines of its output (stdout then stderr), capped. */
  tail: string;
}

/** One `release` value checked into argv lists; throws config_invalid naming the entry at fault. */
export function parseRelease(value: unknown, where: string): string[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FlowrynError("config_invalid", `${where} release must be a list of commands, such as ["make pg-test-down"]`);
  return value.map((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") throw new FlowrynError("config_invalid", `${where} release entry ${i + 1} must be a non-empty command`);
    if (SHELL_CHARS.test(entry)) {
      throw new FlowrynError("config_invalid", `${where} release entry ${i + 1} (${entry}) has a shell character; release commands run without a shell: put it in a script and name the script`);
    }
    return entry.trim().split(/\s+/);
  });
}

/** The project's release commands as argv lists; none without the key. Throws config_invalid on a malformed value. */
export function releaseCommands(config: FlowrynConfig, projectId: string): string[][] {
  const where = `[projects.${projectId}]`;
  const projects = table(config.extra.projects, "[projects]");
  return parseRelease(table(projects[projectId], where).release, where);
}

/**
 * The commands a cleanup or a verification runs: a malformed value is logged and runs nothing,
 * since a release never stops a worktree from going. Without a config (tests), none.
 */
export function projectRelease(config: FlowrynConfig | null, projectId: string, log: (line: string) => void): string[][] {
  if (!config) return [];
  try {
    return releaseCommands(config, projectId);
  } catch (error) {
    log(`release skipped: ${(error as Error).message}`);
    return [];
  }
}

function tailOf(stdout: string, stderr: string): string {
  const lines = [stdout, stderr].map((s) => s.trimEnd()).filter((s) => s.length > 0).join("\n").split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_BYTES ? tail.slice(-TAIL_BYTES) : tail;
}

export interface ReleaseOptions {
  cwd: string;
  env: Record<string, string>;
  /** "cleanup <task>" or "verify <id>": the label of each call and the prefix of its log lines. */
  label: string;
  log(line: string): void;
  timeoutMs?: number;
}

/** Run every command in order in the worktree, each to its end or its deadline; one that fails never stops the next. Never throws. */
export async function runRelease(commands: string[][], opts: ReleaseOptions): Promise<ReleaseResult[]> {
  const results: ReleaseResult[] = [];
  for (const argv of commands) {
    const command = argv.join(" ");
    const ran = await runBounded(argv, { label: `${opts.label} release`, timeoutMs: opts.timeoutMs ?? RELEASE_TIMEOUT_MS, cwd: opts.cwd, env: opts.env });
    const result: ReleaseResult = { command, code: ran.code, ok: ran.code === 0, timedOut: ran.timedOut || ran.code === TIMED_OUT, tail: tailOf(ran.stdout, ran.stderr) };
    results.push(result);
    if (result.ok) opts.log(`${opts.label}: release ${command} done`);
    else opts.log(`${opts.label}: release ${command} failed (${result.timedOut ? "deadline" : `code ${result.code}`})${result.tail ? `: ${result.tail.split("\n").at(-1)}` : ""}`);
  }
  return results;
}

/** The results a release_failed event carries: the failed commands only. */
export function failedReleases(results: ReleaseResult[]): ReleaseResult[] {
  return results.filter((r) => !r.ok);
}
