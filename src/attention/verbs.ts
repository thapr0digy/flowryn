import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import { awayConfig, leaderTiming } from "../config/leader.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { getRun, isTerminal } from "../lifecycle/runs.ts";
import { createSteer } from "../lifecycle/steers.ts";
import { AWAY_MAX_MS, clockLabel, endAway, expireAway, getAway, lastAway, parseUntil, startAway, takePendingBrief } from "./away.ts";
import { composeBriefing, composeReturnBrief, readOnlyBanner } from "./briefing.ts";

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

/** `back` reprints the last return brief for this long after away ended. */
const REPRINT_MS = 24 * 60 * 60_000;

/**
 * `flowryn away [--until <time>] [--body-file -]`: you are away (autonomy
 * spec 2). Every new item that needs you wakes the leader, so it reaches you
 * in the remote-control chat. Run again to extend it. Delivery only: it
 * grants nothing. The leader runs it only on your words.
 */
const away: VerbSpec = {
  name: "away",
  summary: "Say you are away: items that need you wake the leader until you are back or it expires",
  positionals: [],
  flags: {
    until: { type: "string", help: "when it ends: HH:MM, +8h, +90m or YYYY-MM-DD HH:MM (default: [away] default_hours)", placeholder: "time" },
    "body-file": { type: "string", help: "the user's words, from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const now = ctx.now();
    const cfg = awayConfig(ctx.config());
    const text = stringArg(args, "until");
    const until = text === undefined ? now + cfg.default_hours * 60 * 60_000 : parseUntil(text, now);
    if (until === null) throw new FlowrynError("bad_args", `--until ${text} is not a time`, "HH:MM, +8h, +90m or YYYY-MM-DD HH:MM");
    if (until <= now) throw new FlowrynError("bad_args", `--until ${text} is in the past`);
    if (until - now > AWAY_MAX_MS) throw new FlowrynError("bad_args", `--until ${text} is more than 7 days away`);
    const words = stringArg(args, "body") ?? null;
    const { posture, extended } = startAway(ctx.db, { until, words, by: ctx.caller.role, now });
    return {
      data: { away: extended ? "extended" : "started", since: clockLabel(posture.since, now), until: clockLabel(posture.until, now), words: posture.words ?? "-", wake_cap_per_hour: cfg.max_wakes_per_hour },
      hints: ["flowryn back ends it and prints the return brief"],
    };
  },
  async settle(ctx, result) {
    // Idle waiters look again: an item already waiting may now wake the leader.
    ctx.attention.bus.notifyAll();
    return result;
  },
};

/**
 * `flowryn back`: away ends, and you get the return brief. With no away to
 * end, it reprints the last brief for a day after away ended.
 */
const back: VerbSpec = {
  name: "back",
  summary: "Say you are back: away ends and the return brief prints",
  positionals: [],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx) {
    const now = ctx.now();
    expireAway(ctx.db, now);
    const endedNow = getAway(ctx.db, now) !== null;
    const ended = endedNow ? endAway(ctx.db, "back", now) : lastAway(ctx.db);
    if (!ended || now - ended.ended_at > REPRINT_MS) throw new FlowrynError("not_away", "you are not away", "flowryn away [--until <time>]");
    // An expiry's brief printed here does not ride the next message as well.
    takePendingBrief(ctx.db, now);
    const text = composeReturnBrief(ctx.db, { since: ended.since, until: ended.ended_at, now, ageMs: leaderTiming(ctx.config()).age_ms, reason: ended.reason });
    return { data: { away: endedNow ? "ended" : `already ended (${ended.reason})`, brief: text.split("\n") } };
  },
};

export const ATTENTION_VERBS: VerbSpec[] = [brief, dismiss, away, back];
