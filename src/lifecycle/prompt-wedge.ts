import { appendEvent, type EventSource } from "../db/events.ts";
import type { Db } from "../db/db.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { redactSecrets } from "../util/redact.ts";
import { findOpenRunItem, resolveRunItems } from "../attention/items.ts";
import { explain, type Fact, type Unblock } from "../attention/explanations.ts";
import { openRunItemOnce, setLiveness, taskTitle, type RunRow } from "./runs.ts";
import { createSteer, type MessageRow } from "./steers.ts";

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
export function openBlockedPrompt(
  db: Db,
  run: RunRow,
  how: { suspected: boolean; screen: string | null; harness: "claude" | "pi"; lastHook: number; herdrStatus?: string | null; heldTool?: string | null },
  now: number,
): string | null {
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
  const item = openRunItemOnce(db, "blocked_prompt", run, event.seq, line, now);
  explainDialog(db, run, how, prompt, item, now);
  if (how.harness === "claude") openEpisode(db, run, item, how.heldTool ?? null, prompt, how.suspected ? "reconciler" : "hook", now);
  return item;
}

// --- after the prompt: answered or blocked (docs/notes/2026-11-08-keep-workers-off-pp.md) ------------

/** The third blocked prompt for one run inside the window goes to the leader instead of another steer. */
export const PROMPT_REPEAT_LIMIT = 3;
export const PROMPT_REPEAT_WINDOW_MS = 30 * 60_000;

/** The text Claude hands the model for a refused or auto-blocked tool call (Claude Code 2.1.319). */
const DENIAL_TEXT = /doesn't want to proceed with this tool use|tool use was rejected|permission for this tool use was denied|permission to use \S+ (?:with .{1,200} )?has been denied|awaiting approval did not run/i;

export type EpisodeOutcome = "pending" | "answered" | "denied" | "void";

export interface PromptEpisode {
  id: number;
  run_id: string;
  item_id: string | null;
  held_tool: string | null;
  prompt: string;
  opened_at: number;
  outcome: EpisodeOutcome;
  decided_at: number | null;
  via: string | null;
  steer_id: string | null;
}

/** A worker hook seen after a prompt opened, by what it tells about the held tool. */
export type PromptSignal =
  | { hook: "pre-tool" | "post-tool"; tool: string | null }
  | { hook: "tool-failed"; tool: string | null; error: string | null }
  | { hook: "permission-denied"; tool: string | null }
  | { hook: "stop" | "prompt" };

/** What the episode's next hook decides: answered (the command ran), denied (it did not), or nothing yet. */
export function outcomeOf(heldTool: string | null, signal: PromptSignal): "answered" | "denied" | null {
  switch (signal.hook) {
    case "stop":
    case "prompt":
      // A turn cannot end, nor a new prompt arrive, while the held tool runs: it never ran.
      return "denied";
    case "permission-denied":
      return heldTool === null || signal.tool === null || signal.tool === heldTool ? "denied" : null;
    case "tool-failed":
      if (heldTool !== null && signal.tool !== heldTool) return null;
      return signal.error !== null && DENIAL_TEXT.test(signal.error) ? "denied" : "answered";
    case "post-tool":
      if (heldTool === null) return "answered";
      return signal.tool === heldTool ? "answered" : null;
    case "pre-tool":
      // The worker went on to another tool while the held one never finished. Unknown held tool: no guess.
      return heldTool !== null && signal.tool !== null && signal.tool !== heldTool ? "denied" : null;
  }
}

