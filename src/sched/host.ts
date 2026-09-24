import { availableParallelism, freemem, loadavg } from "node:os";
import type { HostCheckConfig } from "../config/workflows.ts";

/**
 * The host check (design section 11): before any new grant, the host must
 * have at least min_free_mem_gb available and a 1-minute load average per
 * core of at most max_load_per_core. When it fails, no new slot is granted and
 * running work continues (section 16).
 *
 * macOS keeps most free memory as inactive (file cache it drops on demand),
 * so "available" is free + inactive + speculative pages from vm_stat, not
 * os.freemem(), which counts only the free pages and reads a few hundred MB
 * on a healthy machine.
 */

export interface HostSample {
  free_mem_gb: number;
  load_per_core: number;
  source: "probe" | "vm_stat" | "freemem";
}

export interface HostVerdict {
  ok: boolean;
  sample: HostSample | null;
  /** Why no grant is possible, or "ok". */
  reason: string;
}

const PROBE_TIMEOUT_MS = 5_000;
const GB = 1024 ** 3;

/** Available memory from vm_stat's page counts (free + inactive + speculative), in GB. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text)?.[1] ?? 0);
  const available = pages("free") + pages("inactive") + pages("speculative");
  return available > 0 ? (available * pageSize) / GB : null;
}

async function run(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

/** One sample of the host: the configured probe command, else vm_stat and the load average. */
export async function sampleHost(probe: string | null): Promise<HostSample> {
  if (probe) {
    const out = await run([probe]);
    if (out === null) throw new Error(`the host probe ${probe} failed`);
    let parsed: { free_mem_gb?: unknown; load_per_core?: unknown };
    try {
      parsed = JSON.parse(out) as typeof parsed;
    } catch {
      throw new Error(`the host probe ${probe} did not print JSON`);
    }
    if (typeof parsed.free_mem_gb !== "number" || typeof parsed.load_per_core !== "number") throw new Error(`the host probe ${probe} must print {"free_mem_gb": n, "load_per_core": n}`);
    return { free_mem_gb: parsed.free_mem_gb, load_per_core: parsed.load_per_core, source: "probe" };
  }
  const cores = Math.max(1, availableParallelism());
  const load = loadavg()[0]! / cores;
  const vmStat = process.platform === "darwin" ? await run(["/usr/bin/vm_stat"]) : null;
  const fromVm = vmStat ? parseVmStat(vmStat) : null;
  if (fromVm !== null) return { free_mem_gb: fromVm, load_per_core: load, source: "vm_stat" };
  return { free_mem_gb: freemem() / GB, load_per_core: load, source: "freemem" };
}

export function judgeHost(sample: HostSample, cfg: HostCheckConfig): HostVerdict {
  const problems: string[] = [];
  if (sample.free_mem_gb < cfg.min_free_mem_gb) problems.push(`${sample.free_mem_gb.toFixed(1)} GB available, under ${cfg.min_free_mem_gb} GB`);
  if (sample.load_per_core > cfg.max_load_per_core) problems.push(`load ${sample.load_per_core.toFixed(2)} per core, over ${cfg.max_load_per_core}`);
  return { ok: problems.length === 0, sample, reason: problems.length === 0 ? "ok" : problems.join("; ") };
}

/** Sample and judge; a probe that fails refuses grants, since the host cannot be shown to have room. */
export async function checkHost(cfg: HostCheckConfig): Promise<HostVerdict> {
  try {
    return judgeHost(await sampleHost(cfg.probe), cfg);
  } catch (error) {
    return { ok: false, sample: null, reason: (error as Error).message };
  }
}
