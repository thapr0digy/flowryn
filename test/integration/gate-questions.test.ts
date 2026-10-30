import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { ANSWER_MARK, encodeAnswer, encodeSend } from "../../src/lavish/poll-output.ts";
import { lavishSessionKey } from "../../src/lavish/session-key.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import { tx } from "../../src/db/db.ts";
import { failRun, getRun } from "../../src/lifecycle/runs.ts";

/**
 * A review gate's questions, end to end on the fake fleet (design: "A
 * design's open questions become Flowryn decisions"): the fake worker writes
 * its page and questions.json and hands them in with stage done; the daemon
 * opens a reserved decision per question with the gate, writes the widget
 * beside the page and runs the test home's lavish-axi stand-in, whose poll
 * prints what the test queues in lavish-axi 0.1.65's own output format.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const PAGE = filledDesignPage({ widget: true });
const QUESTIONS = JSON.stringify({
  questions: [
    { key: "token-store", kind: "single", question: "Where do cached tokens live?", options: ["db", "file"], recommend: "db", blocks: "which store TokenCache writes to" },
    { key: "harnesses", kind: "multi", question: "Which harnesses first?", options: ["claude", "pi"], recommend: ["claude"], blocks: "which adapters the build touches" },
    { key: "verb-name", kind: "text", question: "What is the verb called?", recommend: "flowryn tokens", blocks: "the CLI name in code and docs" },
  ],
  decided: [{ choice: "poller home", picked: "src/lavish/poller.ts", why: "one child per gate" }],
});

function steps(name: string, after: string[]): string {
  return [
    `Feature ${name}`,
    `FAKE: write design/design.html ${PAGE}`,
    `FAKE: write design/questions.json ${QUESTIONS}`,
    // Questions without the page they go on: refused, and nothing opens.
    `FAKE: stage-done --review lavish:${name}/design.html --questions-file $FLOWRYN_REPORT_DIR/design/questions.json`,
    `FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/questions.json`,
    ...after,
  ].join("\n");
}

function rows<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T[] {
  const db = e.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function one<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T | null {
  return rows<T>(e, sql, ...params)[0] ?? null;
}

/** What the user "sent" from the page, as the next poll prints it (lavish-axi 0.1.65's TOON layout). */
function queuePoll(e: FleetEnv, n: number, gate: string, answers: { d: string; c: string[]; n?: string }[], annotations: string[] = []): void {
  const dir = join(e.h.home, "lavish-queue");
  mkdirSync(dir, { recursive: true });
  const prompts = [
    ...answers.map((a) => `  - uid: ""\n    prompt: ${JSON.stringify(`Answer to ${a.d}: ${a.c.join(", ")}\nflowryn-answer v1 ${encodeAnswer({ gate, decision: a.d, choice: a.c, note: a.n ?? null })}`)}\n    selector: ""\n    tag: choice\n    text: "${a.d}"\n    target:\n      type: flowryn-answer\n      decision: ${a.d}`),
    ...annotations.map((text) => `  - uid: x\n    prompt: ${JSON.stringify(text)}\n    selector: h1\n    tag: annotation\n    text: Design`),
  ];
  const out = `session:\n  file: /x/design.html\n  status: feedback\nprompts[${prompts.length}]:\n${prompts.join("\n")}\nnext_step: "Apply the requested changes."\ndom_snapshot: ""\n`;
  writeFileSync(join(dir, `${String(n).padStart(3, "0")}.out`), out);
}

/** One Send from the current widget: every answer, the comment and the pass request in one prompt. */
function queueSend(e: FleetEnv, n: number, gate: string, answers: { d: string; c: string[]; n?: string }[], comment: string | null, pass: boolean, code: string | null = null): void {
  const dir = join(e.h.home, "lavish-queue");
  mkdirSync(dir, { recursive: true });
  const token = encodeSend({ gate, comment, pass, code }, answers.map((a) => ({ decision: a.d, choice: a.c, note: a.n ?? null })));
  const prompt = `  - uid: ""\n    prompt: ${JSON.stringify(`Answers for the design review (gate ${gate}):\n${ANSWER_MARK} ${token}`)}\n    selector: ""\n    tag: choice\n    text: answers\n    target:\n      type: flowryn-answers\n      gate: ${gate}`;
  writeFileSync(join(dir, `${String(n).padStart(3, "0")}.out`), `session:\n  file: /x/design.html\n  status: feedback\nprompts[1]:\n${prompt}\nnext_step: "Apply the requested changes."\ndom_snapshot: ""\n`);
}

