import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { answerDecision } from "../lifecycle/decision-verbs.ts";
import { localDate } from "../lifecycle/dates.ts";
import { DEADLINE_VIA, type DecisionRow } from "../lifecycle/decisions.ts";
import { getRunWithPolicy, isTerminal, type RunWithPolicy } from "../lifecycle/runs.ts";
import { getAway, holderInactiveSince } from "./away.ts";
import { DEADLINE_CLASSES, DEADLINE_FLOOR, DEADLINE_REFUSED_ANSWERS, reservedReason, type DecisionsConfig } from "./decisions-policy.ts";

/**
 * Deadline defaults (docs/notes/2026-10-30-deadline-defaults-for-gg.md): a
 * run-scoped question reserved for the user, of a kind `[decisions]
 * default_classes` opts in, carrying a recommendation, is answered as
 * recommended once it has waited `default_after_h` while the user is away or
 * inactive in every leader session. The answer is a policy answer (answered_by
 * policy, answered_via deadline), so `decide --by captain` undoes it while the
 * run is live, and the return brief lists it under "Decided for you". The
 * floor is in code: every keyword class, sensitive tasks, review-gate
 * questions, standalone decisions and the answers that skip CI or change
 * nothing are never taken. Plain code: a timer and a rule table; no model.
 */

/** Why a question is not answered by deadline now, or null when it may be. Pure: the run and the clock are read before. */
export function deadlineRefusal(d: DecisionRow, run: Pick<RunWithPolicy, "state" | "sensitive"> | null, cfg: Pick<DecisionsConfig, "default_after_h" | "default_classes" | "reserved_classes">, now: number): string | null {
  if (d.state !== "open") return "not open";
  if (d.reserved_reason === null) return "not reserved";
  if (d.run_id === null) return "standalone decision";
  if (d.gate_id !== null) return "review-gate question";
  if (d.defer_until !== null && d.defer_until > localDate(new Date(now))) return "deferred";
  const klass = d.reserved_class;
  if (klass === null || DEADLINE_FLOOR.includes(klass) || !(DEADLINE_CLASSES as readonly string[]).includes(klass)) return `kind ${klass ?? "none"} is always the user's`;
  if (!(cfg.default_classes as readonly string[]).includes(klass)) return `kind ${klass} is not opted in`;
  const options = JSON.parse(d.options) as string[];
  if (d.recommendation === null || !options.includes(d.recommendation)) return "no recommendation among its options";
  if (DEADLINE_REFUSED_ANSWERS.includes(d.recommendation)) return `the recommendation ${d.recommendation} is the user's`;
  if (d.created_at === null || now - d.created_at < cfg.default_after_h * 3_600_000) return "has not waited long enough";
  if (!run || isTerminal(run.state)) return "its run is over";
  if (run.sensitive === 1) return "sensitive task";
  // The wording is checked again with every keyword class on, whatever reserved_classes narrows.
  const all = { ...cfg, reserved_classes: [...DEADLINE_FLOOR], nomistakes_rules: [] };
  if (reservedReason({ question: d.question, context: d.context, sourceReason: null, blocksYoloOff: false }, all) !== null) return "its wording names a protected kind";
  return null;
}

/** The user is away, or inactive in every open leader session. */
export function userAbsent(db: Db, now: number): boolean {
  return getAway(db, now) !== null || holderInactiveSince(db) !== null;
}

/** "4h 12m" */
export function waitedLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface DeadlineAnswer {
  decision: string;
  run: string;
  choice: string;
  steer: string | null;
}

/**
 * One pass: answer every question that is due, as recommended. Off (no read
 * beyond the config) while `default_classes` is empty or the user is present.
 * Call inside a transaction; the caller notifies the runs it steered.
 */
export function deadlineDefaults(db: Db, input: { cfg: DecisionsConfig; now: number }): DeadlineAnswer[] {
  const { cfg, now } = input;
  if (cfg.default_classes.length === 0 || !userAbsent(db, now)) return [];
  const due = db
    .query(`SELECT * FROM decisions WHERE state = 'open' AND run_id IS NOT NULL AND reserved_class IN (${cfg.default_classes.map((_, i) => `?${i + 2}`).join(",")}) AND created_at <= ?1 ORDER BY created_at`)
    .all(now - cfg.default_after_h * 3_600_000, ...cfg.default_classes) as DecisionRow[];
  const answered: DeadlineAnswer[] = [];
  for (const d of due) {
    const run = getRunWithPolicy(db, d.run_id!);
    if (deadlineRefusal(d, run, cfg, now) !== null) continue;
    const waited = waitedLabel(now - d.created_at!);
    const done = answerDecision({ db, now: () => now }, d, {
      choice: d.recommendation!,
      words: `Taken as recommended after ${waited} while the user was away (deadline default, [decisions] default_classes ${d.reserved_class}); the user may still change it.`,
      by: "policy",
      via: DEADLINE_VIA,
    });
    appendEvent(db, { source: "daemon", kind: "decision.deadline_default", runId: d.run_id, taskId: d.task_id, payload: { decision: d.id, class: d.reserved_class, choice: d.recommendation, waited_ms: now - d.created_at!, steer: done.steer }, ts: now });
    answered.push({ decision: d.id, run: d.run_id!, choice: d.recommendation!, steer: done.steer });
  }
  return answered;
}
