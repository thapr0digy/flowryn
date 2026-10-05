import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { lavishAnswer } from "../lifecycle/decision-verbs.ts";
import { gatesToPoll, gatesWithWidget, recordGateComment, recordGateNotes, recordLavishEnded, requestGatePass, widgetState, type PassRequest } from "../lifecycle/gate-questions.ts";
import { parsePollOutput, type PollOutput } from "./poll-output.ts";
import { requirePageDir, writeWidget } from "./widget.ts";

/**
 * The daemon's side of a review page's questions. Each pass rewrites the
 * question widget of every gate whose state changed, and keeps one
 * `lavish-axi poll <page>` running for each open gate with an open question
 * (gatesToPoll). A poll returns when the user sends feedback; its answers are
 * recorded (lavishAnswer), then the Send's "anything else" (recordGateComment)
 * and its pass request (requestGatePass, a P1 for the leader: the page never
 * passes a gate), all in one transaction; any other prompts (annotations, chat) are kept in
 * `lavish-notes-<gate>.txt` beside the page for the verdict steer to point
 * at, and the poll starts again. A poll Flowryn kills loses nothing: Lavish
 * keeps queued feedback until a poll delivers it. A poll that fails backs off
 * (2 s doubling to a minute); one that reports the user ended the session
 * stops for good. Nothing here decides anything: patterns and the database.
 */

export interface PollerDeps {
  db: Db;
  /** The lavish-axi binary, or null when it is not installed. */
  lavish(): string | null;
  log(message: string): void;
  now(): number;
  /**
   * Where each running poll's pid is kept (<state_dir>/lavish-polls). A daemon that died without
   * its shutdown leaves its polls running, and an orphaned poll would take the user's answers with
   * nothing reading them: the next daemon kills those before it polls.
   */
  pidDir?: string;
}

interface Running {
  page: string;
  proc: ReturnType<typeof Bun.spawn>;
  stopped: boolean;
  /** A last, short poll that only carries the reply for a gate no longer polled. */
  final: boolean;
}

/** How long the last poll that carries a reply waits for anything else the user sends. */
const FINAL_POLL_MS = 1_500;

/**
 * Append to a gate's notes beside its page, never through a symlink: the
 * worker can write the page's directory, and the daemon writes outside its
 * sandbox.
 */
