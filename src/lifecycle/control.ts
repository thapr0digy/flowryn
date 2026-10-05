import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { adapterFor } from "../harness/registry.ts";
import type { Verified } from "../harness/types.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { isAlive, terminate, type ProcIdentity, type PsRunner } from "../runtime/proc.ts";
import { findOpenRunItem } from "../attention/items.ts";
import { getRun, type RunRow } from "./runs.ts";
import { markLost, type SteerBus } from "./steers.ts";
import { DIALOG_QUESTION } from "./prompt-wedge.ts";

export interface ControlDeps {
  db: Db;
  runtime(): HerdrRuntime | null;
  bus: SteerBus;
  timing(): Timing;
  now(): number;
  ps?: PsRunner;
  /** The gap between the interrupt gate's two Herdr status reads (default SECOND_READ_MS). */
  secondReadMs?: number;
}

/** A dialog that opened a moment before the first status read shows by the second (Herdr's detection lag). */
export const SECOND_READ_MS = 500;
/** Screen lines the gate reads for a dialog's question. */
const GATE_SCREEN_LINES = 20;

export function identityOf(run: RunRow): ProcIdentity | null {
  if (run.proc_pid === null || run.proc_start === null || run.proc_exe === null) return null;
  return { pid: run.proc_pid, start: run.proc_start, exe: run.proc_exe };
}

/**
 * Exit a worker (design section 5): SIGTERM to the harness process identified
 * by pid, start time and executable, SIGKILL after the grace period, verified
 * by the process being gone; never a reused pid. The whole foreground group
 * goes, so the tool it was running goes with it.
 */
export async function exitRun(deps: ControlDeps, runId: string): Promise<Verified> {
  const run = getRun(deps.db, runId);
  if (!run) return { ok: false, evidence: "process", detail: "no such run" };
  const identity = identityOf(run);
  if (!identity) return { ok: true, evidence: "process", detail: "no harness process was recorded" };
  const result = await terminate(identity, { graceMs: deps.timing().exit_grace_ms, group: true, ps: deps.ps });
  tx(deps.db, () =>
    appendEvent(deps.db, { source: "daemon", kind: "run.exited", runId, taskId: run.task_id, payload: { pid: identity.pid, ok: result.ok, signal: result.signal, evidence: result.evidence }, ts: deps.now() }),
  );
  return { ok: result.ok, evidence: result.evidence === "timeout" ? "timeout" : "process", detail: result.signal };
}

const INTERRUPT_MARKER = "[Request interrupted by user";

