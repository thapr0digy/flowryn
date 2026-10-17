import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openUserActed } from "../../src/attention/follow-up.ts";
import { openItem, type ItemKind } from "../../src/attention/items.ts";
import { carry } from "../../src/attention/presentations.ts";
import { composeDigest, digestCandidates, followUpBatch, followUpWakeLine, isFollowUpWake, isWakePrompt, P0_LINE_MAX, rewakeLine } from "../../src/attention/router.ts";
import { inertAttention } from "../../src/attention/services.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_LEADER_TIMING, leaderTiming } from "../../src/config/leader.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { leaderPush } from "../../src/leader/hooks.ts";
import { composerText, LeaderRewake, rewakeBlocker, typedText, type RewakeRuntime } from "../../src/leader/rewake.ts";
import { rewakeState, wakeBlockedLine } from "../../src/leader/wake-state.ts";
import { claim, getSession, openSession, type LeaderSessionRow } from "../../src/lease/lease.ts";
import { landRun } from "../../src/lifecycle/landing.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import type { PaneProcesses } from "../../src/runtime/herdr/runtime.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

const GRACE = 1_000;
const PID = 4242;

let h: TestHome;
let db: Db;
let clock: number;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  clock = Date.now();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function open(kind: ItemKind, line: string, opts: { task?: string; at?: number } = {}): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
    return openItem(db, { kind, eventSeq: event.seq, line, taskId: opts.task ?? null, now: opts.at ?? clock });
  });
}

/** A lease-holding leader session, idle, with you inactive: what a waiter would wake. */
function holder(fields: Partial<LeaderSessionRow> = {}, harness: "claude" | "pi" = "claude"): LeaderSessionRow {
  return tx(db, () => {
    const { session } = openSession(db, { harness, pane: "p1", cwd: "/x", now: clock - 60_000 });
    claim(db, session, "vacant", clock - 60_000);
    const set = { proc_pid: PID, user_inactive_since: clock - 120_000, last_event_at: clock - 60_000, has_ui: 1, ...fields } as Record<string, unknown>;
    const keys = Object.keys(set);
    db.query(`UPDATE leader_sessions SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE session_id = ?1`).run(session, ...(keys.map((k) => set[k]) as (string | number | null)[]));
    return getSession(db, session)!;
  });
}

const pushCtx = () => ({ db, attention: inertAttention(), config: () => parseConfig("", h.home) });

