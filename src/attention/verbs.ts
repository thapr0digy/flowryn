import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type Args, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import type { FlowrynConfig } from "../config/config.ts";
import type { Db } from "../db/db.ts";
import { listProjects } from "../lifecycle/projects.ts";
import { AUTONOMY_MAX_MS, autonomyRef, awayRef, canonicalTerms, checkTerms, endAutonomy, projectsOf, stampOf, startAutonomy, type AutonomyRow, type AutonomyTerms } from "../policy/autonomy.ts";
import { AUTONOMY_SUMMARY } from "../policy/chat-questions.ts";
import { claudeLeaderSession, GRANT_ARG, grantActor, prepareCaptainGrant, takeGrant } from "../policy/grants.ts";
import { verifyConfig } from "../verify/config.ts";
import { PARKING_CLASSES } from "./autonomy-pass.ts";
import { awayConfig, leaderTiming } from "../config/leader.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { CI_WAIT_ORIGIN } from "../lifecycle/ci-wait.ts";
import { getRun, isTerminal } from "../lifecycle/runs.ts";
import { createSteer } from "../lifecycle/steers.ts";
import { settleAutonomyParked } from "./items.ts";
import { AWAY_MAX_MS, CHAT_AWAY_BY, clockLabel, endAway, expireAway, getAway, lastAway, parseUntil, startAway, takePendingBrief, type AwayPosture } from "./away.ts";
import { composeBriefing, composeReturnBrief, readOnlyBanner } from "./briefing.ts";
import type { CommandMessage, CommandOutcome } from "./notify.ts";
import { lensFor, projectRefScope, requireInScope } from "../leader/scope.ts";

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
  scope: { kind: "list" },
  read(ctx) {
    if (ctx.caller.role === "reader") return { data: { briefing: [readOnlyBanner(ctx.db, ctx.caller.session ?? "")] }, hints: ["flowryn leader claim"] };
    const briefing = composeBriefing(ctx.db, {
      session: ctx.caller.role === "leader" ? (ctx.caller.session ?? null) : null,
      now: ctx.now,
      morningHour: ctx.config.morning_hour,
      ageMs: leaderTiming(ctx.config).age_ms,
      markMorning: false,
      config: ctx.config,
      lens: lensFor(ctx.db, ctx.config, ctx.caller.scope),
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
  origin: string | null;
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
  scope: { kind: "ref", arg: "item" },
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
    const decision = item.decision_id ? (ctx.db.query("SELECT id, task_id, run_id, blocking, state, origin FROM decisions WHERE id = ?1").get(item.decision_id) as DecisionRef | null) : null;
    if (decision && decision.state === "open") {
      ctx.db.query("UPDATE decisions SET state = 'dismissed', answered_via = ?2, answered_at = ?3 WHERE id = ?1").run(decision.id, ctx.caller.role, now);
      appendEvent(ctx.db, { source: "cli", kind: "decision.dismissed", runId: decision.run_id, taskId: decision.task_id, payload: { decision: decision.id, by: ctx.caller.role } });
      if (decision.blocking) recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: decision.task_id, positional: [decision.task_id], now });
      if (decision.run_id) settleAutonomyParked(ctx.db, decision.run_id, `decision.dismissed ${decision.id}`, now);
      const run = decision.run_id ? getRun(ctx.db, decision.run_id) : null;
      // The CI-wait watchdog's question was not the worker's: nothing to tell it (the watchdog asks again later).
      if (run && !isTerminal(run.state) && decision.origin !== CI_WAIT_ORIGIN) {
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
 *
 * `--autonomous [--projects a,b]` also grants unattended mode
 * (docs/notes/2026-11-05-unattended-mode-one-9e.md): the standing approval
 * src/policy/autonomy.ts records. Only a human channel makes one: in your
 * terminal the CLI runs `autonomy.begin` / `autonomy.confirm` (a /dev/tty
 * code); the Claude leader needs your answer to the binding chat question for
 * exactly these terms (`flowryn chat-question autonomy:<projects>@<until>`),
 * a grant only its own hooks mint. Nothing else can start or extend it.
 */
const away: VerbSpec = {
  name: "away",
  summary: "Say you are away: items that need you wake the leader until you are back or it expires; --autonomous also grants unattended mode",
  positionals: [],
  flags: {
    until: { type: "string", help: "when it ends: HH:MM, +8h, +90m or YYYY-MM-DD HH:MM (default: [away] default_hours)", placeholder: "time" },
    "body-file": { type: "string", help: "the user's words, from a file or - for stdin", fileFor: "body" },
    autonomous: { type: "boolean", help: "also grant unattended mode (at most 16h): in your terminal it asks for a code; the Claude leader needs the user's chat answer" },
    projects: { type: "string", help: "with --autonomous: the projects it covers (default: every project with verify steps you see)", placeholder: "a,b" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  // Your posture, for every scope; the words are yours and name no task. --autonomous checks each project's scope itself.
  scope: { kind: "none" },
  async prepare(ctx, args): Promise<AwayPrepared> {
    if (!boolArg(args, "autonomous")) {
      if (stringArg(args, "projects") !== undefined) throw new FlowrynError("bad_args", "--projects belongs to --autonomous");
      return { autonomy: null, chat: chatAwayGrant(ctx, args) };
    }
    const now = ctx.now();
    const terms = autonomyTermsOf(ctx, args, now);
    const ref = autonomyRef(terms);
    if (ctx.caller.role !== "leader") {
      throw new FlowrynError("approval_required", "unattended mode starts only from your own terminal (a /dev/tty code) or your chat answer to the Claude leader", "in your terminal: flowryn away --autonomous");
    }
    if (!claudeLeaderSession(ctx)) throw new FlowrynError("approval_required", "only the Claude leader can relay the user's chat answer for unattended mode", "the user runs, in their own terminal: flowryn away --autonomous");
    const grant = prepareCaptainGrant(ctx, args, { item: ref, choice: "start" }, null);
    if (!grant) throw new FlowrynError("approval_required", `unattended mode needs the user's own answer for ${ref}`, `ask the user: flowryn chat-question ${ref} (then flowryn grant use <grant>)`);
    return { autonomy: { projects: terms.projects, until: terms.until, grant } };
  },
  apply(ctx, args, prepared) {
    const now = ctx.now();
    const cfg = awayConfig(ctx.config());
    const autonomy = (prepared as AwayPrepared | undefined)?.autonomy ?? null;
    if (boolArg(args, "autonomous") && !autonomy) throw new FlowrynError("approval_required", "unattended mode needs the user's own answer", "in your terminal: flowryn away --autonomous");
    if (autonomy) {
      const terms = { projects: autonomy.projects, until: autonomy.until };
      checkTerms(ctx.db, ctx.config(), terms, now);
      const used = takeGrant(ctx.db, autonomy.grant, `away --autonomous ${autonomyRef(terms)}`, now);
      if (used.item !== autonomyRef(terms) || used.action !== "autonomy") throw new FlowrynError("approval_required", `grant ${used.id} is for ${used.item}, not ${autonomyRef(terms)}`);
      const words = [used.words?.trim() ?? "", (stringArg(args, "body") ?? "").trim()].filter((w) => w.length > 0).join(" / ") || null;
      const row = startAutonomy(ctx.db, { terms, channel: "claude-chat", actor: grantActor(used), grantId: used.id, words, now });
      // The grant is the user's own chat answer, so the away it rides along with is theirs too.
      const posture = awayAlongside(ctx.db, row.expires_at, words, CHAT_AWAY_BY, now);
      return { data: autonomyStarted(row, posture, now), hints: ["flowryn back ends both and prints the return brief", "flowryn show autonomy"] };
    }
    const text = stringArg(args, "until");
    const until = text === undefined ? now + cfg.default_hours * 60 * 60_000 : parseUntil(text, now);
    if (until === null) throw new FlowrynError("bad_args", `--until ${text} is not a time`, "HH:MM, +8h, +90m or YYYY-MM-DD HH:MM");
    if (until <= now) throw new FlowrynError("bad_args", `--until ${text} is in the past`);
    if (until - now > AWAY_MAX_MS) throw new FlowrynError("bad_args", `--until ${text} is more than 7 days away`);
    const chat = (prepared as AwayPrepared | undefined)?.chat ?? null;
    let words = stringArg(args, "body") ?? null;
    let by: string = ctx.caller.role;
    if (chat) {
      // The user's own chat answer for exactly this end time (docs/notes/2026-11-08-unattended-loops-answer-4y.md).
      const used = takeGrant(ctx.db, chat.grant, `away ${chat.ref}`, now);
      if (used.item !== awayRef(until) || used.action !== "away") throw new FlowrynError("approval_required", `grant ${used.id} is for ${used.item}, not ${awayRef(until)}`);
      words = [used.words?.trim() ?? "", (words ?? "").trim()].filter((w) => w.length > 0).join(" / ") || null;
      by = CHAT_AWAY_BY;
    }
    const { posture, extended } = startAway(ctx.db, { until, words, by, now });
    const hints = ["flowryn back ends it and prints the return brief"];
    // A leader's own away delivers items but decides nothing for the user; their chat answer makes it theirs.
    if (by === "leader") hints.push(`nothing is decided for the user under a leader's away; to let Flowryn decide while they are away, ask: flowryn chat-question ${awayRef(posture.until)} (then flowryn grant use <grant>)`);
    return {
      data: { away: extended ? "extended" : "started", since: clockLabel(posture.since, now), until: clockLabel(posture.until, now), words: posture.words ?? "-", by: posture.by, wake_ceiling_per_hour: leaderTiming(ctx.config()).wake_ceiling_per_hour },
      hints,
    };
  },
  async settle(ctx, result) {
    // Idle waiters look again: an item already waiting may now wake the leader.
    ctx.attention.bus.notifyAll();
    return result;
  },
};

interface AwayPrepared {
  autonomy: { projects: string[]; until: number; grant: string } | null;
  /** A plain away on the user's chat answer: the grant for `away:<until>`. */
  chat?: { grant: string; ref: string } | null;
}

/**
 * A plain away the Claude leader starts on the user's chat answer: the grant for exactly this end
 * time (`away:<YYYY-MM-DDTHH:MM>`), checked against Claude's transcript, or null (another caller,
 * an end time that does not parse, or no answer yet: the away is then the leader's own).
 */
function chatAwayGrant(ctx: HandlerCtx, args: Args): { grant: string; ref: string } | null {
  if (!claudeLeaderSession(ctx)) {
    if (stringArg(args, GRANT_ARG)) throw new FlowrynError("role_refused", "only the Claude leader session that asked uses a chat-answer grant");
    return null;
  }
  const text = stringArg(args, "until");
  if (text === undefined) return null;
  const until = parseUntil(text, ctx.now());
  if (until === null) return null;
  const ref = awayRef(until);
  const grant = prepareCaptainGrant(ctx, args, { item: ref, choice: "start" }, null);
  return grant ? { grant, ref } : null;
}

/**
 * The terms `--until` and `--projects` name, checked: the end at most 16h ahead (default
 * `[away] default_hours`, capped), each project in the caller's scope with verify steps
 * (default: every such project the caller sees).
 */
function autonomyTermsOf(ctx: Pick<HandlerCtx, "db" | "config" | "caller">, args: Args, now: number): AutonomyTerms {
  const config = ctx.config();
  const text = stringArg(args, "until");
  const until = text === undefined ? now + Math.min(awayConfig(config).default_hours * 60 * 60_000, AUTONOMY_MAX_MS) : parseUntil(text, now);
  if (until === null) throw new FlowrynError("bad_args", `--until ${text} is not a time`, "HH:MM, +8h, +90m or YYYY-MM-DD HH:MM");
  const named = stringArg(args, "projects");
  const lens = lensFor(ctx.db, config, ctx.caller.scope);
  let projects: string[];
  if (named !== undefined) {
    projects = named.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    for (const p of projects) requireInScope(config, ctx.caller, projectRefScope(ctx.db, config, p), `project ${p}`);
  } else {
    projects = listProjects(ctx.db).filter((p) => lens.project(p.id) && hasVerifySteps(config, p.id)).map((p) => p.id);
  }
  const terms = canonicalTerms(projects, until);
  checkTerms(ctx.db, config, terms, now);
  return terms;
}

function hasVerifySteps(config: FlowrynConfig, projectId: string): boolean {
  try {
    return verifyConfig(config, projectId) !== null;
  } catch {
    return false;
  }
}

/** Away rides along with a grant: started, or extended to the grant's end if it ends sooner. Call inside a transaction. */
function awayAlongside(db: Db, until: number, words: string | null, by: string, now: number): AwayPosture {
  const current = getAway(db, now);
  return startAway(db, { until: current && current.until > until ? current.until : until, words, by, now }).posture;
}

function autonomyStarted(row: AutonomyRow, posture: AwayPosture, now: number): Record<string, unknown> {
  return {
    autonomy: row.id,
    projects: projectsOf(row).join(","),
    until: clockLabel(row.expires_at, now),
    away_until: clockLabel(posture.until, now),
    channel: row.channel,
    reserved: PARKING_CLASSES.join(","),
    words: row.words ?? "-",
  };
}

interface BeginPrepared {
  challenge: { id: string; code: string };
  terms: AutonomyTerms;
}

/**
 * `autonomy.begin` / `autonomy.confirm`: the terminal's two steps of `flowryn away
 * --autonomous` (src/cli/commands/away.ts), like `flowryn approve`: what you would grant,
 * and a code read back from /dev/tty. The challenge binds the exact terms and words shown.
 */
const autonomyBegin: VerbSpec = {
  name: "autonomy.begin",
  summary: "Start a /dev/tty grant of unattended mode: the terms you would grant, and the code to type back",
  positionals: [],
  flags: {
    until: { type: "string", help: "when it ends (at most 16h)" },
    projects: { type: "string", help: "the projects it covers" },
    "body-file": { type: "string", help: "your words", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["human"],
  // The reply carries the challenge code: never kept in the reply table.
  ephemeral: true,
  async prepare(ctx, args): Promise<BeginPrepared> {
    const now = ctx.now();
    const terms = autonomyTermsOf(ctx, args, now);
    const words = stringArg(args, "body") ?? null;
    const challenge = ctx.delivery.challenges.create({ task: "-", action: "autonomy", ref: autonomyRef(terms), head: "-", allowRed: null, channel: "cli-tty", autonomy: { ...terms, words } }, now);
    return { challenge: { id: challenge.id, code: challenge.code }, terms };
  },
  apply(ctx, _args, prepared) {
    const { challenge, terms } = prepared as BeginPrepared;
    const now = ctx.now();
    return { data: { challenge: challenge.id, code: challenge.code, projects: terms.projects.join(", "), until: stampOf(terms.until).replace("T", " "), in: clockLabel(terms.until, now), reserved: PARKING_CLASSES.join(", "), summary: AUTONOMY_SUMMARY } };
  },
};

const autonomyConfirm: VerbSpec = {
  name: "autonomy.confirm",
  summary: "Finish a /dev/tty grant of unattended mode: the code you typed back",
  positionals: [],
  flags: {
    challenge: { type: "string", help: "the challenge id" },
    code: { type: "string", help: "the code you typed" },
    actor: { type: "string", help: "who you are ($USER)" },
  },
  kind: "mutation",
  roles: ["human"],
  apply(ctx, args) {
    const now = ctx.now();
    const taken = ctx.delivery.challenges.take(stringArg(args, "challenge") ?? "", stringArg(args, "code") ?? "", now);
    if (taken === "unknown") throw new FlowrynError("challenge_failed", "no such challenge (a daemon restart forgets them)", "run flowryn away --autonomous again");
    if (taken === "expired") throw new FlowrynError("challenge_failed", "the challenge expired; nothing was granted", "run flowryn away --autonomous again");
    if (taken === "wrong") throw new FlowrynError("challenge_failed", "the code does not match; nothing was granted", "run flowryn away --autonomous again");
    if (taken.action !== "autonomy" || !taken.autonomy) throw new FlowrynError("challenge_failed", "that challenge does not start unattended mode; nothing was granted", "run flowryn away --autonomous again");
    const terms = { projects: taken.autonomy.projects, until: taken.autonomy.until };
    checkTerms(ctx.db, ctx.config(), terms, now);
    const actor = (stringArg(args, "actor") ?? "").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64) || "you";
    const row = startAutonomy(ctx.db, { terms, channel: "cli-tty", actor: `${actor} (your terminal)`, grantId: null, words: taken.autonomy.words, now });
    const posture = awayAlongside(ctx.db, row.expires_at, row.words, ctx.caller.role, now);
    return { data: autonomyStarted(row, posture, now), hints: ["flowryn back ends both and prints the return brief", "flowryn show autonomy"] };
  },
  async settle(ctx, result) {
    ctx.attention.bus.notifyAll();
    return result;
  },
};

/**
 * `flowryn back`: away ends, and you get the return brief. With no away to
 * end, it reprints the last brief for a day after away ended. It ends
 * unattended mode too.
 */
const back: VerbSpec = {
  name: "back",
  summary: "Say you are back: away and unattended mode end and the return brief prints",
  positionals: [],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  // The return brief it prints is filtered to the caller's scope.
  scope: { kind: "list" },
  apply(ctx) {
    const now = ctx.now();
    expireAway(ctx.db, now);
    const autonomy = endAutonomy(ctx.db, now);
    const endedNow = getAway(ctx.db, now) !== null;
    const ended = endedNow ? endAway(ctx.db, "back", now) : lastAway(ctx.db);
    if (!ended || now - ended.ended_at > REPRINT_MS) {
      if (autonomy) return { data: { away: "not away", autonomy: `${autonomy.id} ended (${autonomy.end_reason ?? "back"})` } };
      throw new FlowrynError("not_away", "you are not away", "flowryn away [--until <time>]");
    }
    // An expiry's brief printed here does not ride the next message as well.
    takePendingBrief(ctx.db, now);
    const text = composeReturnBrief(ctx.db, { since: ended.since, until: ended.ended_at, now, ageMs: leaderTiming(ctx.config()).age_ms, reason: ended.reason, lens: lensFor(ctx.db, ctx.config(), ctx.caller.scope) });
    return { data: { away: endedNow ? "ended" : `already ended (${ended.reason})`, ...(autonomy ? { autonomy: `${autonomy.id} ended (${autonomy.end_reason ?? "back"})` } : {}), brief: text.split("\n") } };
  },
};

/**
 * `flowryn notify test` (your terminal only): run `[notify] command` once
 * with a sample, in the daemon, so it gets the environment, cwd and deadline
 * a real send gets (docs/notes/2026-10-25-notifications-that-reach-6f.md).
 */
const notifyTest: VerbSpec = {
  name: "notify test",
  summary: "Run [notify] command once with a sample notification, the way the daemon sends one",
  positionals: [],
  flags: {},
  kind: "mutation",
  roles: ["human"],
  replyMs: 120_000,
  async prepare(ctx) {
    if (!ctx.attention.notifyTest) throw new FlowrynError("not_supported", "this daemon has no notification pump");
    return ctx.attention.notifyTest();
  },
  apply(ctx, _args, prepared) {
    // The pump recorded the run (notification.command) when it ended, so a failure below is kept.
    const { message, outcome } = prepared as { message: CommandMessage; outcome: CommandOutcome };
    const result = outcome.timedOut ? "timed out" : outcome.code === 0 ? "ok" : `exit ${outcome.code}`;
    if (outcome.code !== 0) throw new FlowrynError("notify_failed", `the notify command failed: ${result}${outcome.stderr ? `: ${outcome.stderr}` : ""}`, "it runs as /bin/sh -c '<command>' with the daemon's environment: use full paths");
    return { data: { command: result, away: message.away ? "yes" : "no" }, hints: ["check that the sample reached you"] };
  },
};

export const ATTENTION_VERBS: VerbSpec[] = [brief, dismiss, away, back, notifyTest, autonomyBegin, autonomyConfirm];