/** The prompt line as quoted data: sanitized, quote marks neutralised, capped. */
export function quotedPrompt(prompt: string): string {
  const line = sanitizeLine(prompt.replace(/["`]/g, "'"), 160);
  return line.length > 0 ? `"${line}"` : "(prompt text not captured)";
}

/** The fixed steer for a blocked command. Plain template, no model. */
export function promptSteerBody(prompt: string, base: string): string {
  return [
    `Your last command was blocked by a permission prompt and did not run: ${quotedPrompt(prompt)}.`,
    "Do not retry it. Do the same thing another way: edit files with your Edit/Write tool (no python/perl/sed -i scripts);",
    `new commits only, git merge origin/${base}, plain push; rm only "\${VAR:?}" or mktemp -d paths. Then ack this steer.`,
  ].join(" ");
}

function openEpisode(db: Db, run: RunRow, item: string | null, heldTool: string | null, prompt: string, source: EventSource, now: number): void {
  // A second prompt opening while one is undecided: the older one is superseded (its tool never finished either).
  voidPendingEpisodes(db, run, "superseded", source, now);
  const row = db
    .query("INSERT INTO prompt_episodes (run_id, item_id, held_tool, prompt, opened_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id")
    .get(run.id, item, heldTool, sanitizeLine(prompt, 160), now) as { id: number };
  appendEvent(db, { source, kind: "run.prompt_episode", runId: run.id, taskId: run.task_id, payload: { episode: row.id, item, held_tool: heldTool }, ts: now });
}

export function pendingEpisode(db: Db, runId: string): PromptEpisode | null {
  return db.query("SELECT * FROM prompt_episodes WHERE run_id = ?1 AND outcome = 'pending' ORDER BY id DESC LIMIT 1").get(runId) as PromptEpisode | null;
}

/** A new session, a resume or a superseding prompt: an undecided episode can no longer be told. Call inside a transaction. */
export function voidPendingEpisodes(db: Db, run: RunRow, via: string, source: EventSource, now: number): void {
  const voided = db.query("UPDATE prompt_episodes SET outcome = 'void', decided_at = ?2, via = ?3 WHERE run_id = ?1 AND outcome = 'pending' RETURNING id").all(run.id, now, via) as { id: number }[];
  for (const { id } of voided) appendEvent(db, { source, kind: "run.prompt_outcome", runId: run.id, taskId: run.task_id, payload: { episode: id, outcome: "void", via }, ts: now });
}

export type Settled = { outcome: "answered" | "denied"; episode: number; steer: MessageRow | null; item: string | null } | null;

/**
 * Decide the run's pending episode from a main-agent worker hook. Claude
 * runs no main-agent hook while its dialog is up (spike c12), so the hook is
 * itself proof the dialog is gone; every caller also releases the
 * blocked_prompt item in the same transaction. Denied: the fixed steer, or
 * past the repeat limit a P1 for the leader instead. Never touches the
 * dialog or the pane. Call inside the hook's transaction; the hook's settle
 * notifies the bus after commit, so the steer rings by the usual path.
 */
export function settlePromptEpisode(db: Db, run: RunRow, signal: PromptSignal, base: string, now: number): Settled {
  const episode = pendingEpisode(db, run.id);
  if (!episode) return null;
  const outcome = outcomeOf(episode.held_tool, signal);
  if (outcome === null) return null;
  if (outcome === "answered") {
    decide(db, run, episode, "answered", signal.hook, null, now);
    return { outcome, episode: episode.id, steer: null, item: null };
  }
  const recent = db
    .query("SELECT prompt FROM prompt_episodes WHERE run_id = ?1 AND opened_at > ?2 AND outcome IN ('pending', 'denied') ORDER BY opened_at DESC")
    .all(run.id, now - PROMPT_REPEAT_WINDOW_MS) as { prompt: string }[];
  if (recent.length >= PROMPT_REPEAT_LIMIT) {
    decide(db, run, episode, "denied", signal.hook, null, now);
    const texts = recent.slice(0, PROMPT_REPEAT_LIMIT).map((r) => quotedPrompt(r.prompt));
    const event = appendEvent(db, { source: "hook", kind: "run.prompt_repeat", runId: run.id, taskId: run.task_id, payload: { episodes: recent.length, prompts: texts }, ts: now });
    const line = `${taskTitle(db, run.task_id)} was blocked by permission prompts ${recent.length} times in ${PROMPT_REPEAT_WINDOW_MS / 60_000} min; Flowryn stopped steering it on: ${texts.join("; ")}`;
    const item = openRunItemOnce(db, "prompt_repeat", run, event.seq, line, now);
    return { outcome, episode: episode.id, steer: null, item };
  }
  const steer = createSteer(db, run, promptSteerBody(episode.prompt, base), now);
  decide(db, run, episode, "denied", signal.hook, steer.id, now);
  return { outcome, episode: episode.id, steer, item: null };
}

function decide(db: Db, run: RunRow, episode: PromptEpisode, outcome: "answered" | "denied", via: string, steer: string | null, now: number): void {
  db.query("UPDATE prompt_episodes SET outcome = ?2, decided_at = ?3, via = ?4, steer_id = ?5 WHERE id = ?1").run(episode.id, outcome, now, via, steer);
  appendEvent(db, { source: "hook", kind: "run.prompt_outcome", runId: run.id, taskId: run.task_id, payload: { episode: episode.id, outcome, via, ...(steer ? { steer } : {}) }, ts: now });
}

/** Why the run is held: which rule saw the dialog, on what, and what ends it (docs/notes/2026-10-12-next-steps-md-wz.md). */
function explainDialog(db: Db, run: RunRow, how: { suspected: boolean; harness: "claude" | "pi"; lastHook: number; herdrStatus?: string | null }, prompt: string, item: string | null, now: number): void {
  const pane = run.pane_id ?? "(none)";
  const rule = !how.suspected ? "dialog.confirmed" : how.harness === "pi" ? "dialog.stall" : "dialog.suspected";
  const reason =
    rule === "dialog.confirmed"
      ? `a confirmation dialog is up in pane ${pane}`
      : rule === "dialog.suspected"
        ? `Herdr reads the agent blocked, likely on a dialog in pane ${pane}`
        : `the Pi worker in pane ${pane} sent no hook for a while and is not working`;
  const facts: Fact[] = [
    ...(prompt ? [{ name: "prompt", value: prompt, at: now }] : []),
    ...(how.herdrStatus !== undefined ? [{ name: "herdr agent_status", value: how.herdrStatus ?? "unreadable", at: now }] : []),
    { name: "last hook", value: new Date(how.lastHook).toISOString(), at: how.lastHook },
  ];
  const cleared =
    how.harness === "claude"
      ? "clears it on the worker's next hook, or when Herdr reads the agent working (or settled on two passes)"
      : "clears it on the worker's next hook";
  const unblock: Unblock[] = [
    { by: "captain", action: rule === "dialog.confirmed" ? `answer the dialog in pane ${pane} (Flowryn never answers it)` : `look at pane ${pane} and answer what it asks` },
    { by: "flowryn", action: cleared },
  ];
  explain(db, { run, kind: "dialog", rule, reason, facts, unblock, itemId: item ?? findOpenRunItem(db, "blocked_prompt", run.id)?.id ?? null, source: how.suspected ? "reconciler" : "hook", now });
}