describe("leader follow-ups: your own actions wake the leader", () => {
  test("cause 1: a user_acted item is pushed through the waiter to an idle leader with the user inactive, once", () => {
    const s = holder();
    const id = open("user_acted", "The user approved merging web (t1); merge it: flowryn merge t1", { task: "t1" });
    const { push } = leaderPush(pushCtx(), s, clock);
    expect(push).toMatchObject({ kind: "follow_up", mode: "waiter" });
    expect(push!.items.map((i) => i.id)).toEqual([id]);
    // The waiter carries it; no second push takes it again.
    tx(db, () => carry(db, { itemId: id, session: s.session_id, turn: s.turn_no + 1, path: "waiter", now: clock }));
    expect(leaderPush(pushCtx(), s, clock).push).toBeNull();
  });

  test("with the user active, nothing is pushed and the follow-up tops the next digest's P1 lines", () => {
    const s = holder({ user_inactive_since: null });
    open("pr_ready", "an older PR waits", { at: clock - 60_000 });
    const acted = open("user_acted", "The user declined t2", { at: clock });
    expect(leaderPush(pushCtx(), s, clock).push).toBeNull();
    const digest = composeDigest(digestCandidates(db, s.session_id, clock, DEFAULT_LEADER_TIMING.age_ms))!;
    expect(digest.shown[0]!.id).toBe(acted);
  });

  test("several actions inside one wait go in one push, at most four, oldest first", () => {
    const s = holder();
    const ids = [1, 2, 3, 4, 5].map((n) => open(n % 2 ? "user_acted" : "landed", `item ${n}`, { at: clock + n }));
    const batch = followUpBatch(db, s.session_id)!;
    expect(batch.items.map((i) => i.id)).toEqual(ids.slice(0, 4));
    expect(batch.more).toBe(1);
    const line = followUpWakeLine(batch.items);
    expect(line).toBe(`Flowryn follow-up [${ids.slice(0, 4).join(",")}]: the user acted outside this session (2); 2 merges landed. Details: flowryn fleet`);
    expect(isWakePrompt(line) && isFollowUpWake(line)).toBe(true);
  });

  test("a review-page pass request reads as one in the wake line, never as a landed merge", () => {
    expect(followUpWakeLine([{ id: "i7", kind: "pass_requested" }])).toBe("Flowryn follow-up [i7]: a review pass was requested. Details: flowryn fleet");
    expect(followUpWakeLine([{ id: "i7", kind: "pass_requested" }, { id: "i8", kind: "landed" }, { id: "i9", kind: "pass_requested" }])).toBe(
      "Flowryn follow-up [i7,i8,i9]: a merge landed; 2 review passes were requested. Details: flowryn fleet",
    );
  });

  test("a P0 goes first; follow-ups use the P0 hourly budget, never a loop", () => {
    const s = holder();
    open("user_acted", "acted");
    const p0 = open("failure_needs_you", "broken");
    expect(leaderPush(pushCtx(), s, clock).push).toMatchObject({ kind: "p0", items: [{ id: p0 }] });
    tx(db, () => carry(db, { itemId: p0, session: s.session_id, turn: s.turn_no + 1, path: "waiter", now: clock }));
    expect(leaderPush({ ...pushCtx(), attention: inertAttention({ notify: () => ({ ...inertAttention().notify(), max_triggered_turns_per_hour: 1 }) }) }, s, clock).push).toBeNull();
  });

  test("assumption: only the user's own actions open one; the leader's never do", () => {
    const leader = tx(db, () => openUserActed(db, "leader", { action: "merge_approved", taskId: "t1", runId: null, line: "x", now: clock }));
    expect(leader).toBeNull();
    const first = tx(db, () => openUserActed(db, "human", { action: "merge_approved", taskId: "t1", runId: null, line: "approved", now: clock }));
    const second = tx(db, () => openUserActed(db, "human", { action: "declined", taskId: "t1", runId: null, line: "declined", now: clock }));
    const stillOpen = db.query("SELECT id FROM items WHERE kind = 'user_acted' AND state = 'open'").all() as { id: string }[];
    expect(stillOpen.map((r) => r.id)).toEqual([second!]);
    expect(first).not.toBe(second);
  });

  test("assumption: a landing the leader's own merge proved opens nothing; any other proof opens one landed item", () => {
    seedRun(h, "t-r1", "r1");
    seedRun(h, "t-r2", "r2");
    tx(db, () => db.query("UPDATE runs SET state = 'merging'").run());
    tx(db, () => landRun(db, getRunWithPolicy(db, "r1")!, { mergeSha: "a".repeat(40), how: "merge", by: "leader" }, clock));
    tx(db, () => landRun(db, getRunWithPolicy(db, "r2")!, { mergeSha: "b".repeat(40), how: "merged_elsewhere", by: "other" }, clock));
    const landed = db.query("SELECT run_id, line FROM items WHERE kind = 'landed'").all() as { run_id: string; line: string }[];
    expect(landed.map((r) => r.run_id)).toEqual(["r2"]);
    expect(landed[0]!.line).toContain("at bbbbbbbb");
  });
});

