import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { PsUnavailable, readIdentity, type PsRunner } from "../runtime/proc.ts";
import { runCommand } from "./command.ts";

/**
 * Reap leaked processes before a worktree goes (design section 14, cleanup
 * order: "reap leaked processes by identity, never a reused pid"). A leaked
 * process is any process whose current working directory is inside the
 * worktree, found with one bounded system-wide `lsof -a -d cwd` scan. Each is
 * identified by its start time (a birth identity: an exec keeps it), sent
 * SIGTERM, given a grace period, and sent SIGKILL only while it is still the
 * same process. A scan that fails refuses the cleanup before anything is
 * removed; processes that survive every pass refuse it too. Ported from
 * the previous orchestrator's reap_task_worktree_processes (bin/fm-teardown.sh, a09090d1).
 */

export interface ReapOptions {
  lsof: string | null;
  ps: PsRunner;
  graceMs: number;
  passes: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  log(line: string): void;
}

export type ReapResult = { ok: true; reaped: number[]; skipped?: string } | { ok: false; reason: "lsof_failed" | "identity_unverified" | "survivors"; detail: string; reaped: number[] };

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Pids whose cwd is inside one of the roots; null when the scan cannot be trusted. */
export async function pidsUnder(lsof: string, roots: string[]): Promise<number[] | null> {
  const dirs = roots.map(real);
  const result = await runCommand([lsof, "-a", "-d", "cwd", "-Fpn"], { timeoutMs: 30_000 });
  if (result.code !== 0) return null;
  const found = new Set<number>();
  let pid: number | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      if (!/^\d+$/.test(value)) return null;
      pid = Number(value);
    } else if (tag === "f") {
      if (pid === null) return null;
    } else if (tag === "n") {
      if (pid === null) return null;
      if (pid !== process.pid && dirs.some((d) => under(value, d))) found.add(pid);
    } else return null;
  }
  return [...found].toSorted((a, b) => a - b);
}

async function startOf(ps: PsRunner, pid: number): Promise<number | null> {
  return (await readIdentity(pid, ps))?.start ?? null;
}

function send(kill: ReapOptions["kill"], pid: number, signal: NodeJS.Signals): void {
  try {
    (kill ?? ((p, s) => process.kill(p, s)))(pid, signal);
  } catch {
    // raced with its exit
  }
}

/** Reap leaked processes under the roots. A ps that cannot answer leaves their identity unverified: nothing more is signalled. */
export async function reapUnder(roots: string[], opts: ReapOptions): Promise<ReapResult> {
  const reaped: number[] = [];
  try {
    return await reapPasses(roots, opts, reaped);
  } catch (error) {
    if (!(error instanceof PsUnavailable)) throw error;
    return { ok: false, reason: "identity_unverified", detail: `cannot verify leaked processes' identity under ${roots.join(", ")} (${error.message})`, reaped };
  }
}

async function reapPasses(roots: string[], opts: ReapOptions, reaped: number[]): Promise<ReapResult> {
  if (!opts.lsof) {
    opts.log("lsof is missing: cannot look for leaked processes; the worker's own process group was already stopped");
    return { ok: true, reaped, skipped: "lsof missing" };
  }
  const lsof = opts.lsof;
  const scanFailed = (): ReapResult => ({ ok: false, reason: "lsof_failed", detail: `cannot determine leaked processes under ${roots.join(", ")} (lsof failed)`, reaped });
  for (let pass = 1; pass <= opts.passes; pass++) {
    const pids = await pidsUnder(lsof, roots);
    if (pids === null) return scanFailed();
    if (pids.length === 0) return { ok: true, reaped };
    const tracked: { pid: number; start: number }[] = [];
    for (const pid of pids) {
      const start = await startOf(opts.ps, pid);
      if (start !== null) {
        tracked.push({ pid, start });
        continue;
      }
      // Gone between the scan and the lookup, or unreadable: only a pid still listed is a problem.
      const again = await pidsUnder(lsof, roots);
      if (again === null) return scanFailed();
      if (again.includes(pid)) return { ok: false, reason: "identity_unverified", detail: `cannot verify leaked process ${pid}'s identity`, reaped };
    }
    if (tracked.length === 0) continue;
    const same = async (t: { pid: number; start: number }, listed: number[]) => listed.includes(t.pid) && (await startOf(opts.ps, t.pid)) === t.start;
    let current = await pidsUnder(lsof, roots);
    if (current === null) return scanFailed();
    opts.log(`reaping leaked process(es): ${tracked.map((t) => t.pid).join(" ")}`);
    for (const t of tracked) {
      if (await same(t, current)) {
        send(opts.kill, t.pid, "SIGTERM");
        reaped.push(t.pid);
      }
    }
    await Bun.sleep(opts.graceMs);
    current = await pidsUnder(lsof, roots);
    if (current === null) return scanFailed();
    const remaining: typeof tracked = [];
    for (const t of tracked) if (await same(t, current)) remaining.push(t);
    if (remaining.length > 0) {
      current = await pidsUnder(lsof, roots);
      if (current === null) return scanFailed();
      opts.log(`force-killing leaked process(es): ${remaining.map((t) => t.pid).join(" ")}`);
      for (const t of remaining) if (await same(t, current)) send(opts.kill, t.pid, "SIGKILL");
    }
  }
  const left = await pidsUnder(lsof, roots);
  if (left === null) return scanFailed();
  if (left.length === 0) return { ok: true, reaped };
  return { ok: false, reason: "survivors", detail: `leaked processes ${left.join(" ")} remain after ${opts.passes} reap attempts`, reaped };
}
