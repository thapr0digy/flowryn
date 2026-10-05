import { appendEvent } from "../db/events.ts";
import type { Db } from "../db/db.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { redactSecrets } from "../util/redact.ts";
import { findOpenRunItem, resolveRunItems } from "../attention/items.ts";
import { openRunItemOnce, setLiveness, taskTitle, type RunRow } from "./runs.ts";

/**
 * A worker stopped mid-run by a confirmation prompt (cutover C2): your own
 * hooks (dangerous-bash-hook), a model switch, a permission dialog. Flowryn
 * never answers it; it tells you, once, with what the screen shows.
 */

export const SCREEN_LINES = 40;
const PROMPT_HINT = /(proceed|allow|approve|confirm|continue|\?\s*$|\(y\/n\)|yes\b.*\bno\b)/i;
/** The question every Claude confirmation dialog asks (spike c12). */
export const DIALOG_QUESTION = /Do you want to proceed\?/i;

/**
 * The prompt as one line. Claude's confirmation dialog always asks "Do you
 * want to proceed?": when that line is on screen, anchor on the LAST one
 * (an earlier, already-declined dialog can still be in the scrollback) and
 * take up to 3 non-empty lines above it too (the command it is confirming),
 * rather than the plain last-lines guess, which can land on the "1. Yes" /
 * "2. No" choices instead of the command. Anything else (Pi, a dialog with
 * no such line) falls back to the last few screen lines, preferring ones
 * that read like a question.
 */
export function promptLineOf(screen: string | null): string {
  if (!screen) return "";
  const lines = redactSecrets(screen).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const questionAt = lines.findLastIndex((l) => DIALOG_QUESTION.test(l));
  if (questionAt !== -1) return sanitizeLine(lines.slice(Math.max(0, questionAt - 3), questionAt + 1).join(" "), 160);
  const tail = lines.slice(-6);
  const asked = tail.filter((l) => PROMPT_HINT.test(l));
  return sanitizeLine((asked.length > 0 ? asked : tail).join(" "), 160);
}

/**
 * Is the run waiting by design: a review gate, or its own blocking question?
 * An unacked steer is not included: a worker acting on a steer is busy with
 * an unacknowledged message, not idle, so it never belongs here. Only the
 * backstop (no confirmed dialog, just a suspected one) consults this; the
 * confirmed notify path opens the item regardless, since a dialog that is
 * actually up is never idle by design.
 */
export function idleByDesign(db: Db, run: RunRow): boolean {
  if (run.stage_state === "review") return true;
  return db.query("SELECT 1 FROM decisions WHERE run_id = ?1 AND state = 'open' AND blocking = 1").get(run.id) !== null;
}

/**
 * The dialog behind an open blocked_prompt is gone (Herdr reads it working
 * again, or settled twice): resolve the item, say so, and return the run to
 * busy. Call inside a transaction.
 */
export function clearPrompt(db: Db, run: RunRow, herdrStatus: string | null, source: "reconciler" | "daemon", now: number): void {
  resolveRunItems(db, run.id, ["blocked_prompt"], "dialog gone", now);
  appendEvent(db, { source, kind: "run.prompt_cleared", runId: run.id, taskId: run.task_id, payload: { agent_status: herdrStatus }, ts: now });
}

/**
 * Record it and open the one item, only when it is not already open (a
 * second notification for the same stuck prompt touches nothing). Call
 * inside a transaction.
 */
export function openBlockedPrompt(db: Db, run: RunRow, how: { suspected: boolean; screen: string | null; harness: "claude" | "pi"; lastHook: number }, now: number): string | null {
  if (findOpenRunItem(db, "blocked_prompt", run.id)) return null;
  const screen = how.screen ? redactSecrets(how.screen).split("\n").slice(-SCREEN_LINES).join("\n") : null;
  setLiveness(db, run, "blocked_dialog", how.suspected ? "reconciler" : "hook", { prompt: true }, now);
  const event = appendEvent(db, { source: how.suspected ? "reconciler" : "hook", kind: "run.blocked_prompt", runId: run.id, taskId: run.task_id, payload: { suspected: how.suspected, screen }, ts: now });
  const prompt = promptLineOf(screen);
  const title = taskTitle(db, run.task_id);
  const line =
    how.harness === "pi"
      ? `${title} may be stalled (no activity for ${Math.round((now - how.lastHook) / 1000)}s)${prompt ? `: ${prompt}` : ""}`
      : how.suspected
        ? `${title} may be waiting on a confirmation${prompt ? `: ${prompt}` : ""}; look at pane ${run.pane_id}`
        : `${title} is waiting on a confirmation: ${prompt || "see pane " + run.pane_id}`;
  return openRunItemOnce(db, "blocked_prompt", run, event.seq, line, now);
}
