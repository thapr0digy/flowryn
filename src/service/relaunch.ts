import { type LaunchdDeps, launchdDomain, loadAgent } from "./launchd.ts";
import { RECOVERY_COMMAND, failureLine, type RestartFailure } from "./restart-failure.ts";

/**
 * The launchd restart's helper (`flowryn daemon relaunch`, spawned detached by
 * the old daemon, so it outlives it). Plain code, no model: it re-bootstraps
 * the agent (bootout stops the old daemon with SIGTERM, a clean shutdown;
 * bootstrap loads the plist afresh), then waits for a new daemon to answer.
 *
 * Why not `kickstart -k`: on 2026-10-23 a kickstart onto a freshly built
 * binary left the agent at "spawn scheduled", last exit 78 (EX_CONFIG), with
 * launchd's "needs LWCR update" property, until a bootout and bootstrap
 * (`flowryn daemon install`) loaded it again. A bootstrap is what install
 * does, so it is what a restart does.
 *
 * When no new daemon answers within the bound, it tries once more (bootstrap
 * again when the agent is not loaded, else a plain kickstart), and when that
 * fails too it leaves a failure record (restart-failed.json in the state
 * directory: the CLI shows it while the daemon is down, and the next daemon
 * turns it into a P1) and a macOS notification, each naming what to run.
 */

/** Long enough for the old daemon's shutdown (its 12 s grace, its owned processes' 2 s) and launchd's own 20 s exit timeout. */
export const RELAUNCH_UNLOAD_TIMEOUT_MS = 45_000;
/** How long each attempt waits for a new daemon to answer: startup runs migrations and the reconciler's first pass. */
export const RELAUNCH_ANSWER_MS = 30_000;
export const RELAUNCH_POLL_MS = 250;
/** The waits between bootstrap attempts while launchd finishes the bootout. */
export const RELAUNCH_BOOTSTRAP_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000];
/**
 * The longest the helper runs before it leaves its failure record: the unload
 * wait, both answer waits, two bootstraps' backoffs, and a margin for its
 * launchctl calls (each bounded at 10 s).
 */
export const RELAUNCH_BOUND_MS = RELAUNCH_UNLOAD_TIMEOUT_MS + 2 * RELAUNCH_ANSWER_MS + 2 * RELAUNCH_BOOTSTRAP_BACKOFF_MS.reduce((a, b) => a + b, 0) + 30_000;

export interface RelaunchPlan {
  label: string;
  plist: string;
  /** The daemon that asked: a new daemon is one that answers with another pid. */
  oldPid: number;
}

export interface RelaunchDeps {
  launchd: LaunchdDeps;
  /** The pid of the daemon answering on the socket now, or null when none answers. */
  probe(): Promise<number | null>;
  now(): number;
  log(line: string): void;
  notify(title: string, body: string): Promise<void>;
  recordFailure(failure: RestartFailure): void;
  clearFailure(): void;
  answerWaitMs: number;
  pollMs: number;
}

export type RelaunchOutcome =
  | { ok: true; pid: number; via: "bootstrap" | "fallback"; steps: string[] }
  /** oldStillUp: the old daemon still answers, so nothing went down; the old daemon takes its handoff back. */
  | { ok: false; oldStillUp: boolean; steps: string[]; reason: string };

async function waitForNew(plan: RelaunchPlan, deps: RelaunchDeps): Promise<number | null> {
  const deadline = deps.now() + deps.answerWaitMs;
  for (;;) {
    const pid = await deps.probe();
    if (pid !== null && pid !== plan.oldPid) return pid;
    if (deps.now() >= deadline) return null;
    await deps.launchd.sleep(deps.pollMs);
  }
}

