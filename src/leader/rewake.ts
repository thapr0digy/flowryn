import type { AttentionServices } from "../attention/services.ts";
import { rewakeLine } from "../attention/router.ts";
import { clockLabel } from "../attention/away.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { getLease, getSession, type LeaderSessionRow } from "../lease/lease.ts";
import { settledStatus } from "../lifecycle/idle-carry.ts";
import { DIALOG_QUESTION } from "../lifecycle/prompt-wedge.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { leaderPush } from "./hooks.ts";
import { rewakeState, saveRewakeState } from "./wake-state.ts";

/**
 * The leader waiter fallback, the leader's counterpart of the workers'
 * idle-carry (src/lifecycle/idle-carry.ts). An idle Claude leader is woken
 * only through its asyncRewake waiter, which lives at most 8 h, is armed only
 * at SessionStart and Stop, and exits for good on a daemon upgrade. Once it
 * is gone, nothing wakes the leader until you type to it. So the attention
 * tick checks the lease holder: no waiter for [leader] waiter_grace_ms, over
 * at least two ticks, and a wake due (leaderPush would wake it now, within
 * the hourly budget), then the daemon types one fixed line into the leader's
 * pane. The turn it starts gets the items in its digest, and its Stop arms a
 * new waiter.
 *
 * Keys go only where they cannot land in a dialog or your draft: the pane is
 * in Flowryn's Herdr and runs the session's own process, Herdr reads it
 * settled ("idle" or "done") before and again right before the keys, the
 * screen shows no dialog, and the composer reads empty. An earlier rewake the
 * leader never answered (no hook event since) stops any more keys. Whenever a
 * wake is due and cannot be typed, the reason is kept (wake-state.ts) for
 * `leader status`, `fleet` and the briefing, with one event per change.
 */

/** Screen lines read to find the composer. */
const SCREEN_LINES = 40;

export type RewakeRuntime = Pick<HerdrRuntime, "processes" | "agentStatus" | "readPane" | "typeLine">;

export interface RewakeDeps {
  db: Db;
  attention: AttentionServices;
  config(): FlowrynConfig;
  runtime(): RewakeRuntime | null;
  now(): number;
  log(line: string): void;
  /** When this daemon started: a waiter not seen since counts as gone from here, so a reconnecting one takes the push. */
  startedAt: number;
}

const RULE = /^\s*[╭╰]?─{8,}[╮╯]?\s*$/;
const PROMPT = /^\s*│?\s*[>❯](?:\s(.*))?$/;
// oxlint-disable-next-line no-control-regex -- terminal escape sequences, read to be removed
const ESCAPE = /\u001b\[([0-9;?]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * A screen line as typed: escape codes removed, and with them any text drawn
 * dim (SGR 2). Claude draws the empty composer's placeholder ("Try ...") dim
 * and what you type plain (checked live, Claude Code 2.1.302).
 */
export function typedText(line: string): string {
  let out = "";
  let dim = false;
  let at = 0;
  for (const m of line.matchAll(ESCAPE)) {
    if (!dim) out += line.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[2] !== "m") continue;
    for (const code of (m[1] || "0").split(";")) {
      if (code === "" || code === "0" || code === "22") dim = false;
      else if (code === "2") dim = true;
    }
  }
  if (!dim) out += line.slice(at);
  return out.replace(/\r$/, "");
}

/**
 * What Claude's composer holds on this screen (read with its escape codes):
 * the typed text between the prompt mark (`❯`, or `>`) under a rule and the
 * next rule, trimmed; "" when empty or showing only its dim placeholder. Null
 * when no composer can be found, so the caller refuses rather than guesses.
 */
export function composerText(screen: string): string | null {
  const lines = screen.split("\n").map(typedText);
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!RULE.test(lines[i - 1]!)) continue;
    const prompt = PROMPT.exec(lines[i]!);
    if (!prompt) continue;
    const end = lines.findIndex((line, j) => j > i && RULE.test(line));
    if (end < 0) continue;
    return [prompt[1] ?? "", ...lines.slice(i + 1, end)]
      .map((line) => line.replace(/│/g, "").trim())
      .join("\n")
      .trim();
  }
  return null;
}

export interface RewakeFacts {
  session: LeaderSessionRow;
  /** A Herdr runtime is configured and reachable. */
  herdr: boolean;
  /** When the daemon last typed a rewake into this session, or null. */
  lastTyped: number | null;
  now: number;
}

/** Why no rewake may be typed into this lease holder, read from the database alone, or null. Pure. */
export function rewakeBlocker(f: RewakeFacts): string | null {
  const s = f.session;
  if (s.harness !== "claude") return "the Pi leader's extension is not polling; type to the leader";
  if (!s.pane_id) return "the leader runs outside Herdr; type to it";
  if (!f.herdr) return "Herdr is not reachable; type to the leader";
  if (s.proc_pid === null) return "the leader's process is not known; type to it";
  if (f.lastTyped !== null && f.lastTyped >= (s.last_event_at ?? 0)) return `the wake typed at ${clockLabel(f.lastTyped, f.now)} got no answer; type to the leader`;
  return null;
}

