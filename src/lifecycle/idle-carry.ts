import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { findOpenRunItem } from "../attention/items.ts";
import { steerPointer } from "../harness/contract-text.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { getRun, isTerminal, type RunRow } from "./runs.ts";
import { dueSteers, markRung, type MessageRow, type SteerBus } from "./steers.ts";

/**
 * The idle-carry fallback. An idle Claude worker gets steers only through its
 * asyncRewake waiter, which lives at most 8 h and is armed only by the
 * worker's own prompt and Stop hooks: once it expires (a review gate held
 * overnight) or dies with an old daemon (a protocol change), a steer to the
 * idle worker waits forever, and `flowryn interrupt` has nothing to
 * interrupt. So, after waiter_grace_ms with a due steer and no waiter, the
 * reconciler types the fixed steer pointer into the pane and submits it. The
 * new turn's prompt hook arms a fresh waiter; the ring is an idle carry, so
 * it must be seen within seen_timeout_ms or it rings again.
 *
 * Keys go only where no dialog can be up: Flowryn knows of none (liveness
 * idle, no blocked_prompt item), and Herdr reads the agent settled ("idle"
 * or "done", never "blocked", "working", "unknown" or unreachable) on every
 * pass of the grace and once more right before the keys (spike c12: Herdr
 * reads "blocked" for exactly a dialog's duration).
 */

/** "idle" or "done": a Claude worker at its composer, not mid-tool and not in a dialog. */
export function settledStatus(status: string | null): boolean {
  return status === "idle" || status === "done";
}

/** Why no idle carry may start for this run now, or null. Pure: reads the database and the bus only. */
export function idleCarryBlocker(db: Db, bus: SteerBus, run: RunRow, herdrStatus: string | null, now: number, timing: Timing): string | null {
  if (run.harness !== "claude") return "not a claude worker";
  if (isTerminal(run.state) || run.pane_id === null) return "no live pane";
  if (run.liveness !== "idle") return `liveness ${run.liveness}`;
  if (findOpenRunItem(db, "blocked_prompt", run.id)) return "a permission dialog is open";
  if (!settledStatus(herdrStatus)) return `Herdr reads ${herdrStatus ?? "nothing"}`;
  if (bus.hasWaiter(run.id)) return "a waiter holds the run";
  if (dueSteers(db, run.id, now, timing).length === 0) return "no steer is due";
  return null;
}

export interface IdleCarryDeps {
  db: Db;
  bus: SteerBus;
  timing(): Timing;
  now(): number;
}

/**
 * Type the oldest due steer's pointer into the pane, after a fresh status
 * read and a re-check, and record the ring. Returns the steer carried, or
 * null when the re-check refused (recorded as an event when it was the
 * status).
 */
export async function carryIdleSteer(deps: IdleCarryDeps, runId: string, runtime: HerdrRuntime): Promise<string | null> {
  const { db, bus } = deps;
  const before = getRun(db, runId);
  if (!before?.pane_id) return null;
  let status: string | null;
  try {
    status = await runtime.agentStatus(before.pane_id);
  } catch {
    status = null;
  }
  const run = getRun(db, runId);
  if (!run) return null;
  const due: MessageRow | undefined = dueSteers(db, run.id, deps.now(), deps.timing())[0];
  const blocker = idleCarryBlocker(db, bus, run, status, deps.now(), deps.timing());
  if (blocker || !due) {
    tx(db, () => appendEvent(db, { source: "reconciler", kind: "steer.idle_carry_refused", runId, taskId: run.task_id, payload: { reason: blocker ?? "no steer is due", status }, ts: deps.now() }));
    return null;
  }
  await runtime.typeLine(run.pane_id!, steerPointer(due.id));
  tx(db, () => {
    // A waiter (re-armed by the turn the keys just started) may have carried it in between.
    const still = dueSteers(db, run.id, deps.now(), deps.timing()).find((m) => m.id === due.id);
    if (still) markRung(db, still, run, "keys", deps.now(), true, deps.timing());
  });
  bus.notify(run.id);
  return due.id;
}
