import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { itemLines } from "../attention/items.ts";
import type { OpenerMode, ReviewConfig } from "../config/leader.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { MAX_LINE_CHARS, sanitizeLine } from "../util/sanitize.ts";
import { lavishUrlKey } from "./session-key.ts";

/**
 * Review pages open in your browser (docs/notes/2026-10-10-review-pages-open-4b.md). A review
 * gate opens `pending`; once the daemon's own `lavish-axi poll` for it has started
 * (src/lavish/poller.ts), the poller offers the gate here. The opener waits until Lavish itself
 * shows that poll listening on the page (its `agent-presence` event, read over the page's
 * `/events/<key>` WebSocket, at most 60 s), claims the gate (`opening`, committed before the
 * spawn, so a restart, a replay or a second offer never opens it twice), runs
 * `/usr/bin/open -a <browser> <url>` and records `opened` (open exited 0: Launch Services took
 * the URL) or `failed` with why, on the gate, its gate_ready item and an event. A daemon that dies
 * between the claim and the result leaves `opening`, which `flowryn show` reads as "may not have
 * opened". A file:// page (no lavish-axi) has nothing to listen for and opens at once.
 *
 * Once per page per run: a gate whose run already opened the same URL for an earlier gate (a
 * resubmission after changes; Lavish live-reloads the tab you have) is `skipped`. Plain code.
 */

export const GATE_OPEN_STATES = ["pending", "opening", "opened", "failed", "off", "skipped"] as const;
export type GateOpenState = (typeof GATE_OPEN_STATES)[number];

/** How long the opener waits for Lavish to show the page's poll listening. */
export const PRESENCE_WAIT_MS = 60_000;
/** How long `open` may take to hand the URL over. */
export const OPEN_TIMEOUT_MS = 10_000;
/** A probe that could not connect tries again this soon (Lavish may still be starting). */
const PRESENCE_RETRY_MS = 2_000;

export type OpenResult = { ok: true } | { ok: false; why: string };
export type PresenceResult = { listening: true } | { listening: false; why: string };

export interface OpenerDeps {
  db: Db;
  review(): ReviewConfig;
  mode(): OpenerMode;
  log(message: string): void;
  now(): number;
  /** Hand the URL to the browser (default: `/usr/bin/open -a`, or the recorder). */
  open?(browser: string, url: string): Promise<OpenResult>;
  /** Wait for Lavish to show the page's poll listening (default: its WebSocket, or the recorder). */
  presence?(url: string, waitMs: number, signal: AbortSignal): Promise<PresenceResult>;
}

interface PendingGate {
  id: string;
  run_id: string;
  task_id: string;
  review_url: string;
}

export class ReviewOpener {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private closed = false;

  constructor(private readonly deps: OpenerDeps) {}

  /** Open this gate's page if it still waits to be opened; at most one attempt per gate is in flight. */
  offer(gateId: string): void {
    if (this.closed || this.inflight.has(gateId)) return;
    try {
      const gate = this.pendingGate(gateId);
      if (!gate || this.settledWithoutOpening(gate)) return;
      const attempt = this.attempt(gate)
        .catch((error) => this.deps.log(`browser: opening gate ${gateId}'s page failed: ${(error as Error).stack ?? String(error)}`))
        .finally(() => this.inflight.delete(gateId));
      this.inflight.set(gateId, attempt);
    } catch (error) {
      this.deps.log(`browser: cannot look at gate ${gateId}: ${(error as Error).stack ?? String(error)}`);
    }
  }

  /** Every attempt in flight has finished (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all(this.inflight.values());
  }

  stop(): void {
    this.closed = true;
    this.abort.abort();
  }

  private pendingGate(gateId: string): PendingGate | null {
    return this.deps.db
      .query(
        `SELECT g.id, g.run_id, r.task_id, g.review_url FROM gates g JOIN runs r ON r.id = g.run_id
         WHERE g.id = ?1 AND g.kind = 'review' AND g.state = 'open' AND g.open_state = 'pending' AND g.review_url IS NOT NULL`,
      )
      .get(gateId) as PendingGate | null;
  }

  /** Off by the setting or the environment, or already opened for this run: settled here, true. */
  private settledWithoutOpening(gate: PendingGate): boolean {
    const mode = this.deps.mode();
    if (!this.deps.review().open_browser) return this.settle(gate, "off", "[review] open_browser = false");
    if (mode.kind === "off") return this.settle(gate, "off", mode.why);
    const earlier = this.deps.db
      .query("SELECT id FROM gates WHERE run_id = ?1 AND review_url = ?2 AND id != ?3 AND open_state IN ('opening','opened') ORDER BY opened_at LIMIT 1")
      .get(gate.run_id, gate.review_url, gate.id) as { id: string } | null;
    if (earlier) return this.settle(gate, "skipped", `already opened for ${earlier.id}`);
    return false;
  }

