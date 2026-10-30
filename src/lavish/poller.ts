import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { lavishAnswer } from "../lifecycle/decision-verbs.ts";
import { gateQuestions, gatesToPoll, gatesWithWidget, readsAsPass, recordGateComment, recordGateNotes, recordLavishEnded, requestGatePass, widgetState, type PassRequest } from "../lifecycle/gate-questions.ts";
import { routedReply, routePageBatch, summarizeReview, type Routed, type UserMessage } from "../lifecycle/review-chat.ts";
import { runBounded } from "../runtime/bounded.ts";
import { PS_TIMEOUT_MS, PsUnavailable, pidsTooLarge, psAnswer } from "../runtime/proc.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { DEFAULT_CHANNEL_ALERT_MS } from "../config/leader.ts";
import type { PageCode, PageCodeStore } from "../policy/approvals.ts";
import { passFromPage, type PagePass } from "../policy/page-pass.ts";
import { channelFailures, clearUnpolledChannels, pollFailureReason, recordChannelFailure, recordChannelOk } from "./channel.ts";
import { parsePollOutput, type PollOutput } from "./poll-output.ts";
import { requirePageDir, writeWidget } from "./widget.ts";

/**
 * The daemon's side of a review page. Each pass rewrites the question widget
 * of every gate whose state changed, and keeps one `lavish-axi poll <page>`
 * running for each open gate with a known page, questions or not
 * (gatesToPoll), so the leader never has to. A poll returns when the user
 * sends feedback; its answers are recorded (lavishAnswer), then the Send's
 * "anything else" (recordGateComment) and its pass: with the pass code you
 * typed it passes the gate (passFromPage, channel page), else it is a request
 * (requestGatePass, a P1 for the leader) and, with no code, a fresh code goes
 * to your notifications (sendPassCode), all in one transaction;
 * any other prompts (annotations, chat), and each Send's "anything else" in
 * full, are kept in `lavish-notes-<gate>.txt` beside the page, and the user's
 * words go to the worker that owns the gate as one steer (routePageBatch,
 * src/lifecycle/review-chat.ts), which answers with `review reply`, shown in
 * the page by `lavish-axi reply` (reply). Flowryn's own reply says where the
 * words went. The leader is not woken per message: the session's end (or the
 * gate's close) gives it one summary (summarizeReview). The poll starts again.
 * A poll Flowryn kills loses nothing: Lavish
 * keeps queued feedback until a poll delivers it. A poll that fails backs off
 * (2 s doubling to a minute, counted from the failures kept on the gate); one
 * that reports the user ended the session stops for good. Each failure, and a
 * channel that turns healthy again, is kept on the gate, and a channel failing
 * for `[review] channel_alert_ms` opens one review_channel item
 * (src/lavish/channel.ts). Once a gate's poll has started, the gate is offered to the
 * opener (src/lavish/opener.ts), which opens the page in your browser.
 * Nothing here decides anything: patterns and the database.
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
  /** The ps that reads a leftover poll's command line (default /bin/ps; tests pass one that fails). */
  ps?: string;
  /** Opens a gate's page in your browser once its poll runs (src/lavish/opener.ts). */
  opener?: { offer(gate: string): void };
  /** `[review] channel_alert_ms`: how long a gate's polls fail before its review_channel item opens. */
  channelAlertMs?(): number;
  /** How long a poll must keep running to count as listening (default STEADY_MS; tests shorten it). */
  steadyMs?: number;
  /** After a batch went to a run: deliver its steer now, and start the scheduler's pass when it asked for a resume or a new run. */
  routed?(runId: string, resumed: boolean): void;
  /**
   * Passing from the page (src/policy/page-pass.ts): the codes, the reviewed HEAD of a gate's run
   * (rev-parse in its worktree, "none" when unreadable), the code's delivery to you (the channels it
   * reached) and what follows a pass (the scheduler and the journal). Without them a pass from the
   * page is only a request for the leader.
   */
  pagePass?: {
    codes: PageCodeStore;
    head(gate: string): Promise<string>;
    sendCode(gate: string, title: string, text: string): Promise<string[]>;
    passed(runId: string): void;
  };
}

