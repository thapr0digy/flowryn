import { appendEvent } from "../db/events.ts";
import type { Db } from "../db/db.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { redactSecrets } from "../util/redact.ts";
import { openRunItemOnce, setLiveness, taskTitle, type RunRow } from "./runs.ts";

/**
 * A worker stopped mid-run by a confirmation prompt (cutover C2): your own
 * hooks (dangerous-bash-hook), a model switch, a permission dialog. Flowryn
 * never answers it; it tells you, once, with what the screen shows.
 */

export const SCREEN_LINES = 40;
const PROMPT_HINT = /(proceed|allow|approve|confirm|continue|\?\s*$|\(y\/n\)|yes\b.*\bno\b)/i;

/** The prompt as one line: the last few non-empty screen lines, the ones that read like a question first. */
export function promptLineOf(screen: string | null): string {
  if (!screen) return "";
  const lines = redactSecrets(screen).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-6);
  const asked = tail.filter((l) => PROMPT_HINT.test(l));
  return sanitizeLine((asked.length > 0 ? asked : tail).join(" "), 160);
}

/** Is the run waiting by design: a review gate, a steer it has not acted on, or its own blocking question? */
export function idleByDesign(db: Db, run: RunRow): boolean {
  if (run.stage_state === "review") return true;
  if (db.query("SELECT 1 FROM messages WHERE run_id = ?1 AND acked_at IS NULL").get(run.id)) return true;
  return db.query("SELECT 1 FROM decisions WHERE run_id = ?1 AND state = 'open' AND blocking = 1").get(run.id) !== null;
}

/** Record it and open the one item. Call inside a transaction. */
export function openBlockedPrompt(db: Db, run: RunRow, how: { suspected: boolean; screen: string | null; harness: "claude" | "pi" }, now: number): string | null {
  const screen = how.screen ? redactSecrets(how.screen).split("\n").slice(-SCREEN_LINES).join("\n") : null;
  setLiveness(db, run, "blocked_dialog", how.suspected ? "reconciler" : "hook", { prompt: true }, now);
  const event = appendEvent(db, { source: how.suspected ? "reconciler" : "hook", kind: "run.blocked_prompt", runId: run.id, taskId: run.task_id, payload: { suspected: how.suspected, screen }, ts: now });
  const prompt = promptLineOf(screen);
  const title = taskTitle(db, run.task_id);
  const line =
    how.harness === "pi"
      ? `${title} may be stalled (no activity for ${Math.round((now - (run.last_hook_at ?? now)) / 1000)}s)${prompt ? `: ${prompt}` : ""}`
      : how.suspected
        ? `${title} may be waiting on a confirmation${prompt ? `: ${prompt}` : ""}; look at pane ${run.pane_id}`
        : `${title} is waiting on a confirmation: ${prompt || "see pane " + run.pane_id}`;
  return openRunItemOnce(db, "blocked_prompt", run, event.seq, line, now);
}