describe("a review gate's questions", () => {
  test(
    "open as reserved decisions with the gate; answered on the page and through the leader; held until the verdict, which carries them",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: steps("q", ["FAKE: sleep 120000"]) });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };

      const [refused, handed] = await e.replies(task, 2);
      expect((refused!.reply.error as { code: string; message: string }).message).toContain("--questions-file needs --page");
      expect(handed!.code).toBe(0);
      expect(handed!.reply.data).toMatchObject({ stage: "design", state: "review", questions: ["q1", "q2", "q3"] });
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const gate = one<{ id: string; page_path: string }>(f, "SELECT id, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;

      // Item 3: each question is a decision reserved for the user, open as the gate opens, listed for the leader.
      const reserved = await f.json(["decision", "list", "--reserved"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect((reserved.reply.data as { decisions: { id: string; gate: string }[] }).decisions.map((d) => [d.id, d.gate])).toEqual([
        ["q1", gate.id],
        ["q2", gate.id],
        ["q3", gate.id],
      ]);
      const shown = await f.json(["show", "q2"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(shown.reply.data).toMatchObject({ decision: "q2", kind: "multi", gate: gate.id, blocks: "which adapters the build touches", reserved: "a review question for the user" });
      expect(one<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'gate_ready' AND run_id = ?1", run)!.line).toContain("with 3 questions for you (q1, q2, q3)");
      // Away mode: show names the open gate's page file, so the leader can publish it as an artifact.
      const shownTask = await f.json(["show", task], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      const gateLine = (shownTask.reply.data as { gates: string[] }).gates.find((l) => l.startsWith(`${gate.id} `));
      expect(gateLine).toContain(`: open`);
      expect(gateLine).toContain(` page ${gate.page_path}`);

      // Item 1: the widget beside the page, and the daemon's poll of that page.
      const widget = join(gate.page_path, "..", "flowryn-questions.js");
      await waitUntil(() => existsSync(widget), 10_000, "the question widget");
      expect(readFileSync(widget, "utf8")).toContain('"recommend":["db"]');
      const calls = join(f.h.home, "lavish-calls.log");
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes(`poll ${gate.page_path}`), 10_000, "the lavish-axi poll");

      // q3 (refuse): no gate pass while a question is open, from any channel.
      const early = await e.approve(task, { gate: "design" });
      expect(early.ok).toBe(false);
      expect(early.error).toMatchObject({ code: "questions_open" });
      const leaderEarly = await f.json(["gate", "pass", task], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(leaderEarly.reply.error).toMatchObject({ code: "questions_open" });

      // Item 2: the page's answer is recorded as the user's (captain, via lavish); a note on the page is kept too.
      queuePoll(f, 1, gate.id, [{ d: "q1", c: ["file"], n: "file survives resets" }], ["Make the header bigger"]);
      await waitUntil(() => one<{ state: string }>(f, "SELECT state FROM decisions WHERE id = 'q1'")?.state === "answered", 10_000, "q1 answered from the page");
      expect(one<Record<string, unknown>>(f, "SELECT answer, answered_by, answered_via, rationale FROM decisions WHERE id = 'q1'")).toEqual({ answer: "file", answered_by: "captain", answered_via: "lavish", rationale: "file survives resets" });
      const notes = join(gate.page_path, "..", `lavish-notes-${gate.id}.txt`);
      await waitUntil(() => existsSync(notes), 10_000, "the kept notes");
      expect(readFileSync(notes, "utf8")).toContain("Make the header bigger");
      // What the user wrote goes to the worker as one steer, with the answers so far; nothing wakes the leader.
      await waitUntil(() => one(f, "SELECT 1 FROM messages WHERE run_id = ?1 AND body LIKE '%Make the header bigger%'", run) !== null, 10_000, "the page steer");
      const pageSteer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%Make the header bigger%'", run)!.body;
      expect(pageSteer).toContain('[on the page text "Design"]\nMake the header bigger');
      expect(pageSteer).toContain("[answers to your review questions so far: q1 = file]");
      expect(rows(f, "SELECT 1 FROM items WHERE kind IN ('review_feedback','review_summary') AND run_id = ?1", run)).toEqual([]);

      // The leader relays q3 through Claude's prompt; the answer is held from the worker while the gate is open.
      const relayed = await leader.runBash(`flowryn decide q3 "flowryn keys" --by captain --json`, { approve: true });
      expect(relayed).toMatchObject({ prompted: true, ran: true, code: 0 });
      expect(JSON.parse(relayed.stdout).data).toMatchObject({ decision: "q3", answer: "flowryn keys", by: "captain", steer: "held for the verdict" });

      // One Send from the page: a late answer to q3 changes nothing; q2's goes in, with a note for the
      // worker and a pass request, which opens a P1 for the leader and never passes the gate itself.
      queueSend(f, 2, gate.id, [
        { d: "q2", c: ["claude", "pi"] },
        { d: "q3", c: ["something else"] },
      ], "Keep the CLI name short.", true);
      await waitUntil(() => one<{ state: string }>(f, "SELECT state FROM decisions WHERE id = 'q2'")?.state === "answered", 10_000, "q2 answered from the page");
      expect(one<Record<string, unknown>>(f, "SELECT answer, answered_via FROM decisions WHERE id = 'q3'")).toEqual({ answer: "flowryn keys", answered_via: "claude-ask" });
      expect(JSON.parse(one<{ payload: string }>(f, "SELECT payload FROM events WHERE kind = 'decision.lavish_ignored'")!.payload)).toMatchObject({ decision: "q3", outcome: "late" });
      expect(rows(f, "SELECT 1 FROM messages WHERE run_id = ?1 AND body LIKE 'Answer to your question%'", run)).toEqual([]);
      await waitUntil(() => readFileSync(widget, "utf8").includes('"answer":"claude, pi"'), 10_000, "the widget shows q2 answered");
      expect(readFileSync(widget, "utf8")).toContain('"via":"your leader"');
      // Lavish's conversation hears what Flowryn recorded with the next poll, which keeps listening while the gate is open.
      await waitUntil(() => readFileSync(calls, "utf8").includes("--agent-reply Flowryn recorded your answer to q1. Sent to the worker; its answer will appear here. 2 questions still open."), 10_000, "the reply after q1");
      await waitUntil(() => /--agent-reply Flowryn recorded your answer to q2\. q3 already had an answer; it stands\. Sent to the worker; its answer will appear here\. A pass code went to your notifications \(good for 10 minutes\): type it in the pass code field and press Send and pass\. Your leader can also confirm the pass with you\.(?! --timeout-ms)/.test(readFileSync(calls, "utf8")), 10_000, "the last reply");
      expect(one<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'pass_requested' AND run_id = ?1 AND state = 'open'", run)!.line).toContain(`flowryn gate pass ${task} --gate-id ${gate.id}`);
      expect(one<{ state: string }>(f, "SELECT state FROM gates WHERE id = ?1", gate.id)).toEqual({ state: "open" });

      // Every question answered: the gate passes, and the verdict steer carries the answers and the notes.
      const passed = await e.approve(task, { gate: "design" });
      expect(passed.ok).toBe(true);
      await f.waitRun(run, (r) => r.stage === "build", "the build stage");
      const steer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE 'The design review passed%'", run)!;
      expect(steer.body).toContain("The user's answers to your review questions: q1 (token-store) = file [their note: file survives resets]; q2 (harnesses) = claude, pi; q3 (verb-name) = flowryn keys.");
      // The worker saw each message as it came: the verdict points at the conversation and the raw notes.
      const conversation = join(gate.page_path, "..", `review-${gate.id}.md`);
      expect(steer.body).toContain(`The review page's conversation with you is in ${conversation}.`);
      expect(steer.body).toContain(`read ${notes}`);
      expect(readFileSync(conversation, "utf8")).toContain("Keep the CLI name short.");
      expect(one<{ line: string }>(f, "SELECT COALESCE(full_line, line) AS line FROM items WHERE kind = 'review_recap' AND run_id = ?1", run)!.line).toContain(`Review of ${task} (design gate ${gate.id}): the review passed; 2 messages from the user, 0 replies, answered q1 = file, q2 = claude, pi`);
      expect(one<{ resolved_by: string }>(f, "SELECT resolved_by FROM items WHERE kind = 'pass_requested' AND run_id = ?1", run)).toEqual({ resolved_by: `gate.passed ${gate.id}` });
      await waitUntil(() => readFileSync(widget, "utf8").includes('"gateState":"passed"'), 10_000, "the widget locked");
    },
    { timeout: 120_000 },
  );

  test(
    "changes close the open questions; the next hand-in opens fresh ones; a bad questions file opens nothing",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const after = [
        "FAKE: write design/bad.json {\"questions\": [{\"key\": \"x\", \"question\": \"Which?\", \"options\": [\"a\", \"b\"], \"recommend\": \"a\"}]}",
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/bad.json",
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/questions.json",
        "FAKE: sleep 120000",
      ];
      const { task, run } = await f.dispatch(steps("c", after), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage_state === "review", "the first design review");
      const first = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1 AND state = 'open'", run)!.id;
      // Dismissing a review question's item is refused: only the user answers it.
      const q2Item = one<{ id: string }>(f, "SELECT id FROM items WHERE decision_id = 'q2'")!.id;
      const refused = await f.json(["dismiss", q2Item]);
      expect(refused.code).not.toBe(0);
      expect((refused.reply.error as { message: string }).message).toContain("only the user answers it");
      expect(one<{ decision: string; item: string }>(f, "SELECT d.state AS decision, i.state AS item FROM decisions d JOIN items i ON i.decision_id = d.id WHERE d.id = 'q2'")).toEqual({ decision: "open", item: "open" });
      expect(rows(f, "SELECT 1 FROM messages WHERE run_id = ?1 AND body LIKE '%was dismissed%'", run)).toEqual([]);
      // You answer q1 in your own shell (a human channel); "other" needs your words.
      const bare = await e.call("decide", { decision: "q1", choice: "other", by: "captain" });
      expect(bare.ok).toBe(false);
      expect((bare.error as { message: string }).message).toContain("needs your words");
      expect((await e.call("decide", { decision: "q1", choice: "other", by: "captain", words: "redis, shared with the cache" })).ok).toBe(true);

      const changes = await f.json(["gate", "changes", task, "--body-file", "-"], { stdin: "Split the token store question." });
      expect(changes.code).toBe(0);
      expect(rows<{ id: string; state: string }>(f, "SELECT id, state FROM decisions WHERE gate_id = ?1 ORDER BY id", first)).toEqual([
        { id: "q1", state: "answered" },
        { id: "q2", state: "dismissed" },
        { id: "q3", state: "dismissed" },
      ]);
      const steer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE 'Changes requested%'", run)!;
      expect(steer.body).toContain("Split the token store question. The user's answers to your review questions: q1 (token-store) = other [their words: redis, shared with the cache]. Closed unanswered: q2, q3.");

      // The worker's next hand-in: a question with no blocks is refused (the ask rule), then the good file opens q4-q6.
      const replies = await e.replies(task, 4);
      expect((replies[2]!.reply.error as { message: string }).message).toContain("blocks");
      await f.waitRun(run, (r) => r.stage_state === "review" && one(f, "SELECT 1 FROM gates WHERE run_id = ?1 AND state = 'open' AND id != ?2", run, first) !== null, "the second design review");
      const second = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1 AND state = 'open'", run)!.id;
      expect(rows<{ id: string }>(f, "SELECT id FROM decisions WHERE gate_id = ?1 ORDER BY id", second).map((d) => d.id)).toEqual(["q4", "q5", "q6"]);
      expect(rows(f, "SELECT 1 FROM decisions WHERE key = 'x'")).toEqual([]);

      // A daemon restart picks the poll up again from the database; an answer sent meanwhile is recorded.
      await f.daemon.stop();
      queuePoll(f, 1, second, [{ d: "q4", c: ["file"] }]);
      await f.restartDaemon();
      await waitUntil(() => one<{ state: string }>(f, "SELECT state FROM decisions WHERE id = 'q4'")?.state === "answered", 10_000, "q4 answered after the restart");
      expect(one<Record<string, unknown>>(f, "SELECT answered_by, answered_via FROM decisions WHERE id = 'q4'")).toEqual({ answered_by: "captain", answered_via: "lavish" });
    },
    { timeout: 90_000 },
  );

  test(
    "a failed run keeps its questions open until its cleanup ends it for good",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const { task, run } = await f.dispatch(steps("f", ["FAKE: sleep 120000"]), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage_state === "review", "the design review");
      const db = f.h.db();
      try {
        db.query("UPDATE runs SET state = 'failed', liveness = 'dead', ended_at = ?2 WHERE id = ?1").run(run, Date.now());
      } finally {
        db.close();
      }
      expect(rows<{ state: string }>(f, "SELECT state FROM decisions WHERE run_id = ?1 ORDER BY id", run).map((d) => d.state)).toEqual(["open", "open", "open"]);
      const cleaned = await f.json(["cleanup", task]);
      expect(cleaned.code).toBe(0);
      const gate = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1", run)!.id;
      expect(rows(f, "SELECT d.id, d.state, d.answered_via, i.resolved_by FROM decisions d JOIN items i ON i.decision_id = d.id WHERE d.run_id = ?1 ORDER BY d.id", run)).toEqual(
        ["q1", "q2", "q3"].map((id) => ({ id, state: "dismissed", answered_via: "run ended", resolved_by: `run.ended ${gate}` })),
      );
      expect(rows(f, "SELECT DISTINCT source FROM events WHERE kind = 'decision.dismissed' AND run_id = ?1", run)).toEqual([{ source: "daemon" }]);
      // Cleaned up, the run has ended for good: it is not resumed, so its gate cannot come back without its questions.
      const resumed = await f.json(["resume", task]);
      expect(resumed.code).not.toBe(0);
      expect(resumed.reply.error).toMatchObject({ code: "run_not_active" });
      expect((resumed.reply.error as { message: string }).message).toContain("cleaned up");
      expect(f.run(run).state).toBe("failed");
    },
    { timeout: 90_000 },
  );
});

/** Every file under a directory, skipping git's own (a worktree's objects are not ours). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === ".git" || name === "objects") return [];
    const st = statSync(path);
    return st.isDirectory() ? filesUnder(path) : st.isFile() ? [path] : [];
  });
}

describe("passing a review from its page with a pass code (docs/notes/2026-10-30-pass-a-review-c6.md)", () => {
  test(
    "Send and pass with no code sends one to your notifications; a wrong one is refused; the right one passes the gate (channel page) and the build starts; the code is written nowhere a worker reads",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: steps("pp", ["FAKE: sleep 120000"]) });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const gate = one<{ id: string; page_path: string }>(f, "SELECT id, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
      const calls = join(f.h.home, "lavish-calls.log");
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes(`poll ${gate.page_path}`), 10_000, "the lavish-axi poll");
      const answers = [
        { d: "q1", c: ["db"] },
        { d: "q2", c: ["claude"] },
        { d: "q3", c: ["flowryn tokens"] },
      ];

      // No code typed: the answers go in, the leader's request opens, and a code goes to the notification recorder.
      queueSend(f, 1, gate.id, answers, null, true);
      const notified = join(f.h.home, "notified.jsonl");
      await waitUntil(() => existsSync(notified) && readFileSync(notified, "utf8").includes("Flowryn pass code"), 10_000, "the pass code notification");
      const code = /Type ([A-Z]{4}) on the review page/.exec(readFileSync(notified, "utf8"))![1]!;
      expect(one<{ state: string }>(f, "SELECT state FROM gates WHERE id = ?1", gate.id)).toEqual({ state: "open" });
      expect(one(f, "SELECT 1 FROM items WHERE kind = 'pass_requested' AND run_id = ?1 AND state = 'open'", run)).not.toBeNull();
      await waitUntil(() => readFileSync(calls, "utf8").includes("A pass code went to your notifications"), 10_000, "the reply naming the code");

      // A wrong code: refused, the gate stays open.
      queueSend(f, 2, gate.id, [], null, true, code === "QQQQ" ? "RRRR" : "QQQQ");
      await waitUntil(() => readFileSync(calls, "utf8").includes("That pass code is wrong"), 10_000, "the wrong-code reply");
      expect(one<{ state: string }>(f, "SELECT state FROM gates WHERE id = ?1", gate.id)).toEqual({ state: "open" });

      // The right one, typed in lower case: the gate passes from the page and the build stage starts.
      queueSend(f, 3, gate.id, [], null, true, code.toLowerCase());
      await f.waitRun(run, (r) => r.stage === "build", "the build stage");
      const approval = one<{ channel: string; head_sha: string; used: number }>(f, "SELECT a.channel, a.head_sha, a.consumed_at IS NOT NULL AS used FROM approvals a JOIN gates g ON g.approval_id = a.id WHERE g.id = ?1", gate.id)!;
      expect(approval).toMatchObject({ channel: "page", used: 1 });
      expect(approval.head_sha).toMatch(/^[0-9a-f]{40}$/);
      // The scheduler grants the build stage, whose steer carries the verdict.
      await waitUntil(() => one(f, "SELECT 1 FROM messages WHERE run_id = ?1 AND body LIKE '%The design review passed (page).%'", run) !== null, 10_000, "the verdict steer");
      expect(one<{ resolved_by: string }>(f, "SELECT resolved_by FROM items WHERE kind = 'pass_requested' AND run_id = ?1", run)).toEqual({ resolved_by: `gate.passed ${gate.id}` });
      await waitUntil(() => readFileSync(calls, "utf8").includes("The review passed with your pass code; the build stage starts now."), 10_000, "the passed reply");

      // Nowhere a worker reads holds the code: the database, the logs, the report directory, Lavish's replies.
      const readable = [...filesUnder(f.h.stateDir), ...filesUnder(f.h.dataDir), ...readdirSync(f.h.home).filter((n) => n.endsWith(".log")).map((n) => join(f.h.home, n))];
      expect(readable.length).toBeGreaterThan(0);
      expect(readable.filter((path) => readFileSync(path).includes(code))).toEqual([]);
    },
    { timeout: 120_000 },
  );
});

describe("review-channel health", () => {
  test(
    "while the page's polls fail the questions wait with one review_channel item; once Lavish delivers again the answer is recorded as usual and the gate stays open",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: "[review]\nchannel_alert_ms = 0\n" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const queue = join(f.h.home, "lavish-queue");
      mkdirSync(queue, { recursive: true });
      for (const n of ["000", "001"]) writeFileSync(join(queue, `${n}.fail.out`), "error: Lavish Editor server connection failed\ncode: SERVER_ERROR\n");
      const { run } = await f.dispatch(steps("c", ["FAKE: sleep 120000"]), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage_state === "review", "the design review");
      const gate = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1 AND state = 'open'", run)!.id;
      await waitUntil(() => one(f, "SELECT 1 FROM items WHERE kind = 'review_channel' AND run_id = ?1 AND state = 'open'", run) !== null, 15_000, "the review_channel item");
      expect(one<Record<string, unknown>>(f, "SELECT channel_failures, channel_reason FROM gates WHERE id = ?1", gate)).toEqual({ channel_failures: 2, channel_reason: "error: Lavish Editor server connection failed (exit 1)" });
      expect(rows<{ state: string }>(f, "SELECT state FROM decisions WHERE gate_id = ?1", gate).map((d) => d.state)).toEqual(["open", "open", "open"]);

      // Lavish delivers what the user sent meanwhile: recorded as any answer is; the channel recovers; nothing passes.
      queuePoll(f, 2, gate, [{ d: "q1", c: ["db"] }]);
      await waitUntil(() => one<{ state: string }>(f, "SELECT state FROM decisions WHERE id = 'q1'")?.state === "answered", 15_000, "q1 answered from the page");
      expect(one<Record<string, unknown>>(f, "SELECT answered_by, answered_via FROM decisions WHERE id = 'q1'")).toEqual({ answered_by: "captain", answered_via: "lavish" });
      expect(one<Record<string, unknown>>(f, "SELECT state, resolved_by FROM items WHERE kind = 'review_channel' AND run_id = ?1", run)).toEqual({ state: "resolved", resolved_by: `gate.channel_ok ${gate}` });
      expect(one<Record<string, unknown>>(f, "SELECT state, approval_id, channel_failures, channel_failing_since FROM gates WHERE id = ?1", gate)).toEqual({ state: "open", approval_id: null, channel_failures: 0, channel_failing_since: null });
      expect(rows<{ state: string }>(f, "SELECT state FROM decisions WHERE gate_id = ?1 ORDER BY id", gate).map((d) => d.state)).toEqual(["answered", "open", "open"]);
      expect(rows(f, "SELECT 1 FROM approvals")).toEqual([]);
    },
    { timeout: 90_000 },
  );
});

describe("the daemon listens on every review page", () => {
  test(
    "a page with no questions is polled from the hand-in; the user talks with the worker there without waking the leader, and ending the session gives the leader one summary",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: "[leader]\nquestion_batch_ms = 300" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      await leader.prompt("first");
      await leader.goInactive();
      const plain = filledDesignPage();
      const body = [
        "Feature listen",
        `FAKE: write design/design.html ${plain}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        // The page's message arrives as a steer: the worker answers it in the page.
        "FAKE: write reply.md Only you can pass it, outside the page: tell your leader.",
        "FAKE: verb review reply --body-file $FLOWRYN_REPORT_DIR/reply.md",
        "FAKE: sleep 120000",
      ].join("\n");
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: body });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const gate = one<{ id: string; page_path: string }>(f, "SELECT id, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
      expect(gate.page_path).toEndWith("design/design.html");
      // No question to answer, yet the daemon listens, so Lavish never says the agent is not listening.
      const calls = join(f.h.home, "lavish-calls.log");
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes(`poll ${gate.page_path}`), 10_000, "the lavish-axi poll");
      expect(existsSync(join(gate.page_path, "..", "flowryn-questions.js"))).toBe(false);

      queuePoll(f, 1, gate.id, [], ["approved, ship it"]);
      // The worker gets the words and answers in the page; the leader is not woken for it.
      const replies = join(f.h.home, "lavish-replies.log");
      await waitUntil(() => existsSync(replies) && readFileSync(replies, "utf8").includes("Only you can pass it, outside the page"), 15_000, "the worker's reply in the page");
      expect(readFileSync(calls, "utf8")).toContain(`reply ${gate.page_path} --agent-reply-file -`);
      await waitUntil(() => readFileSync(calls, "utf8").includes("Sent to the worker; its answer will appear here. If you meant to pass the review: only you can, outside this page"), 10_000, "Flowryn's reply on the page");
      const workerReply = (await e.replies(task, 2))[1]!;
      expect(workerReply.reply.data).toMatchObject({ gate: gate.id, shown: "shown" });
      expect(rows<{ author: string }>(f, "SELECT author FROM review_messages WHERE gate_id = ?1 ORDER BY seq", gate.id).map((m) => m.author)).toEqual(["user", "worker"]);
      expect(rows(f, "SELECT 1 FROM items WHERE kind IN ('review_feedback','review_summary') AND run_id = ?1", run)).toEqual([]);
      expect(await leader.saw(`Review of ${task}`)).toBe(0);
      expect(one<{ state: string }>(f, "SELECT state FROM gates WHERE id = ?1", gate.id)!.state).toBe("open");

      // Send & End: one summary wakes the leader, with the worker questions' batch; the gate is still open.
      const dir = join(f.h.home, "lavish-queue");
      writeFileSync(join(dir, "002.out"), `session:\n  file: /x/design.html\n  status: feedback\n  session_ended: true\n  ended_by: user\nprompts[1]{uid,prompt,selector,tag,text}:\n  "",Thanks,"",message,Freeform message\n`);
      await waitUntil(() => one(f, "SELECT 1 FROM items WHERE kind = 'review_summary' AND run_id = ?1", run) !== null, 10_000, "the review summary");
      const summary = one<{ line: string }>(f, "SELECT COALESCE(full_line, line) AS line FROM items WHERE kind = 'review_summary' AND run_id = ?1", run)!.line;
      expect(summary).toStartWith(`Review of ${task} (design gate ${gate.id}): the user ended the session; 2 messages from the user, 1 reply; still open: ask the user to pass or send changes (their words may read as a pass`);
      await waitUntil(async () => (await leader.saw(`Review of ${task}`)) > 0, 15_000, "the leader woken with the summary");
      expect(leader.seen.some((s) => s.via === "waiter" && s.text.includes("Flowryn questions ["))).toBe(true);
      expect(one<{ lavish_ended: number; state: string }>(f, "SELECT lavish_ended, state FROM gates WHERE id = ?1", gate.id)).toEqual({ lavish_ended: 1, state: "open" });

      const passed = await e.approve(task, { gate: "design" });
      expect(passed.ok).toBe(true);
      await f.waitRun(run, (r) => r.stage === "build", "the build stage");
      expect(one<{ state: string }>(f, "SELECT state FROM items WHERE kind = 'review_summary' AND run_id = ?1", run)!.state).toBe("resolved");
      // One summary per review: the pass adds no recap.
      expect(rows(f, "SELECT 1 FROM items WHERE kind = 'review_recap' AND run_id = ?1", run)).toEqual([]);
      // Let the woken turn finish before cleanup removes the leader's directory under it.
      await leader.prompt("done");
    },
    { timeout: 90_000 },
  );

  test(
    "a lavish URL without --page finds its page under the report directory and is listened on; one naming no page, another page, or no lavish session is refused",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const handIns = [
        "Feature review urls",
        `FAKE: write design/design.html ${filledDesignPage()}`,
        "FAKE: verb stage done --review https://example.com/review",
        "FAKE: verb stage done --review http://127.0.0.1:4387/session/0123456789abcdef",
        "FAKE: verb stage done --review lavish:other.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: verb stage done --review file://$FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: stage-done --review lavish:design/design.html",
        "FAKE: sleep 120000",
      ];
      const { task, run } = await f.dispatch(handIns.join("\n"), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage_state === "review", "the review");
      const replies = await e.replies(task, 5);
      const refused = replies.slice(0, 4).map((r) => ({ code: r.code, error: (r.reply.error as { code: string; message: string }).code, message: (r.reply.error as { message: string }).message }));
      expect(refused.map((r) => [r.code, r.error])).toEqual([
        [3, "review_invalid"],
        [3, "review_invalid"],
        [3, "review_invalid"],
        [3, "review_invalid"],
      ]);
      expect(refused[0]!.message).toContain("must be lavish's URL");
      expect(refused[1]!.message).toContain("no page under $FLOWRYN_REPORT_DIR is lavish session 0123456789abcdef");
      expect(refused[2]!.message).toMatch(/names lavish session [0-9a-f]{16}, but .*design\/design\.html is session [0-9a-f]{16}/);
      expect(refused[3]!.message).toContain("lavish-axi is installed");
      const gate = one<{ review_url: string; page_path: string }>(f, "SELECT review_url, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
      expect(gate.page_path).toEndWith("design/design.html");
      expect(gate.review_url).toBe(`http://127.0.0.1:4387/session/${lavishSessionKey(gate.page_path)}`);
      const calls = join(f.h.home, "lavish-calls.log");
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes(`poll ${gate.page_path}`), 10_000, "the lavish-axi poll");
    },
    { timeout: 90_000 },
  );
  test(
    "a design page that breaks the design outline is refused with every problem listed; the filled template opens the review",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const old = "<html><body><h1>Wake the leader</h1><table><tr><td>src/attention/items.ts</td><td>LEADER_WAKE_KINDS gains pr_ready</td></tr></table></body></html>";
      const handIns = [
        "Feature design page",
        `FAKE: write design/design.html ${old}`,
        "FAKE: verb stage done --review lavish:design/design.html",
        `FAKE: write design/design.html ${filledDesignPage()}`,
        "FAKE: stage-done --review lavish:design/design.html",
        "FAKE: sleep 120000",
      ];
      const { task, run } = await f.dispatch(handIns.join("\n"), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const refused = (await e.replies(task, 2))[0]!;
      expect(refused.code).toBe(3);
      const error = refused.reply.error as { code: string; message: string; help: string };
      expect(error.code).toBe("design_page_invalid");
      expect(error.message).toContain("does not follow the design outline");
      expect(error.message).toContain('code names above the fold: "src/attention/items.ts", "LEADER_WAKE_KINDS", "pr_ready"');
      expect(error.help).toContain("design-template.html");
      expect(one<{ page_path: string }>(f, "SELECT page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!.page_path).toEndWith("design/design.html");
    },
    { timeout: 90_000 },
  );
});

describe("a review page's worker is gone", () => {
  test(
    "a page message resumes the dead worker through the scheduler (the same run and session), which answers in the page; a refused reply rides the next poll",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const body = [
        "Feature revive",
        `FAKE: write design/design.html ${filledDesignPage()}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: write reply.md Back, and the table stays.",
        "FAKE: verb review reply --body-file $FLOWRYN_REPORT_DIR/reply.md",
        "FAKE: sleep 120000",
      ].join("\n");
      const { task, run } = await f.dispatch(body, { kind: "ship" });
      const parked = await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review" && r.liveness === "idle", "the idle worker at its review");
      const gate = one<{ id: string; page_path: string }>(f, "SELECT id, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
      const calls = join(f.h.home, "lavish-calls.log");
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes(`poll ${gate.page_path}`), 10_000, "the lavish-axi poll");
      // Its one automatic resume already used: the worker dies for good, and Lavish refuses replies for now.
      const db = f.h.db();
      try {
        db.query("UPDATE runs SET resume_count = 1 WHERE id = ?1").run(run);
      } finally {
        db.close();
      }
      writeFileSync(join(f.h.home, "lavish-reply-fail"), "");
      f.herdr.killHarness(parked.pane_id!, "SIGKILL");
      await f.waitRun(run, (r) => r.liveness === "dead", "the dead worker", 20_000);
      await waitUntil(() => one(f, "SELECT 1 FROM items WHERE kind = 'failure_needs_you' AND run_id = ?1 AND state = 'open'", run) !== null, 10_000, "the death's P0");

      queuePoll(f, 1, gate.id, [], ["Why a table here?"]);
      const back = await f.waitRun(run, (r) => r.resume_count === 2 && r.liveness !== "dead" && r.proc_pid !== null && r.proc_pid !== parked.proc_pid, "the worker resumed from the page", 30_000);
      expect(back.agent_session).toBe(parked.agent_session);
      expect(one<{ page_resumes: number }>(f, "SELECT page_resumes FROM gates WHERE id = ?1", gate.id)).toEqual({ page_resumes: 1 });
      expect(one<{ requested_by: string }>(f, "SELECT requested_by FROM operations WHERE run_id = ?1 AND kind = 'resume' ORDER BY created_at DESC LIMIT 1", run)).toEqual({ requested_by: "review page" });
      // The page's resume settles the death's P0, as flowryn resume does: nobody is told to resume a worker already coming back.
      expect(one<{ state: string; resolved_by: string }>(f, "SELECT state, resolved_by FROM items WHERE kind = 'failure_needs_you' AND run_id = ?1", run)).toEqual({ state: "resolved", resolved_by: "run.resume_requested" });
      await waitUntil(() => readFileSync(calls, "utf8").includes("The worker had stopped; Flowryn is resuming it"), 10_000, "Flowryn's reply on the page");
      // Lavish refused the worker's reply: it rides the next poll, which displaces the old listener.
      await waitUntil(() => readFileSync(calls, "utf8").includes(`poll ${gate.page_path} --agent-reply Back, and the table stays. --takeover`), 20_000, "the reply carried by the next poll");
      const reply = (await e.replies(task, 2))[1]!;
      expect(reply.reply.data).toMatchObject({ gate: gate.id, shown: "queued" });
    },
    { timeout: 120_000 },
  );
});

describe("a file:// review while lavish-axi is not installed", () => {
  let fleet: FleetEnv | null = null;
  afterEach(async () => {
    await fleet?.cleanup();
    fleet = null;
  });

  test(
    "is accepted under the report directory and is the page; outside it, it is refused",
    async () => {
      fleet = await makeFleetEnv({ tools: ['lavish_axi = "/nonexistent/lavish-axi"'] });
      const f = fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const handIns = [
        "Feature file",
        `FAKE: write design/design.html ${filledDesignPage()}`,
        "FAKE: verb stage done --review file:///etc/hosts.html",
        "FAKE: stage-done --review file://$FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: sleep 120000",
      ];
      const { task, run } = await f.dispatch(handIns.join("\n"), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage_state === "review", "the file review");
      expect(one<{ page_path: string | null }>(f, "SELECT page_path FROM gates WHERE run_id = ?1", run)!.page_path).toEndWith("design/design.html");
      const first = JSON.parse(readFileSync(join(f.h.dataDir, task, "fake-replies.jsonl"), "utf8").split("\n")[0]!) as { code: number; reply: string };
      expect(first.code).toBe(3);
      expect(first.reply).toContain("review_invalid");
    },
    { timeout: 90_000 },
  );
});

describe("a review page whose run ended for good", () => {
  const carried = (name: string) =>
    [`Feature ${name}`, `FAKE: write design/design.html ${filledDesignPage()}`, "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html", "FAKE: sleep 120000"].join("\n");

  /**
   * The run at its review fails (as a resume whose launch failed does: failRun parks the task), then
   * its worktree is cleaned up, which stops the worker.
   */
  async function failAndClean(f: FleetEnv, task: string, run: string): Promise<void> {
    await f.waitRun(run, (r) => r.stage_state === "review" && r.liveness === "idle", "the idle worker at its review");
    const db = f.h.db();
    try {
      tx(db, () => failRun(db, getRun(db, run)!, "resume failed: gone", "daemon", Date.now()));
    } finally {
      db.close();
    }
    const cleaned = await f.json(["cleanup", task]);
    expect(cleaned.code).toBe(0);
    expect(cleaned.reply.data).toMatchObject({ removed: true, state: "failed" });
  }

  test(
    "a page message on a cleaned run starts a new run at the gated stage whose task file names the old page, the conversation and the notes",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const f = ship.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const { task, run } = await f.dispatch(carried("carry"), { kind: "ship" });
      await f.waitRun(run, (r) => r.stage_state === "review", "the review");
      const gate = one<{ id: string; page_path: string }>(f, "SELECT id, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
      await failAndClean(f, task, run);
      expect(existsSync(f.run(run).worktree_path)).toBe(false);

      // The page is still listened to; the user writes on it.
      const calls = join(f.h.home, "lavish-calls.log");
      queuePoll(f, 1, gate.id, [], ["Why a table here?"]);
      await waitUntil(() => one(f, "SELECT 1 FROM runs WHERE task_id = ?1 AND id != ?2", task, run) !== null, 30_000, "the new run");
      const next = one<{ id: string }>(f, "SELECT id FROM runs WHERE task_id = ?1 AND id != ?2", task, run)!.id;
      const back = await f.waitRun(next, (r) => r.stage === "design" && r.stage_state === "review", "the new run's own review", 30_000);
      expect(back.worktree_path).toBe(f.run(run).worktree_path);
      expect(existsSync(back.worktree_path)).toBe(true);

      const old = one<{ state: string; replaced_by: string; notes_path: string; conversation_path: string }>(f, "SELECT state, replaced_by, notes_path, conversation_path FROM gates WHERE id = ?1", gate.id)!;
      expect(old).toMatchObject({ state: "changes", replaced_by: next });
      expect(old.notes_path).toBe(join(dirname(gate.page_path), `lavish-notes-${gate.id}.txt`));
      expect(old.conversation_path).toBe(join(dirname(gate.page_path), `review-${gate.id}.md`));
      expect(readFileSync(old.conversation_path, "utf8")).toContain("Why a table here?");
      const taskFile = readFileSync(join(f.h.stateDir, "runs", next, "task.md"), "utf8");
      expect(taskFile).toContain("Flowryn stage design");
      expect(taskFile).toContain(`the old review page: ${gate.page_path}`);
      expect(taskFile).toContain(`the review's conversation with the user: ${old.conversation_path}`);
      expect(taskFile).toContain(`the notes the page sent: ${old.notes_path}`);

      // The task is In flight again (its unhold and start applied), the leader's summary says a new run started, and the page was told.
      await waitUntil(() => rows<{ state: string }>(f, "SELECT state FROM intents WHERE task_id = ?1 AND verb IN ('unhold','start')", task).every((i) => i.state === "applied"), 10_000, "the backlog intents");
      expect(rows<{ verb: string }>(f, "SELECT verb FROM intents WHERE task_id = ?1 ORDER BY seq", task).map((i) => i.verb).slice(-2)).toEqual(["unhold", "start"]);
      const recap = one<{ line: string }>(f, "SELECT COALESCE(full_line, line) AS line FROM items WHERE kind = 'review_recap' AND run_id = ?1", run)!;
      expect(recap.line).toContain(`a new run started (${next}, at stage design)`);
      expect(one(f, "SELECT 1 FROM items WHERE kind = 'divergence' AND state IN ('open','presented')")).toBeNull();
      await waitUntil(() => readFileSync(calls, "utf8").includes("Flowryn is starting a new run of the task at this stage"), 10_000, "Flowryn's reply on the page");
    },
    { timeout: 150_000 },
  );

  test(
    "on a cancelled run a page message and the leader's changes start nothing; on a cleaned failed run the changes start a new run with them",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const f = ship.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const cancelled = await f.dispatch(carried("stop"), { kind: "ship" });
      await f.waitRun(cancelled.run, (r) => r.stage_state === "review" && r.liveness === "idle", "the review");
      const gate = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1 AND state = 'open'", cancelled.run)!;
      expect((await f.json(["cancel", cancelled.task])).code).toBe(0);
      await f.waitRun(cancelled.run, (r) => r.state === "cancelled", "the cancelled run");
      expect((await f.json(["cleanup", cancelled.task])).code).toBe(0);
      queuePoll(f, 1, gate.id, [], ["Can you pick this up again?"]);
      const queued = join(f.h.home, "lavish-queue", "001.out");
      // A poll still running from before the cancel may take the message; nothing restarts the task either way.
      await waitUntil(() => !existsSync(queued), 4_000, "the message taken").catch(() => undefined);
      await Bun.sleep(1_000);
      expect(rows(f, "SELECT id FROM runs WHERE task_id = ?1", cancelled.task)).toHaveLength(1);
      expect(one<{ revive_requested_at: number | null }>(f, "SELECT revive_requested_at FROM gates WHERE id = ?1", gate.id)).toEqual({ revive_requested_at: null });
      const refused = await f.json(["gate", "changes", cancelled.task, "--body-file", "-"], { stdin: "Use a list." });
      expect(refused.code).not.toBe(0);
      expect(JSON.stringify(refused.reply)).toContain("a cancelled task is never restarted");
      expect(rows(f, "SELECT id FROM runs WHERE task_id = ?1", cancelled.task)).toHaveLength(1);
      rmSync(queued, { force: true });

      const failed = await f.dispatch(carried("again"), { kind: "ship" });
      await failAndClean(f, failed.task, failed.run);
      const sent = await f.json(["gate", "changes", failed.task, "--body-file", "-"], { stdin: "Use a list." });
      expect(sent.code).toBe(0);
      const data = sent.reply.data as { state: string; to: string; run: string; replaced: string };
      expect(data).toMatchObject({ state: "replaced", to: "design", replaced: failed.run });
      await f.waitRun(data.run, (r) => r.stage === "design" && r.stage_state === "review", "the new run's own review", 30_000);
      const taskFile = readFileSync(join(f.h.stateDir, "runs", data.run, "task.md"), "utf8");
      expect(taskFile).toContain("Your leader sent these changes: Use a list.");
      expect(taskFile).toContain("the old review page: ");
    },
    { timeout: 150_000 },
  );
});
