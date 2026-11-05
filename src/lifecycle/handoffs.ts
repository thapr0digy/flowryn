import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { docProblems } from "./brief.ts";

/**
 * Stage handoffs (docs/notes/2026-11-05-workers-get-rich-hx.md): `stage done
 * --handoff-file` carries what the stage did, where it deviated from the spec
 * and why, and its open risks, into the next stage's note and into every later
 * task file of the task.
 */

export const HANDOFF_MAX_CHARS = 8 * 1024;
/** The stage whose handoff is required (while [briefs] enforce is on). */
export const HANDOFF_REQUIRED_SKILL = "flowryn-build-test";

export interface Handoff {
  stage: string;
  run_id: string;
  text: string;
  created_at: number;
}

/** Runs started before the rich-briefs migration was applied finish as they began: no build spec or handoff is required of them. */
export function startedUnderRichBriefs(db: Db, startedAt: number): boolean {
  const row = db.query("SELECT applied_at FROM schema_migrations WHERE name = 'rich-briefs'").get() as { applied_at: number | null } | null;
  return row?.applied_at != null && startedAt >= row.applied_at;
}

/** A handoff as the worker wrote it, cleaned and checked: refused with every problem. */
export function checkHandoff(raw: string): string {
  const text = sanitizeBlock(raw).trim();
  if (text.length === 0) throw new FlowrynError("handoff_invalid", "the handoff is empty", "$FLOWRYN_BIN template handoff prints its shape");
  if (text.length > HANDOFF_MAX_CHARS) throw new FlowrynError("handoff_invalid", `the handoff is ${text.length} characters; keep it to ${HANDOFF_MAX_CHARS}`, "the detail belongs in commits and the PR; the handoff says what the next stage must know");
  const problems = docProblems("handoff", text);
  if (problems.length > 0) throw new FlowrynError("handoff_invalid", `the handoff is incomplete: ${problems.join("; ")}`, "$FLOWRYN_BIN template handoff prints its shape");
  return text;
}

/** Keep a stage's handoff. Call inside a transaction, with the stage.done event. */
export function recordHandoff(db: Db, run: { id: string; task_id: string }, stage: string, text: string, now: number): number {
  const row = db.query("INSERT INTO stage_handoffs (run_id, task_id, stage, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id").get(run.id, run.task_id, stage, text, now) as { id: number };
  return row.id;
}

/** Every handoff of a task, oldest first: the latest of each stage wins when a stage ran twice. */
export function handoffsOf(db: Db, taskId: string): Handoff[] {
  const all = db.query("SELECT stage, run_id, text, created_at FROM stage_handoffs WHERE task_id = ?1 ORDER BY created_at, id").all(taskId) as Handoff[];
  const latest = new Map<string, Handoff>();
  for (const h of all) {
    latest.delete(h.stage);
    latest.set(h.stage, h);
  }
  return [...latest.values()];
}

/** The note that starts the next stage: the handoff itself, not only "Stage X is done." */
export function handoffNote(stage: string, text: string | null): string {
  return text ? `Stage ${stage} is done. Its handoff (also in your task file's carried context):\n\n${text}` : `Stage ${stage} is done.`;
}
