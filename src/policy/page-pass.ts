import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { requireDraftPageShown } from "../lifecycle/draft.ts";
import { requireGateAnswered } from "../lifecycle/gate-questions.ts";
import { getRunWithPolicy } from "../lifecycle/runs.ts";
import { openGate } from "../lifecycle/stages.ts";
import type { PageCodeCheck, PageCodeStore } from "./approvals.ts";
import { recordGatePass, type GatePassed } from "./gates.ts";

/**
 * Passing a review gate from its page (docs/notes/2026-10-30-pass-a-review-c6.md).
 * "Send and pass" with no code asks for one: the daemon mints it (PageCodeStore,
 * in memory only) and sends it to your notifications, which a worker cannot
 * read. The same button with the code typed in passes the gate here, with
 * every rule of a gate pass (recordGatePass): refused while a question is
 * open, bound to the reviewed HEAD, single use. The approval's channel is
 * page. A code that arrives is good for that one Send: a refusal before it is
 * checked drops it too, since the Send carrying it went through Lavish and
 * the poll output, both readable locally. Plain code, no model.
 */

export type PagePass =
  | { outcome: "passed"; passed: GatePassed }
  | { outcome: "stale" | "late" }
  | { outcome: "questions_open"; open: string[] }
  | { outcome: "draft_changed"; task: string }
  | { outcome: Exclude<PageCodeCheck, "ok"> };

function user(): string {
  return process.env.USER || process.env.LOGNAME || "you";
}

/** Pass the gate with a code typed into its page, or say why not. Call inside a transaction. */
export function passFromPage(db: Db, codes: PageCodeStore, gateId: string, code: string, head: string, now: number): PagePass {
  const row = db.query("SELECT g.run_id, g.state, r.state AS run_state FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1 AND g.kind = 'review'").get(gateId) as { run_id: string; state: string; run_state: string } | null;
  const run = row ? getRunWithPolicy(db, row.run_id) : null;
  if (!row || !run || ["cleaned", "failed", "cancelled"].includes(row.run_state)) {
    codes.drop(gateId);
    return { outcome: "stale" };
  }
  const gate = openGate(db, run.id, "review");
  if (row.state !== "open" || !gate || gate.id !== gateId) {
    codes.drop(gateId);
    return { outcome: "late" };
  }
  try {
    requireGateAnswered(db, gate);
  } catch (error) {
    if (!(error instanceof FlowrynError) || error.code !== "questions_open") throw error;
    codes.drop(gateId);
    const open = db.query("SELECT id FROM decisions WHERE gate_id = ?1 AND state = 'open' ORDER BY id").all(gateId) as { id: string }[];
    return { outcome: "questions_open", open: open.map((d) => d.id) };
  }
  try {
    requireDraftPageShown(run, gate);
  } catch (error) {
    if (!(error instanceof FlowrynError) || error.code !== "draft_changed") throw error;
    codes.drop(gateId);
    return { outcome: "draft_changed", task: run.task_id };
  }
  const checked = codes.check(gateId, code, head, now);
  if (checked !== "ok") {
    // The outcome only, never the code typed.
    appendEvent(db, { source: "daemon", kind: "gate.page_pass_refused", runId: run.id, taskId: run.task_id, payload: { gate: gateId, why: checked }, ts: now });
    return { outcome: checked };
  }
  const passed = recordGatePass(db, run, gate, { channel: "page", actor: `${user()} (review page code)`, head }, now);
  return { outcome: "passed", passed };
}
