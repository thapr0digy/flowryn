import type { Db } from "../db/db.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { isTerminal, taskTitle, type RunState } from "../lifecycle/runs.ts";
import type { ScopeLens } from "../leader/scope.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { waitedLabel } from "./deadline-defaults.ts";

/**
 * The review-gate validator's rounds in a window (docs/notes/2026-11-08-unattended-loops-answer-4y.md),
 * as "Decided for you" lines: what each round did to which review, how long the gate had waited, the
 * report (`flowryn show j<N>`) and, for a pass, the undo while the run is live and undelivered.
 */

export interface ValidatorFinding {
  requirement: string | null;
  file: string | null;
  problem: string;
  fix: string;
}

export interface ValidatorQuestion {
  id: string;
  choice: string;
  consistent_with_spec: boolean;
  why: string;
}

/** A validator reply that followed the schema (parseValidatorReply in gate-validator.ts). */
export interface ValidatorVerdict {
  verdict: "pass" | "changes";
  findings: ValidatorFinding[];
  questions: ValidatorQuestion[];
}

export type ValidationState = "running" | "passed" | "changes" | "held" | "failed" | "advised";

/** One validator round: a gate_validations row (migration 59). */
export interface ValidationRow {
  id: string;
  gate_id: string;
  run_id: string;
  task_id: string;
  stage: string;
  away_since: number;
  head: string;
  state: ValidationState;
  verdict_json: string | null;
  reason: string | null;
  cost_usd: number | null;
  waited_ms: number;
  report_path: string | null;
  started_at: number;
  ended_at: number | null;
}

export function getValidation(db: Db, id: string): ValidationRow | null {
  return db.query("SELECT * FROM gate_validations WHERE id = ?1").get(id) as ValidationRow | null;
}

interface RoundRow {
  id: string;
  task_id: string;
  stage: string;
  state: "passed" | "changes" | "held" | "failed" | "advised";
  reason: string | null;
  verdict_json: string | null;
  waited_ms: number;
  run_state: RunState | null;
}

function outcome(r: RoundRow): string {
  const findings = r.verdict_json ? ((JSON.parse(r.verdict_json) as { findings?: unknown[] }).findings?.length ?? 0) : 0;
  switch (r.state) {
    case "passed":
      return "passed by the validator";
    case "changes":
      return `sent back by the validator with ${findings} ${findings === 1 ? "finding" : "findings"}`;
    case "held":
      return `passed by the validator but held for you: ${sanitizeLine(r.reason ?? "", 80)}`;
    case "failed":
      return `no verdict, waits for you: ${sanitizeLine(r.reason ?? "", 80)}`;
    case "advised":
      return `the validator's verdict is advice only: ${sanitizeLine(r.reason ?? "", 80)}`;
  }
}

function undo(db: Db, r: RoundRow): string {
  if (r.state !== "passed") return "";
  if (r.run_state === null || isTerminal(r.run_state)) return "; run over, no undo";
  if (deliveredOf(db, r.task_id)) return "; delivered: send changes on the PR instead";
  return `; undo: flowryn gate reopen ${r.task_id} --gate ${r.stage} --body-file -`;
}

/** One line per round ended in (since, until], in order. */
export function validatorRoundLines(db: Db, since: number, until: number, lens: ScopeLens): string[] {
  const rows = (
    db
      .query(
        `SELECT v.id, v.task_id, v.stage, v.state, v.reason, v.verdict_json, v.waited_ms, r.state AS run_state
         FROM gate_validations v LEFT JOIN runs r ON r.id = v.run_id
         WHERE v.state != 'running' AND v.ended_at > ?1 AND v.ended_at <= ?2 ORDER BY v.ended_at, v.id`,
      )
      .all(since, until) as RoundRow[]
  ).filter((r) => lens.task(r.task_id));
  return rows.map((r) => {
    const title = taskTitle(db, r.task_id);
    const name = `${sanitizeLine(title, 60)}${title === r.task_id ? "" : ` (${r.task_id})`}`;
    return `- [${r.id}] ${r.stage} review of ${name} → ${outcome(r)} (after ${waitedLabel(r.waited_ms)}; report: flowryn show ${r.id}${undo(db, r)})`;
  });
}
