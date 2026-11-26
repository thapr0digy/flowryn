import { availableParallelism, freemem, loadavg } from "node:os";
import type { HostCheckConfig } from "../config/workflows.ts";
import { runBounded } from "../runtime/bounded.ts";

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
 *
 * With `pressure` on (the default) it also holds on two readings the free
 * memory figure hides (docs/notes/2026-11-25-host-capacity-check-gs.md):
 * macOS's system-wide memory free level (`sysctl kern.memorystatus_level`,
 * what `memory_pressure` prints) and a CPU-starved Docker VM
 * (`colima ssh -- cat /proc/pressure/cpu`, "some" avg60). Swap used/total is
 * not read: macOS grows swap on demand and keeps it, so it reads nearly full
 * long after the pressure that grew it has gone. Both limits are
 * fixed and release only once the reading is back past a second level, so a reading at the
 * line keeps the last state instead of flipping. A reading that fails or is
 * absent holds nothing: it is named in the verdict's notes.
 */

export type HostHold = "memory" | "load" | "mem_free" | "vm_cpu" | "probe";

/** The Docker VM's CPU pressure ("some" avg60, percent), when it was read and, with no value, why. */
export interface VmCpuReading {
  some_avg60: number | null;
  at: number;
  note: string | null;
}

export interface HostSample {
  free_mem_gb: number;
  load_per_core: number;
  source: "probe" | "vm_stat" | "freemem";
  /** macOS's system-wide memory free percentage; null when not read (pressure off, a probe without it, not macOS) or the read failed. */
  mem_free_pct: number | null;
  /** Null when not read (pressure off, a probe without it). */
  vm_cpu: VmCpuReading | null;
  /** Readings that failed, and why: each holds nothing. */
  notes: string[];
}

export interface HostVerdict {
  ok: boolean;
  sample: HostSample | null;
  /** Why no grant is possible, or "ok". */
  reason: string;
  /** What holds new starts; the next check reads it for the release levels. */
  holds: HostHold[];
}

/** System-wide memory free under this percentage holds new starts (a healthy fleet reads 40-45%)... */
export const MEM_FREE_HOLD_PCT = 20;
/** ...until it is back over this one. */
export const MEM_FREE_RELEASE_PCT = 25;
/** The Docker VM's CPU pressure ("some" avg60, percent) over this holds new starts (one DB-heavy step alone read 25-28% on 8 vCPUs)... */
export const VM_CPU_HOLD_PCT = 30;
/** ...until it is back under this one. */
export const VM_CPU_RELEASE_PCT = 20;
/** avg60 moves slowly: one VM read serves the checks for this long. */
export const VM_READ_MS = 30_000;

const READ_TIMEOUT_MS = 5_000;
const GB = 1024 ** 3;

/** Available memory from vm_stat's page counts (free + inactive + speculative), in GB. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text)?.[1] ?? 0);
  const available = pages("free") + pages("inactive") + pages("speculative");
  return available > 0 ? (available * pageSize) / GB : null;
}

/** `sysctl -n kern.memorystatus_level`: the system-wide memory free percentage, 0 to 100. */
export function parseMemFreeLevel(text: string): number | null {
  const level = /^\s*(\d+)\s*$/.exec(text)?.[1];
  if (level === undefined) return null;
  const pct = Number(level);
  return pct <= 100 ? pct : null;
}

