import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx, type Db } from "../../src/db/db.ts";
import { ANSWER_MARK, encodeSend } from "../../src/lavish/poll-output.ts";
import { LavishPoller } from "../../src/lavish/poller.ts";
import { parseGateQuestions } from "../../src/lavish/questions.ts";
import { WIDGET_FILE } from "../../src/lavish/widget.ts";
import { lavishAnswer } from "../../src/lifecycle/decision-verbs.ts";
import { openGateQuestions } from "../../src/lifecycle/gate-questions.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { HUMAN_CHANNELS, PAGE_CODE_MINTS, PAGE_CODE_TRIES, PAGE_CODE_TTL_MS, PageCodeStore } from "../../src/policy/approvals.ts";
import { passFromPage } from "../../src/policy/page-pass.ts";
import { makeHome, seedRun, waitUntil, type TestHome } from "../helpers/harness.ts";

/**
 * Passing a review gate from its page with the pass code sent to your
 * notifications (docs/notes/2026-10-30-pass-a-review-c6.md): the code store,
 * the pass with every rule of a gate pass, and the poller's side (mint and
 * send on a pass without a code, pass with the right one, today's request
 * for the leader otherwise), never writing the code anywhere a worker reads.
 */

let h: TestHome;
let db: Db;
let page: string;
let runId: string;
let taskId: string;
const NOW = 1_000_000;
const HEAD = "abc123";

const QUESTIONS = {
  questions: [{ key: "store", kind: "single", question: "Where?", options: ["db", "file"], recommend: "db", blocks: "which store the cache writes to" }],
  decided: [],
};

beforeEach(() => {
  h = makeHome();
  const seeded = seedRun(h);
  runId = seeded.runId;
  taskId = seeded.taskId;
  db = h.db();
  mkdirSync(join(h.dataDir, taskId, "design"), { recursive: true });
  page = join(realpathSync(join(h.dataDir, taskId)), "design", "design.html");
  writeFileSync(page, `<html data-lavish-live-reload-root><body><section id="flowryn-questions"></section><script src="${WIDGET_FILE}"></script></body></html>`);
  db.query("UPDATE runs SET workflow = 'feature', stage = 'design', stage_state = 'review' WHERE id = ?1").run(runId);
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, page_path, state, opened_at) VALUES ('g1', ?1, 'design', 'review', 'http://127.0.0.1:4387/session/x', ?2, 'open', ?3)").run(runId, page, NOW);
  tx(db, () => openGateQuestions(db, getRun(db, runId)!, { id: "g1", stage: "design", review_url: null }, page, parseGateQuestions(JSON.stringify(QUESTIONS)), NOW));
});
afterEach(() => {
  db.close();
  h.cleanup();
});

function answerAll(): void {
  tx(db, () => lavishAnswer({ db, now: () => NOW }, { gate: "g1", decision: "q1", choice: ["db"], note: null }));
}

function gateState(): string {
  return (db.query("SELECT state FROM gates WHERE id = 'g1'").get() as { state: string }).state;
}

