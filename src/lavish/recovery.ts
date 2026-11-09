import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import { runBounded } from "../runtime/bounded.ts";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { hostSnapshot, LavishCallError } from "./snapshot.ts";

/**
 * Recovering a broken Lavish server by itself (docs/notes/2026-11-08-recover-a-broken-7e.md).
 * One shared lavish-axi server serves every session; when it answers every page with an HTTP
 * 500 (`code: SERVER_ERROR`), nothing reaches the user until it is restarted. Plain code: a call
 * that failed with a server error twice asks `LavishDoctor.check`, which hosts Flowryn's own
 * probe page; a probe that fails too means the server is broken, and unless Flowryn restarted it
 * in the last RESTART_WINDOW_MS the doctor pauses the poller, runs `lavish-axi stop` (the server
 * self-starts on the next host), probes again and has the poller host every open review page
 * again. A second breakage within the window, a stop that fails or a probe still failing after
 * the restart gives up: one lavish_broken P1, and no automatic restart while it is open. A later
 * good probe or poll resolves it (noteHealthy).
 */

/** At most one automatic restart in this long. */
export const RESTART_WINDOW_MS = 10 * 60_000;
/** How long `lavish-axi stop` may take. */
const STOP_TIMEOUT_MS = 15_000;
const DETAIL_CHARS = 200;