/** Has the transcript recorded an interrupt since `since` bytes? (M0 finding 6: it appears at once.) */
export function transcriptShowsInterrupt(path: string, fromByte: number): boolean {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= fromByte) return false;
    fd = openSync(path, "r");
    const length = Math.min(size - fromByte, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8").includes(INTERRUPT_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function transcriptSize(path: string | null): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Why the interrupt key must not be sent now, or null. Flowryn never answers a
 * dialog with keys: Escape on a permission dialog declines it. So the key goes
 * only while Herdr reads the agent "working" (a tool or a reply in progress;
 * "blocked" is a dialog, and a dialog and a running tool never overlap, M0
 * c12), and never while Flowryn knows of a dialog itself (blocked_dialog, an
 * open blocked_prompt). Herdr unreachable or unsure ("unknown", null) refuses
 * too. Because a dialog that just opened may not read "blocked" yet, the
 * status is read twice, secondReadMs apart, and the screen must not show a
 * dialog's question in between. The status is read right before the key; a
 * dialog that opens in the milliseconds after the second read is the
 * remaining window.
 */
export async function interruptKeyRefusal(deps: Pick<ControlDeps, "db" | "secondReadMs">, run: RunRow, runtime: HerdrRuntime): Promise<string | null> {
  const known = knownDialogRefusal(deps.db, run);
  if (known) return known;
  const first = await herdrStatusRefusal(runtime, run.pane_id!);
  if (first) return first;
  await Bun.sleep(deps.secondReadMs ?? SECOND_READ_MS);
  let screen: string | null;
  try {
    screen = await runtime.readPane(run.pane_id!, GATE_SCREEN_LINES);
  } catch (error) {
    return `cannot read the worker's screen from Herdr (${(error as Error).message})`;
  }
  if (screen === null) return "Herdr has no screen for the worker's pane; nothing to interrupt";
  if (DIALOG_QUESTION.test(screen)) return "the worker's screen shows a confirmation dialog; answer it in its pane";
  return (await herdrStatusRefusal(runtime, run.pane_id!)) ?? knownDialogRefusal(deps.db, run);
}

/** A dialog Flowryn itself knows of: the run's liveness, or an open blocked_prompt item. */
export function knownDialogRefusal(db: Db, run: RunRow): string | null {
  const current = getRun(db, run.id) ?? run;
  if (current.liveness === "blocked_dialog") return "the worker is blocked on a dialog; answer it in its pane";
  if (findOpenRunItem(db, "blocked_prompt", run.id)) return "a permission dialog is open; answer it in the worker's pane";
  return null;
}

async function herdrStatusRefusal(runtime: HerdrRuntime, paneId: string): Promise<string | null> {
  let status: string | null;
  try {
    status = await runtime.agentStatus(paneId);
  } catch (error) {
    return `cannot read the worker's status from Herdr (${(error as Error).message})`;
  }
  if (status === "blocked") return "Herdr reads the worker blocked on a dialog; answer it in its pane";
  if (status !== "working") return `Herdr reads the worker ${status ?? "unknown"}, not working; nothing to interrupt`;
  return null;
}

/**
 * Interrupt a busy worker. Claude: the interrupt key through Herdr, only while
 * no dialog can be open (interruptKeyRefusal), verified by the interrupt
 * marker in its transcript, because no hook and no idle_prompt follow an
 * interrupt (M0 c04); busy is then cleared here, since nothing else would
 * clear it before the lease expires. Pi: the extension's abort, verified by
 * the agent_settled it emits within milliseconds (M0 p14). After a verified
 * interrupt, steers carried but not yet seen are lost (Pi's abort drops queued
 * messages; an interrupted Claude turn never reads its attachment), and the
 * waiter is woken so an idle steer goes at once.
 */
export async function interruptRun(deps: ControlDeps, runId: string, waitMs = 10_000, options: { recordRefusal?: boolean } = {}): Promise<Verified> {
  const run = getRun(deps.db, runId);
  if (!run) return { ok: false, evidence: "timeout", detail: "no such run" };
  const identity = identityOf(run);
  if (!identity || !(await isAlive(identity, deps.ps))) return { ok: false, evidence: "process", detail: "the worker is not running" };
  const adapter = adapterFor(run.harness);
  const started = deps.now();
  const deadline = started + waitMs;
  let verified: Verified | null = null;
  if (adapter.interruptVia === "keys") {
    const runtime = deps.runtime();
    if (!runtime || !run.pane_id) return { ok: false, evidence: "timeout", detail: "Herdr is not reachable" };
    const refusal = await interruptKeyRefusal(deps, run, runtime);
    if (refusal) {
      if (options.recordRefusal !== false)
        tx(deps.db, () =>
          appendEvent(deps.db, { source: "daemon", kind: "run.interrupt_refused", runId, taskId: run.task_id, payload: { reason: refusal, liveness: run.liveness }, ts: deps.now() }),
        );
      return { ok: false, evidence: "refused", detail: refusal };
    }
    const before = transcriptSize(run.transcript_path);
    await runtime.sendInterrupt(run.pane_id);
    // Without a transcript (no worker-start yet) there is nothing to verify against; do not wait long.
    const until = run.transcript_path ? deadline : Math.min(deadline, started + 1_000);
    while (deps.now() < until) {
      await Bun.sleep(200);
      if (run.transcript_path && transcriptShowsInterrupt(run.transcript_path, before)) {
        verified = { ok: true, evidence: "transcript" };
        break;
      }
    }
  } else {
    deps.bus.command(runId, "interrupt");
    while (deps.now() < deadline) {
      await Bun.sleep(100);
      const current = getRun(deps.db, runId);
      if (current && current.idle_since !== null && current.idle_since >= started) {
        verified = { ok: true, evidence: "hook" };
        break;
      }
    }
  }
  const result = verified ?? { ok: false, evidence: "timeout" as const };
  tx(deps.db, () => {
    if (result.ok && adapter.interruptVia === "keys") {
      deps.db.query("UPDATE runs SET busy_until = NULL, idle_since = ?2, updated_at = ?2 WHERE id = ?1").run(runId, deps.now());
    }
    appendEvent(deps.db, { source: "daemon", kind: "run.interrupted", runId, taskId: run.task_id, payload: { ok: result.ok, evidence: result.evidence } });
    if (result.ok) markLost(deps.db, run, "interrupted", deps.now());
  });
  // Nothing else wakes the waiter after an interrupt: no hook fires (M0 c04), so an idle steer would wait for wait_poll_ms or a pass.
  if (result.ok) deps.bus.notify(runId);
  return result;
}
