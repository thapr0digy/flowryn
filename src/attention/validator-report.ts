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
  /** Null for a merge round (stage `merge`, migration 60). */
  gate_id: string | null;
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
  /** A merge round's PR ref (migration 60); null for a review round. */
  ref: string | null;
}

/** The stage a merge round records in gate_validations (src/attention/away-merge.ts): no review gate is named so. */
export const MERGE_STAGE = "merge";
/** The approval channel a passed merge round mints. */
export const AWAY_VALIDATOR_CHANNEL = "away-validator";

/** The round an approval minted by the validator came from: its actor names it (`validator j<N> …`). */
export function validationIdOfActor(actor: string): string | null {
  return /^validator (j\d+)\b/.exec(actor)?.[1] ?? null;
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

/** What became of a passed merge round's approval: merged, waiting, stopped by your return, or voided by a new head. */
function mergeFate(db: Db, id: string): string {
  const approved = db.query("SELECT json_extract(payload, '$.approval') AS approval FROM events WHERE kind = 'away_merge.approved' AND json_extract(payload, '$.validation') = ?1 LIMIT 1").get(id) as { approval: string } | null;
  if (!approved) return "";
  const merge = db.query("SELECT id, state FROM merges WHERE approval_id = ?1 ORDER BY requested_at DESC LIMIT 1").get(approved.approval) as { id: string; state: string } | null;
  if (merge) return merge.state === "merged" ? `; merged as ${merge.id}` : `; merge ${merge.id} ${merge.state}`;
  const approval = db.query("SELECT consumed_at FROM approvals WHERE id = ?1").get(approved.approval) as { consumed_at: number | null } | null;
  if (approval && approval.consumed_at === null) return "; waiting on the merge checks";
  const stopped = db.query("SELECT json_extract(payload, '$.why') AS why FROM events WHERE kind = 'away_merge.stopped' AND json_extract(payload, '$.approval') = ?1 LIMIT 1").get(approved.approval) as { why: string } | null;
  if (stopped) return `; not merged: ${sanitizeLine(stopped.why, 60)}, so it waits for flowryn approve`;
  return "; not merged: its head changed, so a later round judges the new head";
}

function mergeOutcome(r: RoundRow): string {
  switch (r.state) {
    case "passed":
      return "passed by the validator";
    case "failed":
      return `no verdict, the PR waits for your approval: ${sanitizeLine(r.reason ?? "", 80)}`;
    case "advised":
      return `advice only, the PR waits for your approval: ${sanitizeLine(r.reason ?? "", 80)}`;
    default:
      return outcome(r);
  }
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
    if (r.stage === MERGE_STAGE) return `- [${r.id}] pre-merge check of sensitive ${name} → ${mergeOutcome(r)} (report: flowryn show ${r.id}${r.state === "passed" ? mergeFate(db, r.id) : ""})`;
    return `- [${r.id}] ${r.stage} review of ${name} → ${outcome(r)} (after ${waitedLabel(r.waited_ms)}; report: flowryn show ${r.id}${undo(db, r)})`;
  });
}

interface AwayMergeRow {
  id: string;
  task_id: string;
  pr_url: string;
  head_sha: string;
  state: string;
  merge_sha: string | null;
  method: string | null;
  detail: string | null;
  actor: string;
}

/** The revert that undoes a merge, by the method it was merged with; it goes through a new fix ship, never a rewrite. */
export function revertCommand(method: string | null, sha: string | null): string {
  if (!sha) return "revert its commits";
  if (method === "merge") return `git revert -m 1 ${sha.slice(0, 12)}`;
  if (method === "rebase") return `git revert the PR's commits ending at ${sha.slice(0, 12)}`;
  return `git revert ${sha.slice(0, 12)}`;
}

/**
 * Each sensitive merge asked for in (since, until] under an away-validator approval
 * (docs/notes/2026-11-08-merge-sensitive-prs-rr.md): its PR, the validator report and the undo.
 * A merge that did not land says so; nothing here says anything was un-merged.
 */
export function awayMergeLines(db: Db, since: number, until: number, lens: ScopeLens): string[] {
  const rows = (
    db
      .query(
        `SELECT m.id, m.task_id, m.pr_url, m.head_sha, m.state, m.merge_sha, m.method, m.detail, a.actor
         FROM merges m JOIN approvals a ON a.id = m.approval_id
         WHERE a.channel = '${AWAY_VALIDATOR_CHANNEL}' AND m.requested_at > ?1 AND m.requested_at <= ?2 ORDER BY m.requested_at, m.id`,
      )
      .all(since, until) as AwayMergeRow[]
  ).filter((r) => lens.task(r.task_id));
  return rows.map((r) => {
    const title = taskTitle(db, r.task_id);
    const name = `${sanitizeLine(title, 60)}${title === r.task_id ? "" : ` (${r.task_id})`}`;
    const validation = validationIdOfActor(r.actor) ?? "-";
    const report = `report: flowryn show ${validation}`;
    if (r.state === "merged") return `- [${r.id}] merged sensitive PR ${r.pr_url} of ${name} after the validator passed it (${report}; undo: ${revertCommand(r.method, r.merge_sha)} in a new fix ship)`;
    if (r.state === "requested") return `- [${r.id}] merge of sensitive PR ${r.pr_url} of ${name} asked of GitHub after the validator passed it, not yet proven (${report}; flowryn show ${r.task_id})`;
    return `- [${r.id}] sensitive PR ${r.pr_url} of ${name} did not merge (${r.state}: ${sanitizeLine(r.detail ?? "-", 80)}); it waits for you (${report})`;
  });
}
