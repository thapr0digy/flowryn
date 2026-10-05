import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { encodeAnswer } from "../../src/lavish/poll-output.ts";

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

const PAGE = '<html data-lavish-live-reload-root><body><h1>Design</h1><section id="flowryn-questions"></section><script src="flowryn-questions.js"></script></body></html>';
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
    `FAKE: stage-done --review https://lavish.test/${name}/design --questions-file $FLOWRYN_REPORT_DIR/design/questions.json`,
    `FAKE: stage-done --review https://lavish.test/${name}/design --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/questions.json`,
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
      // What came from the page reaches the leader as one item, batched with worker questions.
      await waitUntil(() => one(f, "SELECT 1 FROM items WHERE kind = 'review_feedback' AND run_id = ?1", run) !== null, 10_000, "the review feedback item");
      expect(one<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'review_feedback' AND run_id = ?1", run)!.line).toBe(`Review feedback on ${task} (design gate ${gate.id}): the user answered q1 = file and wrote "Make the header bigger"; notes beside the page`);

      // The leader relays q3 through Claude's prompt; the answer is held from the worker while the gate is open.
      const relayed = await leader.runBash(`flowryn decide q3 "flowryn keys" --by captain --json`, { approve: true });
      expect(relayed).toMatchObject({ prompted: true, ran: true, code: 0 });
      expect(JSON.parse(relayed.stdout).data).toMatchObject({ decision: "q3", answer: "flowryn keys", by: "captain", steer: "held for the verdict" });

      // A late page answer to q3 changes nothing; q2's goes in.
      queuePoll(f, 2, gate.id, [
        { d: "q3", c: ["something else"] },
        { d: "q2", c: ["claude", "pi"] },
      ]);
      await waitUntil(() => one<{ state: string }>(f, "SELECT state FROM decisions WHERE id = 'q2'")?.state === "answered", 10_000, "q2 answered from the page");
      expect(one<Record<string, unknown>>(f, "SELECT answer, answered_via FROM decisions WHERE id = 'q3'")).toEqual({ answer: "flowryn keys", answered_via: "claude-ask" });
      expect(JSON.parse(one<{ payload: string }>(f, "SELECT payload FROM events WHERE kind = 'decision.lavish_ignored'")!.payload)).toMatchObject({ decision: "q3", outcome: "late" });
      expect(rows(f, "SELECT 1 FROM messages WHERE run_id = ?1 AND body LIKE 'Answer to your question%'", run)).toEqual([]);
      await waitUntil(() => readFileSync(widget, "utf8").includes('"answer":"claude, pi"'), 10_000, "the widget shows q2 answered");
      expect(readFileSync(widget, "utf8")).toContain('"via":"your leader"');
      // Lavish's conversation hears what Flowryn recorded with the next poll, which keeps listening while the gate is open.
      await waitUntil(() => readFileSync(calls, "utf8").includes("--agent-reply Flowryn recorded your answer to q1. Your leader has your notes now, and they reach the worker with the verdict. 2 questions still open."), 10_000, "the reply after q1");
      await waitUntil(() => /--agent-reply Flowryn recorded your answer to q2\. q3 already had an answer; it stands\. Every question is answered; the review now waits for your pass in Flowryn\.(?! --timeout-ms)/.test(readFileSync(calls, "utf8")), 10_000, "the last reply");

      // Every question answered: the gate passes, and the verdict steer carries the answers and the notes.
      const passed = await e.approve(task, { gate: "design" });
      expect(passed.ok).toBe(true);
      await f.waitRun(run, (r) => r.stage === "build", "the build stage");
      const steer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE 'The design review passed%'", run)!;
      expect(steer.body).toContain("The user's answers to your review questions: q1 (token-store) = file [their note: file survives resets]; q2 (harnesses) = claude, pi; q3 (verb-name) = flowryn keys.");
      expect(steer.body).toContain(`read ${notes}`);
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
        "FAKE: stage-done --review https://lavish.test/c/design-2 --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/bad.json",
        "FAKE: stage-done --review https://lavish.test/c/design-2 --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/questions.json",
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
      // You answer q1 in your own shell (a human channel).
      expect((await e.call("decide", { decision: "q1", choice: "db", by: "captain" })).ok).toBe(true);

      const changes = await f.json(["gate", "changes", task, "--body-file", "-"], { stdin: "Split the token store question." });
      expect(changes.code).toBe(0);
      expect(rows<{ id: string; state: string }>(f, "SELECT id, state FROM decisions WHERE gate_id = ?1 ORDER BY id", first)).toEqual([
        { id: "q1", state: "answered" },
        { id: "q2", state: "dismissed" },
        { id: "q3", state: "dismissed" },
      ]);
      const steer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE 'Changes requested%'", run)!;
      expect(steer.body).toContain("Split the token store question. The user's answers to your review questions: q1 (token-store) = db. Closed unanswered: q2, q3.");

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

describe("the daemon listens on every review page", () => {
  test(
    "a page with no questions is polled from the hand-in; feedback reading as a pass wakes the leader as the user's word, and the gate stays open",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: "[leader]\nquestion_batch_ms = 300" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      await leader.prompt("first");
      await leader.goInactive();
      const plain = "<html><body><h1>Design</h1></body></html>";
      const body = [
        "Feature listen",
        `FAKE: write design/design.html ${plain}`,
        "FAKE: stage-done --review https://lavish.test/listen/design --page $FLOWRYN_REPORT_DIR/design/design.html",
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
      await waitUntil(() => one(f, "SELECT 1 FROM items WHERE kind = 'review_feedback' AND run_id = ?1", run) !== null, 10_000, "the review feedback item");
      const line = one<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'review_feedback' AND run_id = ?1", run)!.line;
      expect(line).toBe(`Review feedback on ${task} (design gate ${gate.id}) may read as a pass (ask the user; only flowryn gate pass passes it): the user wrote "approved, ship it"; notes beside the page`);
      // It wakes the idle leader with the worker questions' batch; the gate passes only through a human channel.
      await waitUntil(async () => (await leader.saw(`Review feedback on ${task}`)) > 0, 15_000, "the leader woken with the feedback");
      expect(leader.seen.some((s) => s.via === "waiter" && s.text.includes("Flowryn questions ["))).toBe(true);
      expect(one<{ state: string }>(f, "SELECT state FROM gates WHERE id = ?1", gate.id)!.state).toBe("open");
      await waitUntil(() => readFileSync(calls, "utf8").includes("If you meant to pass the review, your leader will ask you to confirm it in Flowryn."), 10_000, "the reply on the page");

      const passed = await e.approve(task, { gate: "design" });
      expect(passed.ok).toBe(true);
      await f.waitRun(run, (r) => r.stage === "build", "the build stage");
      expect(one<{ state: string }>(f, "SELECT state FROM items WHERE kind = 'review_feedback' AND run_id = ?1", run)!.state).toBe("resolved");
      // Let the woken turn finish before cleanup removes the leader's directory under it.
      await leader.prompt("done");
    },
    { timeout: 90_000 },
  );

  test(
    "a file:// review URL under the report directory is the page; an https one without --page is not listened on, and says so",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const viaFile = await f.dispatch(["Feature file", "FAKE: write design/design.html <html></html>", "FAKE: stage-done --review file://$FLOWRYN_REPORT_DIR/design/design.html", "FAKE: sleep 120000"].join("\n"), { kind: "ship" });
      const viaHttps = await f.dispatch(["Feature https", "FAKE: stage-done --review https://lavish.test/x/design", "FAKE: sleep 120000"].join("\n"), { kind: "ship" });
      await f.waitRun(viaFile.run, (r) => r.stage_state === "review", "the file review");
      await f.waitRun(viaHttps.run, (r) => r.stage_state === "review", "the https review");
      expect(one<{ page_path: string | null }>(f, "SELECT page_path FROM gates WHERE run_id = ?1", viaFile.run)!.page_path).toEndWith("design/design.html");
      expect(one<{ page_path: string | null }>(f, "SELECT page_path FROM gates WHERE run_id = ?1", viaHttps.run)!.page_path).toBeNull();
      const [reply] = await e.replies(viaHttps.task, 1);
      expect(reply!.reply.hints).toContain("no --page: Flowryn cannot listen on the review page; next time pass --page <its .html file>");
    },
    { timeout: 90_000 },
  );
});