describe("the rewake line and Claude's composer", () => {
  test("the typed line is fixed: daemon-made ids only, a wake prompt, within the P0 line limit", () => {
    const line = rewakeLine(["i12", "i14"]);
    expect(line).toBe("Flowryn wake [i12,i14]: the leader's waiter had stopped; items wait. Details: flowryn fleet");
    expect(isWakePrompt(line)).toBe(true);
    const long = rewakeLine(Array.from({ length: 60 }, (_, n) => `i${1000 + n}`));
    expect(long.length).toBeLessThanOrEqual(P0_LINE_MAX);
    expect(long).toEndWith("Details: flowryn fleet");
  });

  const RULE = "─".repeat(60);
  test("assumption: an empty composer between two rules reads as empty", () => {
    expect(composerText(["● Done.", "", RULE, "> ", RULE, "  ? for shortcuts"].join("\n"))).toBe("");
    expect(composerText(["● Done.", "", RULE, ">", RULE, "  ⏵⏵ accept edits on"].join("\n"))).toBe("");
    expect(composerText(["╭" + RULE + "╮", "│ >                     │", "╰" + RULE + "╯"].join("\n"))).toBe("");
  });

  test("assumption: a draft, one line or several, reads as not empty", () => {
    expect(composerText([RULE, "> half a thought", RULE].join("\n"))).toBe("half a thought");
    expect(composerText([RULE, "> ", "  second line", RULE].join("\n"))).toBe("second line");
    expect(composerText(["╭" + RULE + "╮", "│ > draft text          │", "╰" + RULE + "╯"].join("\n"))).toBe("draft text");
  });

  // Claude Code 2.1.302's own bytes, read live through Herdr with --ansi (docs/notes/2026-10-17-leader-wakes-reliably-vn.md).
  const LIVE_RULE = `\u001b[0m\u001b[38;5;7m${"─".repeat(54)}\u001b[0m\r`;
  const LIVE_FOOTER = "  \u001b[0m\u001b[38;5;11m⏵⏵ auto mode on\u001b[0m\u001b[2m\u001b[38;5;7m (shift+tab to cycle)\u001b[0m";
  test("assumption (checked live): the empty composer's dim placeholder reads as empty; a typed draft does not", () => {
    const fresh = ["", LIVE_RULE, '❯ \u001b[0m\u001b[2mTry "edit items.ts to..."\u001b[0m\r', LIVE_RULE, LIVE_FOOTER].join("\n");
    expect(composerText(fresh)).toBe("");
    const afterTurn = ["", LIVE_RULE, "❯ \r", LIVE_RULE, LIVE_FOOTER].join("\n");
    expect(composerText(afterTurn)).toBe("");
    const draft = ["", LIVE_RULE, "❯ half a draft\r", LIVE_RULE, LIVE_FOOTER].join("\n");
    expect(composerText(draft)).toBe("half a draft");
  });

  test("dim text is dropped until reset; bold-off (22) ends it too; other escapes are removed", () => {
    expect(typedText("a\u001b[2mdim\u001b[22mb")).toBe("ab");
    expect(typedText("\u001b[0;2mdim\u001b[0mplain")).toBe("plain");
    expect(typedText("\u001b]0;title\u0007x\u001b[1Ay")).toBe("xy");
  });

  test("assumption: quoted '>' text in the transcript is not taken for the composer; no composer reads null", () => {
    expect(composerText(["> a quote in the answer", "more text", "● Done."].join("\n"))).toBeNull();
    expect(composerText("")).toBeNull();
    expect(composerText([RULE, "> a quote", "no closing rule"].join("\n"))).toBeNull();
  });
});

const EMPTY_SCREEN = ["● Done.", "─".repeat(40), "> ", "─".repeat(40), "  ? for shortcuts"].join("\n");

class StubRuntime implements RewakeRuntime {
  status: string | null = "idle";
  /** Statuses for the reads after the first, in order (the re-read right before the keys). */
  later: (string | null)[] = [];
  screen: string | null = EMPTY_SCREEN;
  /** Screens for the reads after the first, in order (the re-read right before the keys). */
  laterScreens: (string | null)[] = [];
  private screens = 0;
  pids: number[] = [PID];
  gone = false;
  typed: { pane: string; line: string }[] = [];
  private reads = 0;
  async processes(paneId: string): Promise<PaneProcesses | null> {
    if (this.gone) return null;
    return { paneId, shellPid: 1, foregroundGroup: this.pids[0] ?? null, processes: this.pids.map((pid) => ({ pid, name: "claude", argv0: "claude", argv: [], cwd: "/x" })) };
  }
  async agentStatus(): Promise<string | null> {
    this.reads += 1;
    return this.reads > 1 && this.later.length > 0 ? this.later.shift()! : this.status;
  }
  async readPane(): Promise<string | null> {
    this.screens += 1;
    return this.screens > 1 && this.laterScreens.length > 0 ? this.laterScreens.shift()! : this.screen;
  }
  async typeLine(pane: string, line: string): Promise<void> {
    this.typed.push({ pane, line });
  }
}

function rewaker(runtime: RewakeRuntime | null, opts: { startedAt?: number; attention?: ReturnType<typeof inertAttention> } = {}): LeaderRewake {
  const attention = opts.attention ?? inertAttention({ timing: () => ({ ...DEFAULT_LEADER_TIMING, waiter_grace_ms: GRACE }) });
  return new LeaderRewake({ db, attention, config: () => parseConfig("", h.home), runtime: () => runtime, now: () => clock, log: () => {}, startedAt: opts.startedAt ?? clock - 60_000 });
}

async function ticks(r: LeaderRewake, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await r.tick();
}

