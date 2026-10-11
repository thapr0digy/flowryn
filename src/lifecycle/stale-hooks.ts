import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { idleAlertDue } from "./idle-alert.ts";
import type { RunRow } from "./runs.ts";
import { instructionAt, pendingWait } from "./turn-end-guard.ts";

/**
 * The stale-hook pointer (docs/notes/2026-10-10-quieter-stale-hook-3q.md):
 * Herdr reads the worker "working" but it has sent no hook event for
 * stale_hook_ms. It stays silent for a worker that rightly sits there, by the
 * turn-end guard's own rule (pendingWait: past running, a gate, a question, a
 * launch, a dialog, told to end the turn, its own background job), so the two
 * cannot drift. The quiet stretch counts from the later of the last hook and
 * the last instruction, so a long-idle worker just woken by a stage start or
 * a steer is not overdue the moment it wakes. Deterministic: database reads.
 */

export type StaleHooksVerdict = { due: true; quietFrom: number } | { due: false; why: string };

/**
 * Should the reconciler raise run.stale_hooks for this run now? Cheap checks
 * first; pendingWait reads the transcript only once the quiet stretch is
 * long enough. Call inside the transaction: pendingWait records background
 * jobs it finds ended.
 */
export function staleHooksDue(db: Db, run: RunRow, herdrStatus: string | null, t: number, timing: Timing): StaleHooksVerdict {
  if (herdrStatus !== "working") return { due: false, why: `herdr ${herdrStatus ?? "unreachable"}` };
  const lastHook = run.last_hook_at ?? run.launched_at ?? run.started_at;
  const instructed = instructionAt(db, run);
  const quietFrom = Math.max(lastHook, instructed);
  if (t - quietFrom < timing.stale_hook_ms) return { due: false, why: `quiet ${Math.round((t - quietFrom) / 60_000)}m since its last ${instructed > lastHook ? "instruction" : "hook"}` };
  const wait = pendingWait(db, run, t, "reconciler");
  if (wait !== null) return { due: false, why: wait };
  if (!idleAlertDue(db, run.id, quietFrom, t, timing.idle_realert_ms)) return { due: false, why: "pointer already raised this episode" };
  return { due: true, quietFrom };
}
