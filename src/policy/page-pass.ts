import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { requireDraftPageShown } from "../lifecycle/draft.ts";
import { requireDesignPinned } from "../lifecycle/design-spec.ts";
import { requireGateAnswered } from "../lifecycle/gate-questions.ts";
import { getRunWithPolicy } from "../lifecycle/runs.ts";
import { openGate } from "../lifecycle/stages.ts";
import type { PageCodeCheck, PageCodeStore } from "./approvals.ts";
import { recordGatePass, type GatePassed } from "./gates.ts";
import { passKeyMatches, spendPassKey } from "./pass-key.ts";

/**
 * Passing a review gate from its page (docs/notes/2026-10-30-pass-a-review-c6.md).
 * "Send and pass" with no code asks for one: the daemon mints it (PageCodeStore,
 * in memory only) and sends it to your notifications, which a worker cannot
 * read. The same button with the code typed in passes the gate here, with
 * every rule of a gate pass (recordGatePass): refused while a question is
 * open, bound to the reviewed HEAD, single use. The approval's channel is
 * page. A code that arrives is good for that one Send: a refusal before it is
 * checked drops it too, since the Send carrying it went through Lavish and
 * the poll output, both readable locally.
 *
 * One click (docs/notes/2026-11-05-one-click-approve-3y.md): Approve on a page
 * the daemon opened carries the tab's pass key instead (src/policy/pass-key.ts).
 * The same checks run, then the key against the gate's hash and the HEAD
 * against the one the review opened at. A key that arrives is spent, whatever
 * the outcome, except a wrong one (it reveals nothing, and spending it would
 * let a worker spoil your button). Plain code, no model.
 */

export type PagePass =
  | { outcome: "passed"; passed: GatePassed }
  | { outcome: "stale" | "late" }
  | { outcome: "questions_open"; open: string[] }
  | { outcome: "draft_changed"; task: string }
  | { outcome: "design_changed"; task: string }
  | { outcome: Exclude<PageCodeCheck, "ok"> }
  /** One click: the key is not the tab's (a worker's guess, or an old tab), none is live (spent, or the page was not opened with one), or the work moved since the review opened. */
  | { outcome: "wrong_key" | "no_key" | "key_moved" };

/** What a Send offered as proof that you pressed it: the tab's pass key, or a typed code. */
export type PageProof = { key: string } | { code: string };

function user(): string {
  return process.env.USER || process.env.LOGNAME || "you";
}

/** Pass the gate with the tab's pass key or a code typed into its page, or say why not. Call inside a transaction. */
export function passFromPage(db: Db, codes: PageCodeStore, gateId: string, proof: PageProof, head: string, now: number): PagePass {
  const row = db.query("SELECT g.run_id, g.state, g.pass_key_hash, g.pass_head, r.state AS run_state FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1 AND g.kind = 'review'").get(gateId) as {
    run_id: string;
    state: string;
    pass_key_hash: string | null;
    pass_head: string | null;
    run_state: string;
  } | null;
  const keyed = "key" in proof;
  // A right key that arrives is spent: the Send carrying it is in lavish's files now.
  const spend = (why: string) => {
    if (keyed && passKeyMatches(row?.pass_key_hash ?? null, proof.key)) spendPassKey(db, gateId, why, now);
    else if (!keyed) codes.drop(gateId);
  };
  const run = row ? getRunWithPolicy(db, row.run_id) : null;
  if (!row || !run || ["cleaned", "failed", "cancelled"].includes(row.run_state)) {
    spend("stale");
    return { outcome: "stale" };
  }
  const gate = openGate(db, run.id, "review");
  if (row.state !== "open" || !gate || gate.id !== gateId) {
    spend("late");
    return { outcome: "late" };
  }
  try {
    requireGateAnswered(db, gate);
  } catch (error) {
    if (!(error instanceof FlowrynError) || error.code !== "questions_open") throw error;
    spend("questions_open");
    const open = db.query("SELECT id FROM decisions WHERE gate_id = ?1 AND state = 'open' ORDER BY id").all(gateId) as { id: string }[];
    return { outcome: "questions_open", open: open.map((d) => d.id) };
  }
  try {
    requireDraftPageShown(run, gate);
  } catch (error) {
    if (!(error instanceof FlowrynError) || error.code !== "draft_changed") throw error;
    spend("draft_changed");
    return { outcome: "draft_changed", task: run.task_id };
  }
  try {
    requireDesignPinned(run, gate);
  } catch (error) {
    if (!(error instanceof FlowrynError) || error.code !== "design_changed") throw error;
    spend("design_changed");
    return { outcome: "design_changed", task: run.task_id };
  }
  if (keyed) return passWithKey(db, run, gate, row, proof.key, head, now);
  const checked = codes.check(gateId, proof.code, head, now);
  if (checked !== "ok") {
    // The outcome only, never the code typed.
    appendEvent(db, { source: "daemon", kind: "gate.page_pass_refused", runId: run.id, taskId: run.task_id, payload: { gate: gateId, why: checked }, ts: now });
    return { outcome: checked };
  }
  const passed = recordGatePass(db, run, gate, { channel: "page", actor: `${user()} (review page code)`, head }, now);
  return { outcome: "passed", passed };
}

/** The one-click checks, after the gate's own: the key, then the HEAD the review opened at. */
function passWithKey(db: Db, run: NonNullable<ReturnType<typeof getRunWithPolicy>>, gate: NonNullable<ReturnType<typeof openGate>>, row: { pass_key_hash: string | null; pass_head: string | null }, key: string, head: string, now: number): PagePass {
  const refuse = (why: "wrong_key" | "no_key" | "key_moved"): PagePass => {
    // The outcome only, never the key.
    appendEvent(db, { source: "daemon", kind: "gate.page_pass_refused", runId: run.id, taskId: run.task_id, payload: { gate: gate.id, why }, ts: now });
    return { outcome: why };
  };
  if (row.pass_key_hash === null) return refuse("no_key");
  if (!passKeyMatches(row.pass_key_hash, key)) return refuse("wrong_key");
  if (row.pass_head === null || row.pass_head !== head) {
    spendPassKey(db, gate.id, "key_moved", now);
    return refuse("key_moved");
  }
  spendPassKey(db, gate.id, "passed", now);
  const passed = recordGatePass(db, run, gate, { channel: "page", actor: `${user()} (review page, one click)`, head }, now);
  return { outcome: "passed", passed };
}