  /** Move a pending gate to a state that opens nothing; true once settled. */
  private settle(gate: PendingGate, state: "off" | "skipped" | "failed", detail: string): boolean {
    const now = this.deps.now();
    tx(this.deps.db, () => {
      const changed = this.deps.db.query("UPDATE gates SET open_state = ?2, open_detail = ?3, open_at = ?4 WHERE id = ?1 AND open_state = 'pending'").run(gate.id, state, detail, now).changes;
      if (changed === 0) return;
      appendEvent(this.deps.db, { source: "daemon", kind: `gate.browser_${state}`, runId: gate.run_id, taskId: gate.task_id, payload: { gate: gate.id, url: gate.review_url, detail }, ts: now });
      if (state === "failed") this.noteOnItem(gate, failedSuffix(detail));
    });
    this.deps.log(`browser: gate ${gate.id} ${state}: ${detail}`);
    return true;
  }

  private async attempt(gate: PendingGate): Promise<void> {
    const url = gate.review_url;
    if (!url.startsWith("file://")) {
      const seen = await this.presence(url, PRESENCE_WAIT_MS, this.abort.signal);
      // A stopping daemon leaves the gate pending: the next one offers it again.
      if (this.closed) return;
      if (!seen.listening) {
        if (this.pendingGate(gate.id)) this.settle(gate, "failed", seen.why);
        return;
      }
    }
    const { browser } = this.deps.review();
    if (!this.claim(gate, browser)) return;
    const result = await this.open(browser, url);
    this.record(gate, browser, result);
  }

  /** pending → opening, committed before the spawn: at most once. */
  private claim(gate: PendingGate, browser: string): boolean {
    const now = this.deps.now();
    return tx(this.deps.db, () => {
      const changed = this.deps.db.query("UPDATE gates SET open_state = 'opening', open_at = ?2 WHERE id = ?1 AND open_state = 'pending' AND state = 'open'").run(gate.id, now).changes;
      if (changed === 0) return false;
      appendEvent(this.deps.db, { source: "daemon", kind: "gate.browser_opening", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gate.id, url: gate.review_url, browser }, ts: now });
      return true;
    });
  }

  private record(gate: PendingGate, browser: string, result: OpenResult): void {
    const now = this.deps.now();
    const state = result.ok ? "opened" : "failed";
    const detail = result.ok ? `opened in ${browser}` : sanitizeLine(result.why, 160);
    tx(this.deps.db, () => {
      this.deps.db.query("UPDATE gates SET open_state = ?2, open_detail = ?3, open_at = ?4 WHERE id = ?1 AND open_state = 'opening'").run(gate.id, state, detail, now);
      appendEvent(this.deps.db, { source: "daemon", kind: `gate.browser_${state}`, runId: gate.run_id, taskId: gate.task_id, payload: { gate: gate.id, url: gate.review_url, browser, detail }, ts: now });
      this.noteOnItem(gate, result.ok ? ` · opened in ${browser}` : failedSuffix(detail));
    });
    this.deps.log(`browser: gate ${gate.id} ${result.ok ? `opened in ${browser}` : `NOT opened: ${detail}`}`);
  }

  /** The gate's gate_ready item says what happened, in the same transaction (precedent: src/sched/usage.ts). */
  private noteOnItem(gate: PendingGate, suffix: string): void {
    const items = this.deps.db
      .query("SELECT id, line, full_line FROM items WHERE kind = 'gate_ready' AND run_id = ?1 AND state IN ('open','presented')")
      .all(gate.run_id) as { id: string; line: string; full_line: string | null }[];
    const item = items.find((i) => (i.full_line ?? i.line).includes(`(${gate.id})`));
    if (!item) return;
    const lines = linesEndingWith(item.full_line ?? item.line, suffix);
    this.deps.db.query("UPDATE items SET line = ?2, full_line = ?3 WHERE id = ?1").run(item.id, lines.line, lines.full_line);
  }

  private open(browser: string, url: string): Promise<OpenResult> {
    if (this.deps.open) return this.deps.open(browser, url);
    const mode = this.deps.mode();
    if (mode.kind === "record") return Promise.resolve(recordOpen(mode.path, browser, url));
    return runOpen(browser, url);
  }

  private presence(url: string, waitMs: number, signal: AbortSignal): Promise<PresenceResult> {
    if (this.deps.presence) return this.deps.presence(url, waitMs, signal);
    const mode = this.deps.mode();
    if (mode.kind === "record") return Promise.resolve(recordedPresence(mode.path));
    return lavishPresence(url, waitMs, signal);
  }
}

/** The digest line keeps the open result whole: the title and URL before it give way. */
export function linesEndingWith(text: string, suffix: string): { line: string; full_line: string | null } {
  const whole = itemLines(`${text}${suffix}`);
  if (whole.full_line === null) return whole;
  const tail = sanitizeLine(suffix);
  const room = MAX_LINE_CHARS - tail.length - 1;
  const line = room > 1 ? `${sanitizeLine(text, room)} ${tail}` : tail;
  return { line, full_line: whole.full_line };
}