/** What one Send's pass came to. */
interface PassOutcome {
  gate: string;
  /** Through the leader: the request, when the page did not pass the gate itself. */
  request: PassRequest | null;
  /** With a code typed in: what the check said. */
  page: PagePass | null;
  /** A fresh code to send (the Send carried none); after the transaction, the channels it reached. */
  minted: PageCode | null;
  reached?: string[];
}

/** A leftover poll's record that ps could not check, kept beside the gate's own `<gate>.json`. */
const UNCHECKED_SUFFIX = ".unchecked.json";

interface Running {
  page: string;
  proc: ReturnType<typeof Bun.spawn>;
  stopped: boolean;
  /** A last, short poll that only carries the reply for a gate no longer polled. */
  final: boolean;
  /** Marks the channel listening once the poll has kept running STEADY_MS. */
  steady: ReturnType<typeof setTimeout> | null;
}

/** How long the last poll that carries a reply waits for anything else the user sends. */
const FINAL_POLL_MS = 1_500;
/** How long `lavish-axi reply` may take: it exits once the server accepts the reply, within its own 10 s. */
const REPLY_TIMEOUT_MS = 15_000;

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
/**
 * A poll still running this long after it started is listening: lavish-axi 0.1.65's poll exits
 * within seconds on a server error, no server (3 retries 500 ms apart) or no session, and holds
 * its request open while it waits for the user.
 */
export const STEADY_MS = 15_000;