/** The "some" avg60 of a Linux PSI file (/proc/pressure/cpu), in percent. */
export function parsePressureSome(text: string): number | null {
  const match = /^some\b.*\bavg60=([\d.]+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

interface Read {
  out: string | null;
  failure: string | null;
}

async function read(argv: string[], label: string): Promise<Read> {
  const result = await runBounded(argv, { label, timeoutMs: READ_TIMEOUT_MS });
  if (result.code === 0) return { out: result.stdout, failure: null };
  const detail = result.spawnError ?? (result.timedOut ? `no answer in ${READ_TIMEOUT_MS / 1000} s` : (result.stderr.trim().split("\n").at(-1) ?? "").slice(0, 200));
  return { out: null, failure: `${label} exited ${result.code}${detail ? `: ${detail}` : ""}` };
}

async function readMemFree(): Promise<{ mem_free_pct: number | null; note: string | null }> {
  if (process.platform !== "darwin") return { mem_free_pct: null, note: null };
  const { out, failure } = await read(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level"], "sysctl kern.memorystatus_level");
  if (out === null) return { mem_free_pct: null, note: `memory free level not read (${failure})` };
  const mem_free_pct = parseMemFreeLevel(out);
  return { mem_free_pct, note: mem_free_pct === null ? "memory free level not read (sysctl kern.memorystatus_level printed no percentage)" : null };
}

/** The Docker VM's CPU pressure: `previous` while it is younger than VM_READ_MS, else one `colima ssh` read (none without colima). */
export async function vmCpuReading(colima: string | null, previous: VmCpuReading | null, now: number): Promise<VmCpuReading> {
  if (previous && now - previous.at < VM_READ_MS) return previous;
  if (!colima) return { some_avg60: null, at: now, note: "Docker VM CPU pressure not read (no colima on PATH)" };
  const { out, failure } = await read([colima, "ssh", "--", "cat", "/proc/pressure/cpu"], "colima ssh");
  if (out === null) return { some_avg60: null, at: now, note: `Docker VM CPU pressure not read (${failure})` };
  const some = parsePressureSome(out);
  return { some_avg60: some, at: now, note: some === null ? "Docker VM CPU pressure not read (no \"some\" line in /proc/pressure/cpu)" : null };
}

export interface SampleOptions {
  /** The colima binary; defaults to the one on PATH. */
  colima?: string | null;
  /** The last sample, whose VM reading is reused while it is younger than VM_READ_MS. */
  previous?: HostSample | null;
  now?: number;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function sampleProbe(probe: string, pressure: boolean, now: number): Promise<HostSample> {
  const { out } = await read([probe], "host probe");
  if (out === null) throw new Error(`the host probe ${probe} failed`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(out) as Record<string, unknown>;
  } catch {
    throw new Error(`the host probe ${probe} did not print JSON`);
  }
  if (typeof parsed.free_mem_gb !== "number" || typeof parsed.load_per_core !== "number") throw new Error(`the host probe ${probe} must print {"free_mem_gb": n, "load_per_core": n}`);
  const memFree = optionalNumber(parsed.mem_free_pct);
  const some = optionalNumber(parsed.vm_cpu_some_avg60);
  return {
    free_mem_gb: parsed.free_mem_gb,
    load_per_core: parsed.load_per_core,
    source: "probe",
    mem_free_pct: pressure ? memFree : null,
    vm_cpu: pressure && some !== null ? { some_avg60: some, at: now, note: null } : null,
    notes: [],
  };
}

/** One sample of the host: the configured probe command, else vm_stat, the load average and (with pressure on) the memory free level and the Docker VM. */
export async function sampleHost(cfg: Pick<HostCheckConfig, "probe" | "pressure">, options: SampleOptions = {}): Promise<HostSample> {
  const now = options.now ?? Date.now();
  if (cfg.probe) return sampleProbe(cfg.probe, cfg.pressure, now);
  const cores = Math.max(1, availableParallelism());
  const load = loadavg()[0]! / cores;
  const colima = cfg.pressure && options.colima === undefined ? Bun.which("colima") : (options.colima ?? null);
  const [vmStat, memFree, vm_cpu] = await Promise.all([
    process.platform === "darwin" ? read(["/usr/bin/vm_stat"], "vm_stat") : Promise.resolve({ out: null, failure: null }),
    cfg.pressure ? readMemFree() : Promise.resolve({ mem_free_pct: null, note: null }),
    cfg.pressure ? vmCpuReading(colima, options.previous?.vm_cpu ?? null, now) : Promise.resolve(null),
  ]);
  const fromVm = vmStat.out ? parseVmStat(vmStat.out) : null;
  const notes = [memFree.note, vm_cpu?.note ?? null].filter((note): note is string => note !== null);
  const pressure = { mem_free_pct: memFree.mem_free_pct, vm_cpu, notes };
  if (fromVm !== null) return { free_mem_gb: fromVm, load_per_core: load, source: "vm_stat", ...pressure };
  return { free_mem_gb: freemem() / GB, load_per_core: load, source: "freemem", ...pressure };
}

/** Whether `value` holds: past the hold level on the bad `side`, or not yet back past the release level while it already held. */
function pastLimit(value: number, held: boolean, side: "over" | "under", hold: number, release: number): { holds: boolean; tail: string } {
  const sign = side === "over" ? 1 : -1;
  if (sign * value > sign * hold) return { holds: true, tail: `${side} ${hold}%` };
  if (held && sign * value >= sign * release) return { holds: true, tail: `not yet ${side === "over" ? "under" : "over"} ${release}%` };
  return { holds: false, tail: "" };
}

/** The verdict on `sample`; `previous` (the last verdict) sets the release levels for the memory free level and VM CPU pressure. */
export function judgeHost(sample: HostSample, cfg: HostCheckConfig, previous: HostVerdict | null = null): HostVerdict {
  const held = new Set(previous?.holds ?? []);
  const problems: string[] = [];
  const holds: HostHold[] = [];
  const hold = (what: HostHold, problem: string) => {
    holds.push(what);
    problems.push(problem);
  };
  if (sample.free_mem_gb < cfg.min_free_mem_gb) hold("memory", `${sample.free_mem_gb.toFixed(1)} GB available, under ${cfg.min_free_mem_gb} GB`);
  if (sample.load_per_core > cfg.max_load_per_core) hold("load", `load ${sample.load_per_core.toFixed(2)} per core, over ${cfg.max_load_per_core}`);
  if (cfg.pressure && sample.mem_free_pct !== null) {
    const limit = pastLimit(sample.mem_free_pct, held.has("mem_free"), "under", MEM_FREE_HOLD_PCT, MEM_FREE_RELEASE_PCT);
    if (limit.holds) hold("mem_free", `system-wide memory free ${sample.mem_free_pct}%, ${limit.tail}`);
  }
  const some = sample.vm_cpu?.some_avg60;
  if (cfg.pressure && some != null) {
    const limit = pastLimit(some, held.has("vm_cpu"), "over", VM_CPU_HOLD_PCT, VM_CPU_RELEASE_PCT);
    if (limit.holds) hold("vm_cpu", `Docker VM CPU pressure ${some.toFixed(1)}% (some avg60), ${limit.tail}`);
  }
  return { ok: problems.length === 0, sample, reason: problems.length === 0 ? "ok" : problems.join("; "), holds };
}

/** What the host check needs, for `flowryn capacity`, doctor and the wait reasons. */
export function hostNeeds(cfg: HostCheckConfig): string {
  const base = `${cfg.min_free_mem_gb} GB free, load per core under ${cfg.max_load_per_core}`;
  return cfg.pressure ? `${base}, system-wide memory free over ${MEM_FREE_HOLD_PCT}%, Docker VM CPU pressure under ${VM_CPU_HOLD_PCT}%` : base;
}

/** Sample and judge; a probe that fails refuses grants, since the host cannot be shown to have room. */
export async function checkHost(cfg: HostCheckConfig, previous: HostVerdict | null = null, options: Omit<SampleOptions, "previous"> = {}): Promise<HostVerdict> {
  try {
    return judgeHost(await sampleHost(cfg, { ...options, previous: previous?.sample ?? null }), cfg, previous);
  } catch (error) {
    return { ok: false, sample: null, reason: (error as Error).message, holds: ["probe"] };
  }
}