function failedSuffix(why: string): string {
  return ` · NOT opened (${why}); relay the URL to open it by hand`;
}

/** `/usr/bin/open -a <browser> <url>`: no shell, a fixed argv, 10 s at most. */
export async function runOpen(browser: string, url: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<OpenResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["/usr/bin/open", "-a", browser, url], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (error) {
    return { ok: false, why: `cannot run open: ${(error as Error).message}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stderr, code] = await Promise.all([new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    if (timedOut) return { ok: false, why: `open did not finish in ${timeoutMs / 1000} s` };
    if (code === 0) return { ok: true };
    const said = stderr.trim().split("\n")[0]?.trim();
    return { ok: false, why: `open exited ${code}${said ? `: ${said}` : ""}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * FLOWRYN_OPENER=record:<path>: each open is a line `<browser>\t<url>` in that file, never a
 * spawn. While `<path>.fail` exists the open fails with its text, as `open` would.
 */
export function recordOpen(path: string, browser: string, url: string): OpenResult {
  appendFileSync(path, `${browser}\t${url}\n`, { mode: 0o600 });
  if (!existsSync(`${path}.fail`)) return { ok: true };
  return { ok: false, why: readFileSync(`${path}.fail`, "utf8").trim() || "open failed" };
}

/** The recorder's presence: listening, unless `<path>.presence` names another state (then at once, no wait). */
export function recordedPresence(path: string): PresenceResult {
  const file = `${path}.presence`;
  const state = existsSync(file) ? readFileSync(file, "utf8").trim() : "listening";
  return state === "listening" ? { listening: true } : { listening: false, why: `Lavish never showed the page listened to (${state || "no presence"})` };
}

type ProbeOutcome = { listening: true } | { listening: false; presence: string | null; problem: string | null };

/**
 * Wait until Lavish shows a poll listening on the page. lavish-axi 0.1.65 has no REST read of
 * it: its browser WebSocket `/events/<key>` (same origin as the page, with an `Origin` header
 * of that origin, or it refuses the upgrade) sends `chat-sync`, then `agent-presence {state}`
 * on connect, and each presence change after. The probe stays connected until it reads
 * `listening` or the wait ends; one that cannot connect tries again every 2 s.
 */
export async function lavishPresence(url: string, waitMs: number, signal: AbortSignal): Promise<PresenceResult> {
  const key = lavishUrlKey(url);
  if (!key) return { listening: false, why: "cannot read Lavish presence (not a Lavish review URL)" };
  const origin = new URL(url).origin;
  const socketUrl = `${origin.replace(/^http/, "ws")}/events/${key}`;
  const deadline = Date.now() + waitMs;
  let presence: string | null = null;
  let problem: string | null = null;
  while (!signal.aborted) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const outcome = await probeOnce(socketUrl, origin, left, signal);
    if (outcome.listening) return outcome;
    presence = outcome.presence ?? presence;
    problem = outcome.problem;
    const pause = Math.min(PRESENCE_RETRY_MS, deadline - Date.now());
    if (pause > 0 && !signal.aborted) await sleep(pause, signal);
  }
  if (presence !== null) return { listening: false, why: `Lavish never showed the page listened to in ${Math.round(waitMs / 1000)} s` };
  return { listening: false, why: `cannot read Lavish presence (${problem ?? "no answer"})` };
}

function probeOnce(socketUrl: string, origin: string, waitMs: number, signal: AbortSignal): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let presence: string | null = null;
    let done = false;
    let socket: WebSocket;
    const finish = (outcome: ProbeOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve(outcome);
    };
    const onAbort = () => finish({ listening: false, presence, problem: "stopped" });
    const timer = setTimeout(() => finish({ listening: false, presence, problem: presence === null ? "no presence message" : null }), waitMs);
    signal.addEventListener("abort", onAbort);
    try {
      // Bun's WebSocket takes headers; Lavish refuses an upgrade without a same-origin Origin.
      socket = new WebSocket(socketUrl, { headers: { Origin: origin } } as unknown as string[]);
    } catch (error) {
      finish({ listening: false, presence, problem: (error as Error).message });
      return;
    }
    socket.addEventListener("message", (message) => {
      let parsed: { type?: unknown; data?: { state?: unknown } };
      try {
        parsed = JSON.parse(String(message.data)) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type !== "agent-presence" || typeof parsed.data?.state !== "string") return;
      presence = parsed.data.state;
      if (presence === "listening") finish({ listening: true });
    });
    socket.addEventListener("error", () => finish({ listening: false, presence, problem: "connection refused or upgrade rejected" }));
    socket.addEventListener("close", (event) => finish({ listening: false, presence, problem: `closed (${event.code})` }));
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}