/** The state lines of `launchctl print` for the agent, on one line ("not loaded" when it is not). */
export async function launchdState(label: string, deps: LaunchdDeps): Promise<{ loaded: boolean; summary: string }> {
  const printed = await deps.launchctl(["print", `${launchdDomain()}/${label}`]);
  if (printed.exitCode !== 0) return { loaded: false, summary: "not loaded" };
  const wanted = /^\t(state|pid|runs|last exit code|properties) = (.*)$/;
  const lines = printed.output
    .split("\n")
    .map((line) => wanted.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]} = ${m[2]!.trim()}`);
  return { loaded: true, summary: lines.join(", ") || "loaded" };
}

async function bootstrap(plan: RelaunchPlan, deps: RelaunchDeps, steps: string[], what: string): Promise<void> {
  try {
    await loadAgent(plan.label, plan.plist, deps.launchd);
    steps.push(`${what}: loaded`);
  } catch (error) {
    steps.push(`${what}: ${(error as Error).message}`);
  }
  deps.log(`relaunch: ${steps.at(-1)}`);
}

/** Bring the new daemon up under launchd; never throws. */
export async function relaunch(plan: RelaunchPlan, deps: RelaunchDeps): Promise<RelaunchOutcome> {
  const steps: string[] = [];
  deps.log(`relaunch: re-bootstrapping ${plan.label} (old daemon pid ${plan.oldPid})`);
  await bootstrap(plan, deps, steps, "bootout and bootstrap");
  let pid = await waitForNew(plan, deps);
  if (pid !== null) {
    deps.log(`relaunch: the new daemon answers (pid ${pid})`);
    return { ok: true, pid, via: "bootstrap", steps };
  }
  steps.push(`no new daemon answered within ${deps.answerWaitMs / 1000} s`);
  if ((await deps.probe()) === plan.oldPid) {
    const reason = `the old daemon (pid ${plan.oldPid}) still answers: ${steps.join("; ")}`;
    deps.log(`relaunch: ${reason}`);
    return { ok: false, oldStillUp: true, steps, reason };
  }

  // The fallback: load the agent again if it is gone, else ask launchd to start it.
  const before = await launchdState(plan.label, deps.launchd);
  if (!before.loaded) await bootstrap(plan, deps, steps, "fallback bootstrap");
  else {
    const kicked = await deps.launchd.launchctl(["kickstart", `${launchdDomain()}/${plan.label}`]);
    steps.push(`fallback kickstart (${before.summary}): ${kicked.exitCode === 0 ? "asked" : `exit ${kicked.exitCode}: ${kicked.output || "no output"}`}`);
    deps.log(`relaunch: ${steps.at(-1)}`);
  }
  pid = await waitForNew(plan, deps);
  if (pid !== null) {
    deps.log(`relaunch: the new daemon answers after the fallback (pid ${pid})`);
    return { ok: true, pid, via: "fallback", steps };
  }
  steps.push(`still no daemon after the fallback (${deps.answerWaitMs / 1000} s)`);

  const after = await launchdState(plan.label, deps.launchd);
  const failure: RestartFailure = { at: deps.now(), label: plan.label, old_pid: plan.oldPid, steps, launchd: after.summary, run: RECOVERY_COMMAND };
  const reason = failureLine(failure);
  deps.log(`relaunch: ${reason}`);
  try {
    deps.recordFailure(failure);
  } catch (error) {
    deps.log(`relaunch: could not write the failure record: ${(error as Error).message}`);
  }
  const late = await deps.probe();
  if (late !== null && late !== plan.oldPid) {
    deps.clearFailure();
    steps.push(`a new daemon answered after the failure record was written (pid ${late})`);
    deps.log(`relaunch: ${steps.at(-1)}; record removed`);
    return { ok: true, pid: late, via: "fallback", steps };
  }
  try {
    await deps.notify("Flowryn daemon is down", `A restart did not bring it back. Run ${RECOVERY_COMMAND} in your terminal.`);
  } catch (error) {
    deps.log(`relaunch: could not notify: ${(error as Error).message}`);
  }
  return { ok: false, oldStillUp: false, steps, reason };
}