describe("the page code store", () => {
  test("a code is 4 letters, used once, and checked against the HEAD it was minted for", () => {
    const codes = new PageCodeStore();
    const minted = codes.mint("g1", HEAD, NOW)!;
    expect(minted.code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    expect(codes.check("g1", minted.code.toLowerCase(), HEAD, NOW + 1)).toBe("ok");
    expect(codes.check("g1", minted.code, HEAD, NOW + 2)).toBe("none");
    const again = codes.mint("g1", HEAD, NOW)!;
    expect(codes.check("g1", again.code, "def456", NOW + 1)).toBe("moved");
    expect(codes.check("g1", again.code, HEAD, NOW + 2)).toBe("none");
  });

  test("it expires after its TTL, and the third wrong try voids it", () => {
    const codes = new PageCodeStore();
    const late = codes.mint("g1", HEAD, NOW)!;
    expect(codes.check("g1", late.code, HEAD, NOW + PAGE_CODE_TTL_MS)).toBe("expired");
    const right = codes.mint("g1", HEAD, NOW)!.code;
    const wrong = right === "AAAA" ? "BBBB" : "AAAA";
    for (let i = 1; i < PAGE_CODE_TRIES; i++) expect(codes.check("g1", wrong, HEAD, NOW)).toBe("wrong");
    expect(codes.check("g1", wrong, HEAD, NOW)).toBe("voided");
    expect(codes.check("g1", right, HEAD, NOW)).toBe("none");
  });

  test("a new code never buys more guesses: the wrong tries count per gate, and a spent gate's next wrong try voids its code", () => {
    const codes = new PageCodeStore();
    const first = codes.mint("g1", HEAD, NOW)!.code;
    const wrongFor = (code: string) => (code === "AAAA" ? "BBBB" : "AAAA");
    for (let i = 1; i < PAGE_CODE_TRIES; i++) expect(codes.check("g1", wrongFor(first), HEAD, NOW)).toBe("wrong");
    const second = codes.mint("g1", HEAD, NOW)!.code;
    expect(codes.check("g1", wrongFor(second), HEAD, NOW)).toBe("voided");
    expect(codes.check("g1", second, HEAD, NOW)).toBe("none");
    const third = codes.mint("g1", HEAD, NOW)!.code;
    expect(codes.check("g1", wrongFor(third), HEAD, NOW)).toBe("voided");
    // Another gate keeps its own count.
    const other = codes.mint("g2", HEAD, NOW)!.code;
    expect(codes.check("g2", wrongFor(other), HEAD, NOW)).toBe("wrong");
  });

  test(`a gate mints at most ${PAGE_CODE_MINTS} codes; after that none, and the last one is gone`, () => {
    const codes = new PageCodeStore();
    for (let i = 0; i < PAGE_CODE_MINTS; i++) expect(codes.mint("g1", HEAD, NOW)).not.toBeNull();
    expect(codes.has("g1", NOW)).toBe(true);
    expect(codes.mint("g1", HEAD, NOW)).toBeNull();
    expect(codes.has("g1", NOW)).toBe(false);
    // Dropping a code (none reached you) does not give the mints back.
    codes.drop("g1");
    expect(codes.mint("g1", HEAD, NOW)).toBeNull();
    expect(codes.mint("g2", HEAD, NOW)).not.toBeNull();
  });

  test("page is a human channel, and the approvals table takes it", () => {
    expect(HUMAN_CHANNELS).toContain("page");
    expect(() => db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at) VALUES ('ax', 't', 'gate:g1', 'h', 'page', 'me', 'gate', 1, 2)").run()).not.toThrow();
    expect(() => db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at) VALUES ('ay', 't', 'gate:g1', 'h', 'lavish', 'me', 'gate', 1, 2)").run()).toThrow(/CHECK/);
  });
});

describe("passing from the page", () => {
  test("the right code passes the gate with channel page, bound to the HEAD, the approval used once", () => {
    answerAll();
    const codes = new PageCodeStore();
    const { code } = codes.mint("g1", HEAD, NOW)!;
    const result = tx(db, () => passFromPage(db, codes, "g1", code, HEAD, NOW + 5));
    expect(result.outcome).toBe("passed");
    expect(gateState()).toBe("passed");
    expect(db.query("SELECT channel, head_sha, pr_url, action, consumed_at IS NOT NULL AS used FROM approvals").all()).toEqual([{ channel: "page", head_sha: HEAD, pr_url: "gate:g1", action: "gate", used: 1 }]);
    expect(db.query("SELECT stage FROM runs WHERE id = ?1").get(runId)).toEqual({ stage: "build" });
    // Single use: the same code again finds the gate closed.
    expect(tx(db, () => passFromPage(db, codes, "g1", code, HEAD, NOW + 6)).outcome).toBe("late");
  });

  test("an open question refuses, and drops the code that came with it", () => {
    const codes = new PageCodeStore();
    const { code } = codes.mint("g1", HEAD, NOW)!;
    expect(tx(db, () => passFromPage(db, codes, "g1", code, HEAD, NOW))).toEqual({ outcome: "questions_open", open: ["q1"] });
    expect(codes.has("g1", NOW)).toBe(false);
    expect(gateState()).toBe("open");
  });

  test("a guessed, moved, expired or missing code never passes, and the event names the outcome, never the code", () => {
    answerAll();
    const codes = new PageCodeStore();
    const { code } = codes.mint("g1", HEAD, NOW)!;
    const guess = code === "ZZZZ" ? "YYYY" : "ZZZZ";
    expect(tx(db, () => passFromPage(db, codes, "g1", guess, HEAD, NOW)).outcome).toBe("wrong");
    expect(tx(db, () => passFromPage(db, codes, "g1", code, "def456", NOW)).outcome).toBe("moved");
    expect(tx(db, () => passFromPage(db, codes, "g1", code, HEAD, NOW)).outcome).toBe("none");
    const late = codes.mint("g1", HEAD, NOW)!.code;
    expect(tx(db, () => passFromPage(db, codes, "g1", late, HEAD, NOW + PAGE_CODE_TTL_MS)).outcome).toBe("expired");
    expect(gateState()).toBe("open");
    expect(db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    const payloads = (db.query("SELECT payload FROM events WHERE kind = 'gate.page_pass_refused' ORDER BY seq").all() as { payload: string }[]).map((e) => JSON.parse(e.payload).why);
    expect(payloads).toEqual(["wrong", "moved", "none", "expired"]);
    const all = JSON.stringify(db.query("SELECT payload FROM events").all());
    expect(all).not.toContain(code);
    expect(all).not.toContain(late);
  });

  test("changes void it: the gate closes, and a code for it never passes another", () => {
    answerAll();
    const codes = new PageCodeStore();
    const { code } = codes.mint("g1", HEAD, NOW)!;
    db.query("UPDATE gates SET state = 'changes' WHERE id = 'g1'").run();
    expect(tx(db, () => passFromPage(db, codes, "g1", code, HEAD, NOW)).outcome).toBe("late");
    db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at) VALUES ('g2', ?1, 'design', 'review', 'open', ?2)").run(runId, NOW + 1);
    expect(tx(db, () => passFromPage(db, codes, "g2", code, HEAD, NOW)).outcome).toBe("none");
  });
});

/** A lavish-axi stand-in whose first poll prints `output`, and each later one waits. */
function scriptedLavish(output: string): string {
  const out = join(h.home, "poll.out");
  writeFileSync(out, output);
  const bin = join(h.home, "scripted-lavish");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = poll ] && [ -f ${JSON.stringify(out)} ]; then cat ${JSON.stringify(out)}; rm -f ${JSON.stringify(out)}; exit 0; fi\necho "$@" >> ${JSON.stringify(join(h.home, "calls.log"))}\nsleep 30\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** One poll's output: a pass Send per code (null: none typed), the first carrying the answer. */
function sendOutput(...codes: (string | null)[]): string {
  const sends = (codes.length > 0 ? codes : [null]).map((code, i) => encodeSend({ gate: "g1", comment: null, pass: true, code }, i === 0 ? [{ decision: "q1", choice: ["db"], note: null }] : []));
  const prompts = sends.map((token, i) => `  - prompt: "Answers ${i}\\n${ANSWER_MARK} ${token}"\n`).join("");
  return `session:\n  status: feedback\nprompts[${sends.length}]:\n${prompts}`;
}

interface Sent {
  gate: string;
  title: string;
  text: string;
}

function pollerWith(output: string, codes: PageCodeStore, opts: { reach?: string[]; held?: Promise<void> } = {}) {
  const logs: string[] = [];
  const sent: Sent[] = [];
  const passed: string[] = [];
  const bin = scriptedLavish(output);
  const poller = new LavishPoller({
    db,
    lavish: () => bin,
    log: (m) => logs.push(m),
    now: () => NOW,
    pagePass: {
      codes,
      head: async () => HEAD,
      sendCode: async (gate, title, text) => {
        sent.push({ gate, title, text });
        await opts.held;
        return opts.reach ?? ["macos"];
      },
      passed: (run) => passed.push(run),
    },
  });
  return { poller, logs, sent, passed };
}

/** Everything a worker could read after the poll: the database, the notes and the widget beside the page, the log. */
function readable(logs: string[]): string {
  const dir = join(page, "..");
  const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
  const rows = ["events", "items", "approvals", "notifications", "gates"].map((t) => JSON.stringify(db.query(`SELECT * FROM ${t}`).all()));
  return [...files, ...rows, ...logs].join("\n");
}

describe("the poller's side", () => {
  test("a pass without a code opens the leader's request and sends a fresh code, which is written nowhere a worker reads", async () => {
    const codes = new PageCodeStore();
    const p = pollerWith(sendOutput(null), codes);
    try {
      p.poller.pass();
      await waitUntil(() => p.logs.some((l) => l.includes("pass code sent")), 5_000, "the code sent");
    } finally {
      p.poller.stop();
    }
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.title).toBe("Flowryn pass code");
    const code = /^Type ([A-Z]{4}) on the review page/.exec(p.sent[0]!.text)![1]!;
    expect(p.sent[0]!.text).toContain(`Type ${code} on the review page to pass the design review of ${taskId}`);
    expect(codes.has("g1", NOW)).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'pass_requested' AND state = 'open'").get()).toEqual({ n: 1 });
    expect(JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'gate.pass_code_sent'").get() as { payload: string }).payload)).toEqual({ gate: "g1", channels: ["macos"] });
    expect(readable(p.logs)).not.toContain(code);
    expect(gateState()).toBe("open");
  });

  test("one batch mints one code: a worker cannot queue fresh codes between guesses, and the guesses never pass", async () => {
    const codes = new PageCodeStore();
    const p = pollerWith(sendOutput(null, "AAAA", "BBBB", "CCCC", null, "DDDD", "EEEE", null, "FFFF"), codes);
    try {
      p.poller.pass();
      await waitUntil(() => p.logs.some((l) => l.includes("pass code sent")), 5_000, "the code sent");
    } finally {
      p.poller.stop();
    }
    expect(gateState()).toBe("open");
    expect(p.sent).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    const refused = (db.query("SELECT payload FROM events WHERE kind = 'gate.page_pass_refused' ORDER BY seq").all() as { payload: string }[]).map((e) => JSON.parse(e.payload).why);
    expect(refused).toEqual(["wrong", "wrong", "voided", "none", "none", "none"]);
  });

  test("the page's reply waits for the code send: no poll starts for the gate until it is queued, then the next poll carries it", async () => {
    const codes = new PageCodeStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const p = pollerWith(sendOutput(null), codes, { held });
    const calls = join(h.home, "calls.log");
    try {
      p.poller.pass();
      await waitUntil(() => p.sent.length === 1, 5_000, "the send started");
      p.poller.pass();
      await Bun.sleep(200);
      expect(existsSync(calls)).toBe(false);
      release();
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes("A pass code went to your notifications"), 5_000, "the reply on the next poll");
    } finally {
      release();
      p.poller.stop();
    }
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a code no channel reached is dropped, and the page hears the leader confirms instead", async () => {
    const codes = new PageCodeStore();
    const p = pollerWith(sendOutput(null), codes, { reach: [] });
    try {
      p.poller.pass();
      await waitUntil(() => p.logs.some((l) => l.includes("pass code not sent")), 5_000, "the send tried");
      await waitUntil(() => existsSync(join(h.home, "calls.log")) && readFileSync(join(h.home, "calls.log"), "utf8").includes("no pass code could be sent"), 5_000, "the reply");
    } finally {
      p.poller.stop();
    }
    expect(codes.has("g1", NOW)).toBe(false);
  });

  test("the right code passes the gate (channel page) and tells the daemon; the page hears the next stage started", async () => {
    const codes = new PageCodeStore();
    const { code } = codes.mint("g1", HEAD, NOW)!;
    const p = pollerWith(sendOutput(code.toLowerCase()), codes);
    try {
      p.poller.pass();
      await waitUntil(() => gateState() === "passed", 5_000, "the gate passed");
    } finally {
      p.poller.stop();
    }
    expect(db.query("SELECT channel FROM approvals").all()).toEqual([{ channel: "page" }]);
    expect(p.passed).toEqual([runId]);
    expect(p.sent).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'pass_requested'").get()).toEqual({ n: 0 });
    expect(p.logs.some((l) => l.includes("pass page passed"))).toBe(true);
  });

  test("a wrong code falls back to today's request for the leader; the gate stays open", async () => {
    const codes = new PageCodeStore();
    const { code } = codes.mint("g1", HEAD, NOW)!;
    const p = pollerWith(sendOutput(code === "QQQQ" ? "RRRR" : "QQQQ"), codes);
    try {
      p.poller.pass();
      await waitUntil(() => p.logs.some((l) => l.includes("pass page wrong")), 5_000, "the poll recorded");
    } finally {
      p.poller.stop();
    }
    expect(gateState()).toBe("open");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'pass_requested' AND state = 'open'").get()).toEqual({ n: 1 });
    expect(codes.has("g1", NOW)).toBe(true);
    expect(p.sent).toEqual([]);
  });

  test("without the page pass wired in, a pass is only the request, as before", async () => {
    const logs: string[] = [];
    const bin = scriptedLavish(sendOutput("ABCD"));
    const poller = new LavishPoller({ db, lavish: () => bin, log: (m) => logs.push(m), now: () => NOW });
    try {
      poller.pass();
      await waitUntil(() => logs.some((l) => l.startsWith("lavish: gate g1:")), 5_000, "the poll recorded");
    } finally {
      poller.stop();
    }
    expect(gateState()).toBe("open");
    expect(logs.some((l) => l.includes("pass requested"))).toBe(true);
  });
});