/** The probe page: fixed content, no task text. */
export const PROBE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Flowryn Lavish probe</title></head>
<body><p>Flowryn hosts this page to check that the Lavish server answers. It holds nothing else.</p></body></html>
`;

/** Did a lavish-axi call fail with a server error: non-zero, with lavish-axi's own `code: SERVER_ERROR` line? */
export function isServerError(code: number, stdout: string, stderr: string): boolean {
  if (code <= 0 || code === 124 || code === 125) return false;
  const text = `${stdout}\n${stderr}`;
  if (/NOT_FOUND/.test(text)) return false;
  return /^\s*code:\s*"?SERVER_ERROR"?\s*$/m.test(text);
}

/** Was this host failure a server error? */
export function isServerErrorFailure(error: unknown): boolean {
  return error instanceof LavishCallError && isServerError(error.code, error.stdout, error.stderr);
}

/** Write the probe page under the state dir and return its path. */
export function writeProbe(stateDir: string): string {
  const dir = join(stateDir, "lavish-probe");
  ensureDir(dir, 0o700);
  const path = join(dir, "probe.html");
  // An atomic rename replaces whatever sits at the path (a planted symlink included); it never writes through it.
  writeFileAtomic(path, PROBE_PAGE, 0o600);
  // Lavish names a session by the page's real path; hostSnapshot checks the URL it prints against it.
  return realpathSync(path);
}

/** What a check came to. */
export interface CheckOutcome {
  /** ok: the server answers (it was a blip); restarted: it was broken and answers again; gave_up: a lavish_broken item is open; off: no lavish-axi. */
  state: "ok" | "restarted" | "gave_up" | "off";
  item?: string;
  detail?: string;
  /** After a restart: the review pages hosted again, and those that failed (they back off as before). */
  pages?: number;
  failed?: string[];
}

/** What the doctor needs from the poller around a restart. */
export interface RestartablePoller {
  /** Stop every poll as a deliberate stop (no backoff, nothing lost: Lavish keeps queued feedback), and start none until resumed. */
  pauseForRestart(): void;
  /** Host every open review page again and let the polls start again. */
  resumeAfterRestart(): Promise<{ hosted: string[]; failed: string[] }>;
}

/** What the poller and the verbs call: a check (restarting when broken), and news that Lavish works. */
export interface LavishRecovery {
  check(reason: string, by: string): Promise<CheckOutcome>;
  noteHealthy(): void;
}

export interface DoctorDeps {
  db: Db;
  lavish(): string | null;
  stateDir: string;
  poller: RestartablePoller;
  log(message: string): void;
  now(): number;
}

/** The newest lavish.restarted event's time, or null. */
export function lastRestartAt(db: Db): number | null {
  const row = db.query("SELECT ts FROM events WHERE kind = 'lavish.restarted' ORDER BY seq DESC LIMIT 1").get() as { ts: number } | null;
  return row?.ts ?? null;
}

export class LavishDoctor implements LavishRecovery {
  private inflight: Promise<CheckOutcome> | null = null;
  private closed = false;

  constructor(private readonly deps: DoctorDeps) {}

  /** Check the server once for every asker at a time (single flight); `by` is who asked ("daemon", "worker:<run>"). */
  check(reason: string, by: string): Promise<CheckOutcome> {
    if (this.closed) return Promise.reject(new Error("the daemon is stopping"));
    this.inflight ??= this.run(sanitizeLine(reason, DETAIL_CHARS), by).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** A host or poll worked: the server answers, so an open lavish_broken item resolves. */
  noteHealthy(): void {
    tx(this.deps.db, () => {
      if (!findOpenItem(this.deps.db, "lavish_broken", null)) return;
      const now = this.deps.now();
      resolveItems(this.deps.db, "lavish_broken", null, "Lavish answered again", now);
      appendEvent(this.deps.db, { source: "daemon", kind: "lavish.healthy", payload: {}, ts: now });
    });
  }

  stop(): void {
    this.closed = true;
  }

  private async run(reason: string, by: string): Promise<CheckOutcome> {
    const lavish = this.deps.lavish();
    if (!lavish) return { state: "off" };
    const open = findOpenItem(this.deps.db, "lavish_broken", null);
    // Given up: no probe, no restart until the item resolves (by hand, or a good poll).
    if (open) return { state: "gave_up", item: open.id, detail: "an earlier recovery gave up" };
    const first = await this.probe(lavish);
    if (first === null) {
      tx(this.deps.db, () => appendEvent(this.deps.db, { source: "daemon", kind: "lavish.probe_ok", payload: { reason, by }, ts: this.deps.now() }));
      return { state: "ok" };
    }
    tx(this.deps.db, () => appendEvent(this.deps.db, { source: "daemon", kind: "lavish.broken", payload: { reason, by, probe: first }, ts: this.deps.now() }));
    this.deps.log(`lavish: the server is broken (${reason}; the probe page failed too: ${first})`);
    const last = lastRestartAt(this.deps.db);
    if (last !== null && this.deps.now() - last < RESTART_WINDOW_MS) {
      return this.giveUp(reason, by, `it broke again within ${RESTART_WINDOW_MS / 60_000} minutes of the restart at ${clock(last)} (${first})`);
    }
    this.deps.poller.pauseForRestart();
    let resumed = false;
    const resume = async (): Promise<{ hosted: string[]; failed: string[] }> => {
      resumed = true;
      return this.deps.poller.resumeAfterRestart();
    };
    try {
      const stop = await runBounded([lavish, "stop"], { label: "lavish-axi stop", timeoutMs: STOP_TIMEOUT_MS, env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" } });
      if (stop.code !== 0) {
        const detail = sanitizeLine(`lavish-axi stop exited ${stop.code}: ${(stop.stderr || stop.stdout).trim()}`, DETAIL_CHARS);
        tx(this.deps.db, () => appendEvent(this.deps.db, { source: "daemon", kind: "lavish.stop_failed", payload: { reason, by, detail }, ts: this.deps.now() }));
        await resume();
        return this.giveUp(reason, by, detail);
      }
      if (this.closed) throw new Error("the daemon is stopping");
      const again = await this.probe(lavish);
      const pages = await resume();
      tx(this.deps.db, () =>
        appendEvent(this.deps.db, {
          source: "daemon",
          kind: "lavish.restarted",
          payload: { reason, by, pages: pages.hosted.length, failed: pages.failed, ok: again === null },
          ts: this.deps.now(),
        }),
      );
      if (again !== null) return this.giveUp(reason, by, `still failing after the restart: ${again}`);
      this.deps.log(`lavish: restarted the server (${reason}); ${pages.hosted.length} review page(s) hosted again${pages.failed.length > 0 ? `, ${pages.failed.length} failed` : ""}`);
      return { state: "restarted", pages: pages.hosted.length, failed: pages.failed };
    } catch (error) {
      // A daemon stopping mid-restart leaves the polls to the next daemon's sweep.
      if (!resumed && !this.closed) await resume().catch(() => {});
      throw error;
    }
  }

  /** Host the probe page: null when it worked, else why it failed. */
  private async probe(lavish: string): Promise<string | null> {
    try {
      await hostSnapshot(lavish, writeProbe(this.deps.stateDir));
      return null;
    } catch (error) {
      return sanitizeLine((error as Error).message, DETAIL_CHARS);
    }
  }

  private giveUp(reason: string, by: string, detail: string): CheckOutcome {
    const now = this.deps.now();
    const item = tx(this.deps.db, () => {
      const event = appendEvent(this.deps.db, { source: "daemon", kind: "lavish.gave_up", payload: { reason, by, detail }, ts: now });
      const open = findOpenItem(this.deps.db, "lavish_broken", null);
      if (open) return open.id;
      return openItem(this.deps.db, {
        kind: "lavish_broken",
        eventSeq: event.seq,
        line: `Lavish keeps failing (${detail}): review pages are not reaching the user and Flowryn stopped restarting it. Restart it by hand (lavish-axi stop; it starts again on the next page), then resolve this item`,
        now,
      });
    });
    this.deps.log(`lavish: gave up recovering the server (${detail}); item ${item}`);
    return { state: "gave_up", item, detail };
  }
}

function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}
