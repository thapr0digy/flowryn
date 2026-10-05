import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import { leaderTiming } from "../config/leader.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { getRun, isTerminal } from "../lifecycle/runs.ts";
import { createSteer } from "../lifecycle/steers.ts";
import { composeBriefing, readOnlyBanner } from "./briefing.ts";

/**
 * `flowryn brief`: the briefing on demand, as a session start would show it.
 * A read: it records no presentation and does not use up the morning section.
 */
const brief: VerbSpec = {
  name: "brief",
  summary: "The briefing: what needs you, what is in flight, what is due",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx) {
    if (ctx.caller.role === "reader") return { data: { briefing: [readOnlyBanner(ctx.db)] }, hints: ["flowryn leader claim"] };
    const briefing = composeBriefing(ctx.db, {
      session: ctx.caller.role === "leader" ? (ctx.caller.session ?? null) : null,
      now: ctx.now,
      morningHour: ctx.config.morning_hour,
      ageMs: leaderTiming(ctx.config).age_ms,
      markMorning: false,
    });
    return { data: { briefing: briefing.text.split("\n") }, hints: ["flowryn fleet", "flowryn show <id>"] };
  },
};

interface ItemRef {
  id: string;
  class: string;
  state: string;
  kind: string;
  task_id: string | null;
  run_id: string | null;
  decision_id: string | null;
}

interface DecisionRef {
  id: string;
  task_id: string;
  run_id: string | null;
  blocking: number;
  state: string;
}

/**
 * `flowryn dismiss <item>`: you decided an item needs nothing more (design
 * section 9). A worker's question is closed as dismissed, its captain hold
 * lifted, and the worker told to decide for itself.
 */
const dismiss: VerbSpec = {
  name: "dismiss",
  summary: "Close an item that needs nothing more; a dismissed question tells its worker to decide",
  positionals: [{ name: "item", required: true, help: "item id, such as i41" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const id = stringArg(args, "item")!;
    const item = ctx.db.query("SELECT id, class, state, kind, task_id, run_id, decision_id FROM items WHERE id = ?1").get(id) as ItemRef | null;
    if (!item) throw new FlowrynError("not_found", `no item ${id}`, "flowryn fleet");
    if (item.state !== "open" && item.state !== "presented") throw new FlowrynError("bad_args", `item ${id} is already ${item.state}`);
    const gateQuestion = item.decision_id ? (ctx.db.query("SELECT id, gate_id FROM decisions WHERE id = ?1 AND gate_id IS NOT NULL").get(item.decision_id) as { id: string; gate_id: string } | null) : null;
    if (gateQuestion) {
      throw new FlowrynError(
        "bad_args",
        `item ${id} is review question ${gateQuestion.id} of gate ${gateQuestion.gate_id}: only the user answers it`,
        `relay the user's answer: flowryn decide ${gateQuestion.id} <choice> --by captain; or send the review back (flowryn gate changes), which closes it`,
      );
    }
    const now = ctx.now();
    ctx.db.query("UPDATE items SET state = 'dismissed', resolved_by = ?2, resolved_at = ?3 WHERE id = ?1").run(id, `dismissed by ${ctx.caller.role}`, now);
    appendEvent(ctx.db, { source: "cli", kind: "item.dismissed", runId: item.run_id, taskId: item.task_id, payload: { item: id, kind: item.kind, by: ctx.caller.role } });
    let steer: string | null = null;
    const decision = item.decision_id ? (ctx.db.query("SELECT id, task_id, run_id, blocking, state FROM decisions WHERE id = ?1").get(item.decision_id) as DecisionRef | null) : null;
    if (decision && decision.state === "open") {
      ctx.db.query("UPDATE decisions SET state = 'dismissed', answered_via = ?2, answered_at = ?3 WHERE id = ?1").run(decision.id, ctx.caller.role, now);
      appendEvent(ctx.db, { source: "cli", kind: "decision.dismissed", runId: decision.run_id, taskId: decision.task_id, payload: { decision: decision.id, by: ctx.caller.role } });
      if (decision.blocking) recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: decision.task_id, positional: [decision.task_id], now });
      const run = decision.run_id ? getRun(ctx.db, decision.run_id) : null;
      if (run && !isTerminal(run.state)) {
        steer = createSteer(ctx.db, run, `Your question ${decision.id} was dismissed: no answer is coming. Decide yourself and carry on.`, now, decision.id).id;
      }
    }
    return { data: { item: id, state: "dismissed", decision: decision?.id ?? "-", steer: steer ?? "-", run: decision?.run_id ?? "-" } };
  },
  async settle(ctx, result) {
    if (result.data.run !== "-") ctx.fleet.bus.notify(String(result.data.run));
    return result;
  },
};

export const ATTENTION_VERBS: VerbSpec[] = [brief, dismiss];