function appendNotes(page: string, path: string, text: string): void {
  requirePageDir(page);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export class LavishPoller {
  private readonly running = new Map<string, Running>();
  private readonly failures = new Map<string, number>();
  private readonly waitUntil = new Map<string, number>();
  private readonly widgets = new Set<string>();
  private readonly warned = new Set<string>();
  /** What Flowryn recorded, shown in Lavish's conversation with the next poll (--agent-reply). */
  private readonly replies = new Map<string, { page: string; text: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private swept = false;

  constructor(private readonly deps: PollerDeps) {}

  /** Look at the gates soon (debounced). */
  kick(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pass();
    }, 0);
  }

  /** One pass now: widgets first, then the polls. */
  pass(): void {
    if (this.closed) return;
    try {
      if (!this.swept) {
        this.swept = true;
        this.sweepOrphans();
      }
      this.writeWidgets();
      this.followGates();
    } catch (error) {
      this.deps.log(`lavish: pass failed: ${(error as Error).stack ?? String(error)}`);
    }
  }

  /** The gates a poll runs for now (tests). */
  polling(): string[] {
    return [...this.running.keys()];
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    for (const gate of this.running.keys()) this.halt(gate);
  }

  private writeWidgets(): void {
    for (const gateId of gatesWithWidget(this.deps.db, this.widgets)) {
      const found = widgetState(this.deps.db, gateId);
      if (!found) {
        this.widgets.delete(gateId);
        continue;
      }
      try {
        if (writeWidget(found.page, found.state)) this.deps.log(`lavish: wrote the question widget of gate ${gateId}`);
      } catch (error) {
        this.deps.log(`lavish: cannot write the widget of gate ${gateId} beside ${found.page}: ${(error as Error).message}`);
      }
      // A closed gate's widget is written once more (locked), then left alone.
      if (found.state.gateState === "open") this.widgets.add(gateId);
      else this.widgets.delete(gateId);
    }
  }

  private followGates(): void {
    const lavish = this.deps.lavish();
    const wanted = new Map(gatesToPoll(this.deps.db).map((g) => [g.id, g.page_path]));
    for (const [gate, entry] of this.running) if (!wanted.has(gate) && !entry.final) this.halt(gate);
    const now = this.deps.now();
    let nextRetry: number | null = null;
    for (const [gate, page] of wanted) {
      if (this.running.has(gate)) continue;
      if (!lavish) {
        this.warnOnce(gate, `lavish: lavish-axi is not installed; gate ${gate}'s questions are answered only through the leader`);
        continue;
      }
      const at = this.waitUntil.get(gate) ?? 0;
      if (at > now) {
        nextRetry = Math.min(nextRetry ?? at, at);
        continue;
      }
      if (!existsSync(page)) {
        this.warnOnce(gate, `lavish: gate ${gate}'s page ${page} is gone; its questions are answered only through the leader`);
        continue;
      }
      this.start(lavish, gate, page, false);
    }
    // A gate whose questions are all answered gets its reply all the same: one short poll carries it,
    // so Lavish's conversation shows what Flowryn recorded instead of waiting on an agent for good.
    for (const [gate, reply] of this.replies) {
      if (wanted.has(gate) || this.running.has(gate)) continue;
      if (!lavish || !existsSync(reply.page)) {
        this.replies.delete(gate);
        continue;
      }
      this.start(lavish, gate, reply.page, true);
    }
    if (nextRetry !== null && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.kick();
      }, Math.max(0, nextRetry - now));
    }
  }

  private warnOnce(gate: string, message: string): void {
    if (this.warned.has(gate)) return;
    this.warned.add(gate);
    this.deps.log(message);
  }

  private start(lavish: string, gate: string, page: string, final: boolean): void {
    const reply = this.replies.get(gate)?.text;
    this.replies.delete(gate);
    const args = [lavish, "poll", page, ...(reply ? ["--agent-reply", reply] : []), ...(final ? ["--timeout-ms", String(FINAL_POLL_MS)] : [])];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" } });
    } catch (error) {
      this.finished(gate, page, -1, "", `cannot run ${lavish}: ${(error as Error).message}`);
      return;
    }
    const entry: Running = { page, proc, stopped: false, final };
    this.running.set(gate, entry);
    this.keepPid(gate, proc.pid, page);
    void (async () => {
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
        this.dropPid(gate, proc.pid);
        if (this.running.get(gate) === entry) this.running.delete(gate);
        if (entry.stopped || this.closed) return;
        this.finished(gate, page, code, stdout, stderr);
      } catch (error) {
        if (this.running.get(gate) === entry) this.running.delete(gate);
        this.deps.log(`lavish: the poll of gate ${gate} could not be recorded: ${(error as Error).stack ?? String(error)}`);
      }
      this.kick();
    })();
  }

  private halt(gate: string): void {
    const entry = this.running.get(gate);
    if (!entry) return;
    entry.stopped = true;
    this.running.delete(gate);
    entry.proc.kill("SIGTERM");
  }

  private finished(gate: string, page: string, code: number, stdout: string, stderr: string): void {
    if (code !== 0) {
      const failures = (this.failures.get(gate) ?? 0) + 1;
      this.failures.set(gate, failures);
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
      this.waitUntil.set(gate, this.deps.now() + delay);
      const why = /NOT_FOUND/.test(stdout + stderr) ? "no Lavish session for the page (the worker opens it with lavish-axi)" : code < 0 ? stderr : `exit ${code}`;
      this.deps.log(`lavish: the poll of gate ${gate} failed (${why}); again in ${delay / 1000} s`);
      return;
    }
    this.failures.delete(gate);
    this.waitUntil.delete(gate);
    const out = parsePollOutput(stdout);
    this.record(gate, page, out, stdout);
  }

  private record(gate: string, page: string, out: PollOutput, raw: string): void {
    let notes: string | null = null;
    if (out.otherPrompts > 0 || out.malformed > 0) {
      const path = join(dirname(page), `lavish-notes-${gate}.txt`);
      try {
        appendNotes(page, path, `--- ${new Date(this.deps.now()).toISOString()}\n${raw}\n`);
        notes = path;
      } catch (error) {
        this.deps.log(`lavish: cannot keep gate ${gate}'s notes in ${path}: ${(error as Error).message}`);
      }
    }
    const ctx = { db: this.deps.db, now: this.deps.now };
    const { outcomes, comments, passes } = tx(this.deps.db, () => {
      const results = out.answers.map((a) => ({ decision: a.decision, outcome: lavishAnswer(ctx, a) }));
      // A Send names its gate; one for another gate (a stale page) is recorded against that gate's own rules.
      const kept = out.sends.filter((s) => s.comment !== null).map((s) => recordGateComment(this.deps.db, s.gate, s.comment!, this.deps.now()));
      const asked = out.sends.filter((s) => s.pass).map((s) => requestGatePass(this.deps.db, s.gate, this.deps.now()));
      if (notes) recordGateNotes(this.deps.db, gate, notes, out.otherPrompts + out.malformed, this.deps.now());
      if (out.ended) recordLavishEnded(this.deps.db, gate, this.deps.now());
      return { outcomes: results, comments: kept, passes: asked };
    });
    const said = outcomes.length > 0 || comments.length > 0 || passes.length > 0;
    if (!out.ended && (said || notes)) this.replies.set(gate, { page, text: this.replyText(gate, outcomes, notes !== null, comments, passes) });
    const extra = [comments.length > 0 ? `comment ${comments.join(", ")}` : null, passes.length > 0 ? `pass ${passes.map((p) => p.outcome).join(", ")}` : null].filter(Boolean);
    this.deps.log(`lavish: gate ${gate}: ${outcomes.length > 0 ? outcomes.map((o) => `${o.decision} ${o.outcome}`).join(", ") : "no answers"}${extra.length > 0 ? `, ${extra.join(", ")}` : ""}${notes ? `, ${out.otherPrompts + out.malformed} other prompt(s) kept` : ""}${out.ended ? ", the user ended the session" : ""}`);
  }

  /** The reply Lavish shows the user: what was recorded, what was not and why, and what comes next. */
  private replyText(gate: string, outcomes: { decision: string; outcome: string }[], notes: boolean, comments: string[] = [], passes: PassRequest[] = []): string {
    const said = (outcome: string) => outcomes.filter((o) => o.outcome === outcome).map((o) => o.decision);
    const parts: string[] = [];
    if (said("recorded").length > 0) parts.push(`Flowryn recorded your answer to ${said("recorded").join(", ")}.`);
    if (said("late").length > 0) parts.push(`${said("late").join(", ")} already had an answer; it stands.`);
    if (said("invalid").length > 0) parts.push(`${said("invalid").join(", ")}: the choice was not one the question offers; answer again.`);
    if (said("stale").length > 0) parts.push("An answer from an earlier version of this page was ignored.");
    if (comments.includes("recorded")) parts.push("Your note for the worker is kept; it reaches the worker with the verdict.");
    if (comments.includes("late")) parts.push("The review had already closed, so your note for the worker was not kept.");
    if (notes) parts.push("Your other notes reach the worker with the verdict.");
    const pass = passes[passes.length - 1];
    if (pass?.outcome === "questions_open") parts.push(`Pass not requested: ${pass.open.join(", ")} still open; answer ${pass.open.length === 1 ? "it" : "them"} first.`);
    const asked = pass?.outcome === "requested" || pass?.outcome === "already";
    if (asked) parts.push("Pass requested. This page cannot pass the review: your leader asks you to confirm it, or you run flowryn approve in your terminal.");
    if (pass?.outcome === "late") parts.push("The review had already closed.");
    const open = (this.deps.db.query("SELECT COUNT(*) AS n FROM decisions WHERE gate_id = ?1 AND state = 'open'").get(gate) as { n: number }).n;
    if (open > 0) parts.push(`${open} question${open === 1 ? "" : "s"} still open.`);
    else if (!asked) parts.push("Every question is answered; the review now waits for your pass in Flowryn.");
    return parts.join(" ");
  }

  private pidFile(gate: string): string | null {
    return this.deps.pidDir ? join(this.deps.pidDir, `${gate}.json`) : null;
  }

  private keepPid(gate: string, pid: number, page: string): void {
    const file = this.pidFile(gate);
    if (!file) return;
    try {
      mkdirSync(this.deps.pidDir!, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ pid, page }), { mode: 0o600 });
    } catch (error) {
      this.deps.log(`lavish: cannot record the poll of gate ${gate}: ${(error as Error).message}`);
    }
  }

  private dropPid(gate: string, pid: number): void {
    const file = this.pidFile(gate);
    if (!file) return;
    try {
      if ((JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid === pid) rmSync(file, { force: true });
    } catch {
      // already gone, or a newer poll's file
    }
  }

  /** Kill the polls an earlier daemon left running: a recorded pid whose command line is still that poll. */
  private sweepOrphans(): void {
    const dir = this.deps.pidDir;
    if (!dir || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      try {
        const { pid, page } = JSON.parse(readFileSync(file, "utf8")) as { pid: number; page: string };
        const ps = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        const command = ps.stdout.toString().trim();
        if (Number.isInteger(pid) && pid > 1 && command.includes(" poll ") && command.includes(page)) {
          process.kill(pid, "SIGTERM");
          this.deps.log(`lavish: stopped a poll an earlier daemon left running (pid ${pid}, ${page})`);
        }
      } catch (error) {
        this.deps.log(`lavish: cannot check the leftover poll in ${file}: ${(error as Error).message}`);
      }
      rmSync(file, { force: true });
    }
  }
}