/** Why the pane must not get keys now, from Herdr's reads, or null. */
export async function paneBlocker(runtime: RewakeRuntime, s: LeaderSessionRow): Promise<string | null> {
  const pane = s.pane_id!;
  const info = await runtime.processes(pane);
  if (!info) return "the leader's Herdr pane is gone; type to the leader";
  if (!info.processes.some((p) => p.pid === s.proc_pid)) return "the leader's pane does not run this leader's process; type to it";
  const status = await runtime.agentStatus(pane);
  if (!settledStatus(status)) return `Herdr reads the leader ${status ?? "unknown"}`;
  const screen = await runtime.readPane(pane, SCREEN_LINES, { ansi: true });
  if (screen === null) return "the leader's Herdr pane is gone; type to the leader";
  if (DIALOG_QUESTION.test(screen.replace(ESCAPE, ""))) return "a dialog is open in the leader's pane; answer it";
  const draft = composerText(screen);
  if (draft === null) return "cannot read the leader's composer; type to the leader";
  if (draft !== "") return "a draft is in the leader's composer; send or clear it";
  return null;
}

export class LeaderRewake {
  private dueTicks = 0;
  private running = false;

  constructor(private readonly deps: RewakeDeps) {}

  /** One attention tick: type the rewake line when every check passes, else keep why not. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
    } catch (error) {
      this.deps.log(`rewake: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** The lease holder and the wake due for it now (null when none is), or null when it has a waiter or none is due. */
  private due(): { s: LeaderSessionRow; ids: string[] } | null {
    const { db, attention, now } = this.deps;
    const t = now();
    const holder = getLease(db).session_id;
    const s = holder ? getSession(db, holder) : null;
    if (!s || s.ended_at !== null) return null;
    if (attention.bus.hasWaiter(s.session_id)) return null;
    const seen = Math.max(attention.bus.lastSeen(s.session_id) ?? 0, this.deps.startedAt);
    if (t - seen < attention.timing().waiter_grace_ms) return null;
    const { push } = leaderPush({ db, attention, config: this.deps.config }, s, t);
    if (!push || (push.mode !== "waiter" && push.mode !== "trigger")) return null;
    return { s, ids: push.items.map((i) => i.id) };
  }

  private async check(): Promise<void> {
    const { db, now } = this.deps;
    const due = this.due();
    if (!due) {
      this.dueTicks = 0;
      this.settle(null, null);
      return;
    }
    const { s } = due;
    const state = rewakeState(db, s.session_id);
    const lastTyped = state.typed.at(-1) ?? null;
    const runtime = this.deps.runtime();
    const blocked = rewakeBlocker({ session: s, herdr: runtime !== null, lastTyped, now: now() });
    if (blocked) {
      this.dueTicks = 0;
      this.settle(s.session_id, blocked);
      return;
    }
    // At most one rewake per grace window, and only once the wake held over two ticks.
    if (lastTyped !== null && now() - lastTyped < this.deps.attention.timing().waiter_grace_ms) return;
    this.dueTicks += 1;
    if (this.dueTicks < 2) return;
    let refused: string | null;
    try {
      refused = await paneBlocker(runtime!, s);
    } catch (error) {
      refused = `cannot read the leader's pane from Herdr (${(error as Error).message})`;
    }
    if (refused) {
      this.settle(s.session_id, refused);
      return;
    }
    // Re-check right before the keys: a waiter may have come back, the wake been taken, or Herdr turned busy.
    const still = this.due();
    if (!still || still.s.session_id !== s.session_id) return;
    const status = await runtime!.agentStatus(s.pane_id!).catch(() => null);
    if (!settledStatus(status)) {
      this.settle(s.session_id, `Herdr reads the leader ${status ?? "unknown"}`);
      return;
    }
    const line = rewakeLine(still.ids);
    await runtime!.typeLine(s.pane_id!, line);
    this.dueTicks = 0;
    const t = now();
    tx(db, () => {
      const current = rewakeState(db, s.session_id);
      saveRewakeState(db, { ...current, typed: [...current.typed, t], reason: null, since: null }, t);
      appendEvent(db, { source: "daemon", kind: "leader.rewake_typed", payload: { session: s.session_id, pane: s.pane_id, items: still.ids }, ts: t });
    });
    this.deps.log(`rewake: no waiter for leader ${s.session_id}; typed the wake line for ${still.ids.join(",")} into pane ${s.pane_id}`);
  }

  /** Keep why no wake can reach the holder (null: nothing stops one), with an event only when it changes. */
  private settle(session: string | null, reason: string | null): void {
    const { db, now } = this.deps;
    const holder = session ?? getLease(db).session_id;
    if (!holder) return;
    const state = rewakeState(db, holder);
    if (state.reason === reason) return;
    const t = now();
    tx(db, () => {
      saveRewakeState(db, { ...state, reason, since: reason ? t : null }, t);
      appendEvent(db, { source: "daemon", kind: reason ? "leader.rewake_blocked" : "leader.rewake_clear", payload: { session: holder, reason }, ts: t });
    });
  }
}
