import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMING, type Timing } from "../config/workers.ts";
import { adapterFor } from "../harness/registry.ts";
import type { HarnessId, Verified } from "../harness/types.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { INCOMPLETE, runBounded, SPAWN_FAILED, TIMED_OUT } from "../runtime/bounded.ts";
import { selfCommand } from "../service/launchd.ts";
import { pinnedLink, unpinForScript } from "../daemon/caller-binary.ts";
import { ensureDir } from "../util/fsx.ts";
import { SteerBus } from "./steers.ts";
import { inertUrgent, type UrgentServices } from "./urgent.ts";
import type { CancelOutcome } from "./operation-recovery.ts";

/**
 * What the M2 verbs need from the running daemon beyond the database: the
 * Herdr runtime, the steer bus, the launcher and the reconciler. Handlers get
 * it as `ctx.fleet`; tests without Herdr use `inertFleet()`.
 */
export interface FleetServices {
  runtime(): HerdrRuntime | null;
  bus: SteerBus;
  timing(): Timing;
  /** Start or resume a run in the background, for the named requested operation (src/lifecycle/operations.ts). */
  launch(runId: string, mode: "fresh" | "resume", operation?: string): void;
  isLaunching(runId: string): boolean;
  flowrynBin(): Promise<string>;
  harnessVersion(harness: HarnessId, binary: string): Promise<string | null>;
  exitRun(runId: string): Promise<Verified>;
  /** Drive a cancel operation to its end: one attempt shared by every caller (src/lifecycle/operation-recovery.ts). */
  driveCancel(operation: string): Promise<CancelOutcome>;
  interruptRun(runId: string, waitMs?: number): Promise<Verified>;
  /** Ask the reconciler to look at one run, or at every run, soon. */
  reconcile(runId?: string): void;
  /** Whether an outcome-less turn end gets the turn-end guard's reminder ([workers] turn_end_guard). */
  turnEndGuard(): boolean;
  /** Consecutive Stop continuations per run (design section 5: at most two). */
  continuations: Map<string, number>;
  /** Urgent steers: the main agent's running tools, and the timer that cuts a long one. */
  urgent: UrgentServices;
}

/** A fleet with no Herdr: verbs that only touch the database still work. */
export function inertFleet(overrides: Partial<FleetServices> = {}): FleetServices {
  return {
    runtime: () => null,
    bus: new SteerBus(),
    timing: () => DEFAULT_TIMING,
    launch: () => {},
    isLaunching: () => false,
    flowrynBin: async () => "/usr/bin/false",
    harnessVersion: async () => null,
    exitRun: async () => ({ ok: false, evidence: "timeout", detail: "no runtime" }),
    driveCancel: async () => ({ ok: false, phase: "failed", evidence: "timeout", detail: "no runtime" }),
    interruptRun: async () => ({ ok: false, evidence: "timeout", detail: "no runtime" }),
    reconcile: () => {},
    turnEndGuard: () => true,
    continuations: new Map(),
    urgent: inertUrgent(),
    ...overrides,
  };
}

/**
 * The absolute flowryn command a worker calls (FLOWRYN_BIN). A compiled
 * daemon's callers run the copy of its own build it pinned at startup
 * (src/daemon/caller-binary.ts), falling back to the binary itself; a
 * development checkout run under bun gets a small wrapper script, because
 * workers need one executable path.
 */
export function workerBinary(stateDir: string, command: string[] = selfCommand()): string {
  if (command.length === 1) return pinnedLink(stateDir) ?? command[0]!;
  const dir = join(stateDir, "bin");
  ensureDir(dir, 0o700);
  unpinForScript(stateDir);
  const path = join(dir, "flowryn");
  const script = `#!/bin/sh\nexec ${command.map((c) => JSON.stringify(c)).join(" ")} "$@"\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== script) writeFileSync(path, script, { mode: 0o700 });
  return path;
}

/** Parsed versions only, by binary until its mtime changes: a failed, cut-off or unparsed probe is never cached, so the next dispatch asks again. */
const versionCache = new Map<string, { mtime: number; version: string }>();
const VERSION_PROBE_MS = 10_000;

/** `<binary> --version`, parsed by the harness adapter; a parsed version is cached until the binary changes. */
export async function harnessVersion(harness: HarnessId, binary: string): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = statSync(binary).mtimeMs;
  } catch {
    return null;
  }
  const cached = versionCache.get(binary);
  if (cached && cached.mtime === mtime) return cached.version;
  const probe = await runBounded([binary, "--version"], { label: `${harness} --version`, timeoutMs: VERSION_PROBE_MS });
  if (probe.code === TIMED_OUT || probe.code === INCOMPLETE || probe.code === SPAWN_FAILED) return null;
  const version = adapterFor(harness).parseVersion(`${probe.stdout}\n${probe.stderr}`);
  if (version !== null) versionCache.set(binary, { mtime, version });
  return version;
}