export class LavishPoller {
  private readonly running = new Map<string, Running>();
  private readonly waitUntil = new Map<string, number>();
  private readonly widgets = new Set<string>();
  private readonly warned = new Set<string>();
  /** What Flowryn recorded, shown in Lavish's conversation with the next poll (--agent-reply). */
  private readonly replies = new Map<string, { page: string; text: string }>();
  /** Gates whose next poll displaces a listener Lavish may still hold (a reply that fell back to a poll restart). */
  private readonly takeover = new Set<string>();
  /** Gates whose finished poll is still being recorded: no new poll starts until its reply is queued. */
  private readonly recording = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** The sweep of an earlier daemon's polls: started by the first pass, and no poll starts until it is done. */
  private sweep: Promise<void> | null = null;
  private sweepDone = false;

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
      this.sweep ??= this.startSweep();
      this.writeWidgets();
      if (this.sweepDone) this.followGates();
    } catch (error) {
      this.deps.log(`lavish: pass failed: ${(error as Error).stack ?? String(error)}`);
    }
  }

  /**
   * Show a worker's reply in a gate's page with `lavish-axi reply`, beside the
   * running poll (measured on lavish-axi 0.1.88: the poll keeps listening). A
   * reply Lavish refuses waits for the next poll's --agent-reply instead: the
   * running poll is stopped and started again with it, displacing the old
   * listener (--takeover).
   */
  async reply(gate: string, page: string, text: string): Promise<"shown" | "queued" | "off"> {
    const lavish = this.deps.lavish();
    if (!lavish || this.closed) return "off";
    const result = await runBounded([lavish, "reply", page, "--agent-reply-file", "-"], { label: "lavish-axi reply", timeoutMs: REPLY_TIMEOUT_MS, stdin: text, env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" } });
    if (result.code === 0) return "shown";
    this.deps.log(`lavish: the reply on gate ${gate}'s page was refused (${pollFailureReason(result.code, result.stdout, result.stderr)}); the next poll carries it`);
    const queued = this.replies.get(gate);
    this.replies.set(gate, { page, text: queued ? `${queued.text}\n\n${text}` : text });
    const entry = this.running.get(gate);
    if (entry && !entry.final) {
      this.takeover.add(gate);
      this.halt(gate);
    }
    this.kick();
    return "queued";
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
    // A channel nobody polls any more is not degraded: its failures clear and its item resolves.
    const polled = lavish ? new Set(wanted.keys()) : new Set<string>();
    for (const gate of clearUnpolledChannels(this.deps.db, polled, (id) => (lavish ? notPolledWhy(this.deps.db, id) : "lavish-axi is not installed"), now)) {
      this.deps.log(`lavish: gate ${gate}'s channel cleared: its page is no longer polled`);
    }
    let nextRetry: number | null = null;
    for (const [gate, page] of wanted) {
      if (this.running.has(gate) || this.recording.has(gate)) continue;
      if (!lavish) {
        this.warnOnce(gate, `lavish: lavish-axi is not installed; gate ${gate}'s questions are answered only through the leader`);
        // A file:// page has nothing to listen for: it opens at once.
        if (existsSync(page)) this.deps.opener?.offer(gate);
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
      // Its poll is running: the opener waits for Lavish to show it listening, then opens the page.
      this.deps.opener?.offer(gate);
    }
    // A gate whose questions are all answered gets its reply all the same: one short poll carries it,
    // so Lavish's conversation shows what Flowryn recorded instead of waiting on an agent for good.
    for (const [gate, reply] of this.replies) {
      if (wanted.has(gate) || this.running.has(gate) || this.recording.has(gate)) continue;
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
    const takeover = this.takeover.delete(gate);
    const args = [lavish, "poll", page, ...(reply ? ["--agent-reply", reply] : []), ...(takeover ? ["--takeover"] : []), ...(final ? ["--timeout-ms", String(FINAL_POLL_MS)] : [])];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" } });
    } catch (error) {
      this.finished(gate, page, -1, "", `cannot run ${lavish}: ${(error as Error).message}`, final).catch((e) => this.deps.log(`lavish: the failed poll of gate ${gate} could not be recorded: ${(e as Error).stack ?? String(e)}`));
      return;
    }
    const entry: Running = { page, proc, stopped: false, final, steady: null };
    this.running.set(gate, entry);
    this.keepPid(gate, proc.pid, page);
    if (!final) entry.steady = setTimeout(() => this.listening(gate, entry), this.deps.steadyMs ?? STEADY_MS);
    void (async () => {
      let recording = false;
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
        if (entry.steady) clearTimeout(entry.steady);
        this.dropPid(gate, proc.pid);
        if (this.running.get(gate) === entry) this.running.delete(gate);
        if (entry.stopped || this.closed) return;
        recording = true;
        this.recording.add(gate);
        await this.finished(gate, page, code, stdout, stderr, final);
      } catch (error) {
        if (entry.steady) clearTimeout(entry.steady);
        if (this.running.get(gate) === entry) this.running.delete(gate);
        this.deps.log(`lavish: the poll of gate ${gate} could not be recorded: ${(error as Error).stack ?? String(error)}`);
      } finally {
        if (recording) this.recording.delete(gate);
      }
      this.kick();
    })();
  }

  /** The poll has kept running STEADY_MS: the channel listens (written only when that is news). */
  private listening(gate: string, entry: Running): void {
    entry.steady = null;
    if (entry.stopped || this.closed || this.running.get(gate) !== entry) return;
    try {
      if (recordChannelOk(this.deps.db, gate, "listening", this.deps.now())) this.deps.log(`lavish: gate ${gate}'s poll is listening`);
    } catch (error) {
      this.deps.log(`lavish: cannot record gate ${gate}'s channel listening: ${(error as Error).message}`);
    }
  }

  private halt(gate: string): void {
    const entry = this.running.get(gate);
    if (!entry) return;
    if (entry.steady) clearTimeout(entry.steady);
    entry.stopped = true;
    this.running.delete(gate);
    entry.proc.kill("SIGTERM");
  }

  private async finished(gate: string, page: string, code: number, stdout: string, stderr: string, final = false): Promise<void> {
    const now = this.deps.now();
    if (code !== 0) {
      const why = pollFailureReason(code, stdout, stderr);
      // The last short poll for a gate no longer polled says nothing about a channel nobody listens on.
      if (final) {
        this.deps.log(`lavish: the last poll of gate ${gate} failed (${why}); its reply is dropped`);
        return;
      }
      const failures = channelFailures(this.deps.db, gate) + 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
      this.waitUntil.set(gate, now + delay);
      this.deps.log(`lavish: the poll of gate ${gate} failed (${why}); again in ${delay / 1000} s`);
      const item = recordChannelFailure(this.deps.db, gate, { reason: why, retryAt: now + delay, alertMs: this.deps.channelAlertMs?.() ?? DEFAULT_CHANNEL_ALERT_MS, now });
      if (item) this.deps.log(`lavish: gate ${gate}'s review page is not delivering answers; item ${item} opened`);
      return;
    }
    this.waitUntil.delete(gate);
    if (!final && recordChannelOk(this.deps.db, gate, "delivered", now)) this.deps.log(`lavish: gate ${gate}'s poll delivered`);
    const out = parsePollOutput(stdout);
    await this.record(gate, page, out, stdout);
  }

  private async record(gate: string, page: string, out: PollOutput, raw: string): Promise<void> {
    let notes: string | null = null;
    const others = out.otherPrompts > 0 || out.malformed > 0;
    const said = out.sends.filter((s) => s.gate === gate && s.comment !== null).map((s) => sanitizeBlock(s.comment!).trim()).filter((c) => c.length > 0);
    if (others || said.length > 0) {
      const path = join(dirname(page), `lavish-notes-${gate}.txt`);
      const stamp = new Date(this.deps.now()).toISOString();
      const text = [...(others ? [`--- ${stamp}\n${raw}\n`] : []), ...said.map((c) => `--- ${stamp} anything else for the worker\n${c}\n`)].join("");
      try {
        appendNotes(page, path, text);
        notes = path;
      } catch (error) {
        this.deps.log(`lavish: cannot keep gate ${gate}'s notes in ${path}: ${(error as Error).message}`);
      }
    }
    const ctx = { db: this.deps.db, now: this.deps.now };
    const pagePass = this.deps.pagePass;
    // The reviewed HEAD of each gate a Send asks to pass, read before the transaction (git is not in it).
    const heads = new Map<string, string>();
    if (pagePass) for (const s of out.sends) if (s.pass && !heads.has(s.gate)) heads.set(s.gate, await pagePass.head(s.gate));
    // What goes to the worker: the user's own words (chat, annotations) and each Send's "anything else" for this gate.
    const words: UserMessage[] = [...out.messages, ...said.map((c) => ({ said: c, on: null }))];
    const { outcomes, comments, passes, routed, summary } = tx(this.deps.db, () => {
      const results = out.answers.map((a) => ({ decision: a.decision, outcome: lavishAnswer(ctx, a) }));
      // A Send names its gate; one for another gate (a stale page) is recorded against that gate's own rules.
      const kept = out.sends.filter((s) => s.comment !== null).map((s) => recordGateComment(this.deps.db, s.gate, s.comment!, this.deps.now()));
      if (notes) recordGateNotes(this.deps.db, gate, notes, out.otherPrompts + out.malformed, this.deps.now());
      const answers = gateQuestions(this.deps.db, gate)
        .filter((d) => d.state === "answered")
        .map((d) => `${d.id} = ${sanitizeLine(d.answer ?? "-", 200)}`);
      const sent = routePageBatch(this.deps.db, gate, { messages: words, answers, ended: out.ended }, this.deps.now());
      // After the words went their way: a pass closes the gate.
      const minting = new Set<string>();
      const asked = out.sends.filter((s) => s.pass).map((s) => this.passSend(s.gate, s.code, heads.get(s.gate) ?? null, minting));
      let item: string | null = null;
      if (out.ended && !asked.some((a) => a.gate === gate && a.page?.outcome === "passed")) {
        recordLavishEnded(this.deps.db, gate, this.deps.now());
        item = summarizeReview(this.deps.db, gate, "ended", this.deps.now(), this.deps.log);
      }
      return { outcomes: results, comments: kept, passes: asked, routed: sent, summary: item };
    });
    for (const p of passes) {
      if (p.page?.outcome === "passed") {
        const run = (this.deps.db.query("SELECT run_id FROM gates WHERE id = ?1").get(p.gate) as { run_id: string } | null)?.run_id;
        if (run) pagePass?.passed(run);
      }
      if (p.minted && pagePass) p.reached = await this.sendCode(pagePass, p.gate, p.minted);
    }
    if (routed && routed.to !== "nobody") {
      const run = (this.deps.db.query("SELECT run_id FROM gates WHERE id = ?1").get(gate) as { run_id: string } | null)?.run_id;
      if (run) this.deps.routed?.(run, routed.to === "resumed" || routed.to === "new_run");
    }
    const recorded = outcomes.length > 0 || comments.length > 0 || passes.length > 0;
    if (!out.ended && (recorded || routed)) {
      const text = this.replyText(gate, outcomes, routed, comments, passes, out.feedback.some(readsAsPass));
      const queued = this.replies.get(gate);
      this.replies.set(gate, { page, text: queued ? `${queued.text}\n\n${text}` : text });
    }
    const extra = [comments.length > 0 ? `comment ${comments.join(", ")}` : null, passes.length > 0 ? `pass ${passes.map(passLog).join(", ")}` : null].filter(Boolean);
    const to = routed ? `, ${words.length} message(s) ${routed.to === "nobody" ? `kept (${routed.why})` : `to the worker (${routed.to})`}` : "";
    this.deps.log(`lavish: gate ${gate}: ${outcomes.length > 0 ? outcomes.map((o) => `${o.decision} ${o.outcome}`).join(", ") : "no answers"}${extra.length > 0 ? `, ${extra.join(", ")}` : ""}${to}${out.ended ? `, the user ended the session${summary ? ` (summary ${summary})` : ""}` : ""}`);
  }

  /** The reply Lavish shows the user: what was recorded, where their words went, and what comes next. */
  private replyText(gate: string, outcomes: { decision: string; outcome: string }[], routed: Routed | null, comments: string[] = [], passes: PassOutcome[] = [], passWords = false): string {
    const said = (outcome: string) => outcomes.filter((o) => o.outcome === outcome).map((o) => o.decision);
    const parts: string[] = [];
    if (said("recorded").length > 0) parts.push(`Flowryn recorded your answer to ${said("recorded").join(", ")}.`);
    if (said("late").length > 0) parts.push(`${said("late").join(", ")} already had an answer; it stands.`);
    if (said("invalid").length > 0) parts.push(`${said("invalid").join(", ")}: the choice was not one the question offers; answer again.`);
    if (said("stale").length > 0) parts.push("An answer from an earlier version of this page was ignored.");
    if (comments.includes("late")) parts.push("The review had already closed, so your note for the worker was not kept.");
    if (routed) parts.push(routedReply(routed));
    const last = passes[passes.length - 1];
    if (last?.page?.outcome === "passed") {
      parts.push(`The review passed with your pass code; the ${last.page.passed.next} stage starts now.`);
      return parts.join(" ");
    }
    if (last?.page) {
      const refused = pageRefusal(last.page);
      if (refused) parts.push(refused);
    }
    const pass = last?.request ?? null;
    if (pass?.outcome === "questions_open") parts.push(`Pass not requested: ${pass.open.join(", ")} still open; answer ${pass.open.length === 1 ? "it" : "them"} first.`);
    const asked = pass?.outcome === "requested" || pass?.outcome === "already";
    if (asked && last?.reached !== undefined) {
      parts.push(last.reached.length > 0
        ? "A pass code went to your notifications (good for 10 minutes): type it in the pass code field and press Send and pass. Your leader can also confirm the pass with you."
        : "Pass requested, but no pass code could be sent (notifications are off or not set up): your leader asks you to confirm it, or you run flowryn approve in your terminal.");
    } else if (asked && !last?.page) parts.push("Pass requested. This page cannot pass the review: your leader asks you to confirm it, or you run flowryn approve in your terminal.");
    else if (asked) parts.push("Your leader can also confirm the pass with you, or you run flowryn approve in your terminal.");
    if (pass?.outcome === "late") parts.push("The review had already closed.");
    if (passWords && !asked) parts.push("If you meant to pass the review: only you can, outside this page; tell your leader, or run flowryn approve in your terminal.");
    const { total, open } = this.deps.db.query("SELECT COUNT(*) AS total, COALESCE(SUM(state = 'open'), 0) AS open FROM decisions WHERE gate_id = ?1").get(gate) as { total: number; open: number };
    if (open > 0) parts.push(`${open} question${open === 1 ? "" : "s"} still open.`);
    else if (total > 0 && !asked) parts.push("Every question is answered; the review now waits for your pass in Flowryn.");
    return parts.join(" ");
  }

  /**
   * One Send's pass, in the caller's transaction: with a code, the page passes the gate if the code
   * is right (else the leader's request still opens); with none, the leader's request opens and a
   * fresh code is minted for you, at most one per gate in a batch (`minting`) and none past the
   * gate's PAGE_CODE_MINTS. Without pagePass, only the request.
   */
  private passSend(gate: string, code: string | null, head: string | null, minting: Set<string>): PassOutcome {
    const now = this.deps.now();
    const pagePass = this.deps.pagePass;
    if (pagePass && code !== null && head !== null) {
      const page = passFromPage(this.deps.db, pagePass.codes, gate, code, head, now);
      if (page.outcome === "passed" || page.outcome === "stale" || page.outcome === "late") return { gate, page, request: page.outcome === "passed" ? null : { outcome: page.outcome }, minted: null };
      if (page.outcome === "questions_open") return { gate, page: null, request: { outcome: "questions_open", open: page.open }, minted: null };
      if (page.outcome === "draft_changed") return { gate, page, request: null, minted: null };
      return { gate, page, request: requestGatePass(this.deps.db, gate, now), minted: null };
    }
    const request = requestGatePass(this.deps.db, gate, now);
    const asked = request.outcome === "requested" || request.outcome === "already";
    const minted = pagePass && head !== null && asked && !minting.has(gate) ? pagePass.codes.mint(gate, head, now) : null;
    minting.add(gate);
    return { gate, page: null, request, minted };
  }

  /** Send a fresh code to you, in the text only (a notify command's title is in its environment); the log and the event name the channels, never the code. */
  private async sendCode(pagePass: NonNullable<PollerDeps["pagePass"]>, gate: string, code: PageCode): Promise<string[]> {
    const row = this.deps.db.query("SELECT g.stage, r.task_id, r.id AS run_id FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1").get(gate) as { stage: string; task_id: string; run_id: string } | null;
    const what = row ? `the ${row.stage} review of ${row.task_id}` : `review gate ${gate}`;
    let reached: string[] = [];
    try {
      reached = await pagePass.sendCode(gate, "Flowryn pass code", `Type ${code.code} on the review page to pass ${what} (good for 10 minutes).`);
    } catch (error) {
      this.deps.log(`lavish: gate ${gate}'s pass code was not sent: ${(error as Error).message.replaceAll(code.code, "****")}`);
    }
    // A code nobody can read is no use: it is dropped, and the leader's request stands.
    if (reached.length === 0) pagePass.codes.drop(gate);
    try {
      tx(this.deps.db, () => appendEvent(this.deps.db, { source: "daemon", kind: "gate.pass_code_sent", ...(row ? { runId: row.run_id, taskId: row.task_id } : {}), payload: { gate, channels: reached }, ts: this.deps.now() }));
    } catch (error) {
      this.deps.log(`lavish: cannot record gate ${gate}'s pass code send: ${(error as Error).message}`);
    }
    this.deps.log(`lavish: gate ${gate}'s pass code ${reached.length > 0 ? `sent (${reached.join(", ")})` : "not sent: no channel reached you"}`);
    return reached;
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

  /** The sweep of an earlier daemon's polls, once the first pass started it (tests wait on it). */
  swept(): Promise<void> {
    return this.sweep ?? Promise.resolve();
  }

  /** Start the sweep; with no records it is done at once, so the first pass polls without waiting. */
  private startSweep(): Promise<void> {
    const records = this.leftoverRecords();
    if (records.length === 0) {
      this.sweepDone = true;
      return Promise.resolve();
    }
    return this.sweepOrphans(records)
      .catch((error: unknown) => this.deps.log(`lavish: the sweep of leftover polls failed: ${(error as Error).message}`))
      .finally(() => {
        this.sweepDone = true;
        this.kick();
      });
  }

  private leftoverRecords(): { file: string; text: string }[] {
    const dir = this.deps.pidDir;
    if (!dir || !existsSync(dir)) return [];
    const records: { file: string; text: string }[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      try {
        records.push({ file, text: readFileSync(file, "utf8") });
      } catch (error) {
        this.deps.log(`lavish: cannot read the leftover poll record ${file}: ${(error as Error).message}`);
      }
    }
    return records;
  }

  /**
   * Kill the polls an earlier daemon left running: a recorded pid whose command
   * line is still that poll. No poll starts until this is done, and a record is
   * removed only while it still reads as it did. A record ps cannot check is
   * kept and logged, so the next start checks it again: a failed ps is never "gone".
   */
  private async sweepOrphans(records: { file: string; text: string }[]): Promise<void> {
    const ps = this.deps.ps ?? "/bin/ps";
    for (const { file, text } of records) {
      try {
        const { pid, page } = JSON.parse(text) as { pid: number; page: string };
        if (Number.isInteger(pid) && pid > 1) {
          const read = await runBounded([ps, "-o", "command=", "-p", String(pid)], { label: "ps", timeoutMs: PS_TIMEOUT_MS, stderr: "pipe" });
          const command = pidsTooLarge(read)?.every((refused) => refused === pid) ? "" : psAnswer(ps, read).trim();
          if (command.includes(" poll ") && command.includes(page)) {
            process.kill(pid, "SIGTERM");
            this.deps.log(`lavish: stopped a poll an earlier daemon left running (pid ${pid}, ${page})`);
          }
        }
      } catch (error) {
        if (error instanceof PsUnavailable) {
          this.deps.log(`lavish: cannot check the leftover poll in ${file}; its record is kept for the next start: ${error.message}`);
          this.setAside(file);
          continue;
        }
        this.deps.log(`lavish: cannot check the leftover poll in ${file}: ${(error as Error).message}`);
      }
      this.forgetRecord(file, text);
    }
  }

  /** Keep an unchecked record under a name no poll of this daemon writes (a new poll of the gate rewrites `<gate>.json`). */
  private setAside(file: string): void {
    if (file.endsWith(UNCHECKED_SUFFIX)) return;
    try {
      renameSync(file, `${file.slice(0, -".json".length)}.${Date.now()}${UNCHECKED_SUFFIX}`);
    } catch (error) {
      this.deps.log(`lavish: cannot keep the unchecked poll record ${file}: ${(error as Error).message}`);
    }
  }

  /** Remove a leftover record unless a poll of this daemon has rewritten it since. */
  private forgetRecord(file: string, text: string): void {
    try {
      if (readFileSync(file, "utf8") === text) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  }
}

/** Why a gate with a failing channel is no longer polled, for its gate.channel_cleared event. */
function notPolledWhy(db: Db, gateId: string): string {
  const gate = db.query("SELECT g.state, g.lavish_ended, g.page_path, r.state AS run_state FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1").get(gateId) as {
    state: string;
    lavish_ended: number;
    page_path: string | null;
    run_state: string;
  } | null;
  if (!gate) return "the gate is gone";
  if (gate.state !== "open") return `the gate closed (${gate.state})`;
  if (["cleaned", "failed", "cancelled"].includes(gate.run_state)) return `the run ${gate.run_state}`;
  if (gate.lavish_ended === 1) return "the user ended the Lavish session";
  return "the gate is no longer polled";
}

/** A pass for the log: the outcome only. */
function passLog(p: PassOutcome): string {
  if (p.page) return `page ${p.page.outcome}`;
  return `${p.request?.outcome ?? "-"}${p.minted ? " (code minted)" : ""}`;
}

/** Why a typed pass code did not pass the review, for the page. */
function pageRefusal(page: PagePass): string | null {
  const fresh = "press Send and pass with the code field empty for a new one";
  switch (page.outcome) {
    case "wrong":
      return "That pass code is wrong; check your notification and try again (three wrong tries void it).";
    case "voided":
      return `That pass code was wrong too often and no longer works; ${fresh}.`;
    case "expired":
      return `That pass code expired; ${fresh}.`;
    case "moved":
      return `The work changed since that pass code was sent, so it no longer works; look again, then ${fresh}.`;
    case "none":
      return `No pass code is waiting for this review (a restart forgets them); ${fresh}.`;
    case "draft_changed":
      return `Not passed: this page no longer shows the draft the review opened with. Send it back so the worker renders the draft again and opens a new review: flowryn gate changes ${page.task} --body-file -`;
    default:
      return null;
  }
}