describe("rewake: a leader whose waiter is gone", () => {
  test("cause 2: no waiter and a due wake: after the grace and two ticks, the fixed line is typed once", async () => {
    const s = holder();
    const id = open("user_acted", "The user approved merging t1");
    const runtime = new StubRuntime();
    const r = rewaker(runtime);
    await r.tick();
    expect(runtime.typed).toEqual([]);
    await r.tick();
    expect(runtime.typed).toEqual([{ pane: "p1", line: rewakeLine([id]) }]);
    // No answer yet: no more keys, and the status says why.
    await ticks(r, 5);
    clock += GRACE * 5;
    await ticks(r, 3);
    expect(runtime.typed).toHaveLength(1);
    expect(wakeBlockedLine(db, s.session_id, clock)).toContain("got no answer");
    const events = db.query("SELECT kind FROM events WHERE kind LIKE 'leader.rewake%' ORDER BY seq").all() as { kind: string }[];
    expect(events.map((e) => e.kind)).toEqual(["leader.rewake_typed", "leader.rewake_blocked"]);
  });

  test("an answered rewake allows the next one only after the grace window", async () => {
    holder();
    open("failure_needs_you", "broken");
    const runtime = new StubRuntime();
    const r = rewaker(runtime);
    await ticks(r, 2);
    expect(runtime.typed).toHaveLength(1);
    // The leader answered (any hook event), the P0 stays unshown, and the waiter is still gone.
    tx(db, () => db.query("UPDATE leader_sessions SET last_event_at = ?1").run(clock + 1));
    clock += 10;
    await ticks(r, 3);
    expect(runtime.typed).toHaveLength(1);
    clock += GRACE;
    await ticks(r, 2);
    expect(runtime.typed).toHaveLength(2);
  });

  test("rewakes count against the P0 hourly budget", async () => {
    holder();
    open("failure_needs_you", "broken");
    const runtime = new StubRuntime();
    const attention = inertAttention({ timing: () => ({ ...DEFAULT_LEADER_TIMING, waiter_grace_ms: GRACE }), notify: () => ({ ...inertAttention().notify(), max_triggered_turns_per_hour: 1 }) });
    const r = rewaker(runtime, { attention });
    await ticks(r, 2);
    tx(db, () => db.query("UPDATE leader_sessions SET last_event_at = ?1").run(clock + 1));
    clock += GRACE * 2;
    await ticks(r, 4);
    expect(runtime.typed).toHaveLength(1);
  });

  test("rewakes for worker questions stop at [notify] max_question_wakes_per_hour while the waiter stays broken", async () => {
    holder();
    const runtime = new StubRuntime();
    const attention = inertAttention({
      timing: () => ({ ...DEFAULT_LEADER_TIMING, waiter_grace_ms: GRACE, question_batch_ms: 1 }),
      notify: () => ({ ...inertAttention().notify(), max_question_wakes_per_hour: 2, max_triggered_turns_per_hour: 10 }),
    });
    const r = rewaker(runtime, { attention });
    for (let n = 1; n <= 4; n++) {
      // A new question arrives; the leader answered the last rewake (a hook event) and settled the old questions.
      open("worker_question", `question ${n}`, { at: clock - 10 });
      await ticks(r, 3);
      tx(db, () => {
        db.query("UPDATE leader_sessions SET last_event_at = ?1").run(clock + 1);
        db.query("UPDATE items SET state = 'resolved' WHERE kind = 'worker_question'").run();
      });
      clock += GRACE * 2;
    }
    expect(runtime.typed).toHaveLength(2);
    const budgets = db.query("SELECT payload FROM events WHERE kind = 'leader.rewake_typed'").all() as { payload: string }[];
    expect(budgets.map((b) => (JSON.parse(b.payload) as { budget: string }).budget)).toEqual(["questions", "questions"]);
    // The P0 budget is untouched by them: a P0 still gets its rewake.
    open("failure_needs_you", "broken");
    await ticks(r, 3);
    expect(runtime.typed).toHaveLength(3);
  });

  test("restart: the grace counts from daemon start, so a reconnecting waiter takes the push and no keys are typed", async () => {
    const s = holder();
    open("user_acted", "acted");
    const runtime = new StubRuntime();
    const attention = inertAttention({ timing: () => ({ ...DEFAULT_LEADER_TIMING, waiter_grace_ms: GRACE }) });
    const r = rewaker(runtime, { startedAt: clock, attention });
    await ticks(r, 3);
    expect(runtime.typed).toEqual([]);
    // The waiter reconnects within the grace.
    attention.bus.register(s.session_id, "w1");
    void attention.bus.wait(s.session_id, "w1", 60_000);
    clock += GRACE * 2;
    await ticks(r, 3);
    expect(runtime.typed).toEqual([]);
    attention.bus.close();
  });

  test("no wake due: no keys, whatever the waiter", async () => {
    holder();
    const runtime = new StubRuntime();
    await ticks(rewaker(runtime), 3);
    expect(runtime.typed).toEqual([]);
  });

  test("the user active: nothing is due, so no keys", async () => {
    holder({ user_inactive_since: null });
    open("user_acted", "acted");
    const runtime = new StubRuntime();
    await ticks(rewaker(runtime), 3);
    expect(runtime.typed).toEqual([]);
  });

  const refusals: [string, (rt: StubRuntime) => void, string][] = [
    ["Herdr reads blocked (a dialog)", (rt) => (rt.status = "blocked"), "Herdr reads the leader blocked"],
    ["Herdr reads working", (rt) => (rt.status = "working"), "Herdr reads the leader working"],
    ["Herdr reads unknown", (rt) => (rt.status = null), "Herdr reads the leader unknown"],
    ["Herdr turns busy right before the keys", (rt) => (rt.later = ["working"]), "Herdr reads the leader working"],
    ["a draft typed between the composer read and the keys", (rt) => (rt.laterScreens = [EMPTY_SCREEN.replace("> ", "> just typed")]), "a draft is in the leader's composer"],
    ["a draft in the composer", (rt) => (rt.screen = EMPTY_SCREEN.replace("> ", "> half typed")), "a draft is in the leader's composer"],
    ["no composer on the screen", (rt) => (rt.screen = "just output"), "cannot read the leader's composer"],
    ["a dialog question on the screen", (rt) => (rt.screen = `Do you want to proceed?\n${EMPTY_SCREEN}`), "a dialog is open"],
    ["the pane runs another process", (rt) => (rt.pids = [999]), "does not run this leader's process"],
    ["the pane is gone", (rt) => (rt.gone = true), "pane is gone"],
  ];
  for (const [name, arrange, reason] of refusals) {
    test(`refused: ${name}`, async () => {
      const s = holder();
      open("user_acted", "acted");
      const runtime = new StubRuntime();
      arrange(runtime);
      // The second tick is the first that may type: it reads Herdr and refuses.
      await ticks(rewaker(runtime), 2);
      expect(runtime.typed).toEqual([]);
      expect(rewakeState(db, s.session_id).reason).toContain(reason);
    });
  }

  test("refused before any Herdr read: no pane, Pi, no process, no Herdr; a live waiter means nothing is wrong", async () => {
    const cases: [Partial<LeaderSessionRow>, "claude" | "pi", boolean, string | null][] = [
      [{ pane_id: null }, "claude", true, "the leader runs outside Herdr"],
      [{}, "pi", true, "the Pi leader's extension is not polling"],
      [{ proc_pid: null }, "claude", true, "the leader's process is not known"],
      [{}, "claude", false, "Herdr is not reachable"],
    ];
    for (const [fields, harness, herdr, reason] of cases) {
      const s = holder(fields, harness);
      expect(rewakeBlocker({ session: s, herdr, lastTyped: null, now: clock })).toContain(reason!);
    }
    const s = holder();
    open("user_acted", "acted");
    const attention = inertAttention({ timing: () => ({ ...DEFAULT_LEADER_TIMING, waiter_grace_ms: GRACE }) });
    attention.bus.register(s.session_id, "w1");
    void attention.bus.wait(s.session_id, "w1", 60_000);
    const runtime = new StubRuntime();
    await ticks(rewaker(runtime, { attention }), 3);
    expect(runtime.typed).toEqual([]);
    attention.bus.close();
  });

  test("a leader outside Herdr: status, fleet and the briefing say plainly that it cannot be woken; one event per reason change", async () => {
    const s = holder({ pane_id: null });
    open("user_acted", "acted");
    const r = rewaker(new StubRuntime());
    await ticks(r, 4);
    expect(wakeBlockedLine(db, s.session_id, clock)).toMatch(/^Leader wake: not possible since \d\d:\d\d: the leader runs outside Herdr; type to it\.$/);
    const blocked = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'leader.rewake_blocked'").get() as { n: number };
    expect(blocked.n).toBe(1);
    // The wake is no longer due (the item was dismissed): the line goes away.
    tx(db, () => db.query("UPDATE items SET state = 'resolved'").run());
    await r.tick();
    expect(wakeBlockedLine(db, s.session_id, clock)).toBeNull();
  });

  test("[leader] waiter_grace_ms is a setting, default 30 s", () => {
    expect(DEFAULT_LEADER_TIMING.waiter_grace_ms).toBe(30_000);
    expect(leaderTiming(parseConfig("[leader]\nwaiter_grace_ms = 5000\n", h.home)).waiter_grace_ms).toBe(5_000);
  });
});
