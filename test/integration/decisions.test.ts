import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { createStandaloneDecision } from "../../src/lifecycle/decisions.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { cliJson, makeHome, seedLeader, seedRun, startDaemon, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";
import { makeShipEnv } from "../helpers/ship-env.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function decisionTask(env: FleetEnv, key: string): Promise<string> {
  const db = env.h.db();
  try {
    return tx(db, () => createStandaloneDecision(db, { key, question: `Decide ${key}?`, options: ["a", "b"], origin: "test", project: "web", now: Date.now() })).taskId;
  } finally {
    db.close();
  }
}

describe("decision blockers", () => {
  test("a ship can be filed waiting on a decision task", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const blocker = await decisionTask(env, "pick-db");
    // Let the journal add the task so the backlog snapshot knows its kind.
    await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'hold' AND state = 'applied'").get(blocker) !== null, 10_000, "the decision task held");
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", blocker, "--auto", "--body-file", "-"], { stdin: "Build it\nFAKE: sleep 100" });
    expect(filed.code).toBe(0);
    expect(filed.reply.data).toMatchObject({ state: "queued", blocked_by: [blocker], auto: "on" });
  });

  test("a scout is still refused as a blocker", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const { task } = await env.dispatch("Scout\nFAKE: sleep 60000");
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", task, "--body-file", "-"], { stdin: "Build it" });
    expect(filed.code).toBe(3);
    expect(JSON.stringify(filed.reply)).toContain("only a ship or a decision");
  });

  test("a decision task is a blocker at once, before the backlog snapshot has caught up", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const blocker = await decisionTask(env, "fresh-decision");
    // No waitUntil: the decisions table itself names the task's kind, so dispatch need not wait
    // for the journal to apply the add before accepting it as a blocker.
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", blocker, "--auto", "--body-file", "-"], { stdin: "Build it\nFAKE: sleep 100" });
    expect(filed.code).toBe(0);
    expect(filed.reply.data).toMatchObject({ state: "queued", blocked_by: [blocker], auto: "on" });
  });
});

describe("decide", () => {
  test("the leader decides an open decision with a rationale; the decision task is done and unheld", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const added = await env.json(["decision", "add", "--key", "cache-store", "--question", "SQLite or Postgres for the cache?", "--options", "sqlite,postgres", "--recommend", "sqlite", "--body-file", "-"], { stdin: "Blocks the cache work." });
    expect(added.code).toBe(0);
    const { decision, task } = added.reply.data as { decision: string; task: string };
    expect(decision).toMatch(/^k\d+$/);
    const noReason = await env.json(["decide", decision, "sqlite"]);
    expect(noReason.code).toBe(3);
    const decided = await env.json(["decide", decision, "sqlite", "--rationale", "one process, no server"]);
    expect(decided.code).toBe(0);
    expect(decided.reply.data).toMatchObject({ decision, answer: "sqlite", by: "leader" });
    const db = env.h.db();
    const verbs = (db.query("SELECT verb FROM intents WHERE task_id = ?1 ORDER BY seq").all(task) as { verb: string }[]).map((r) => r.verb);
    db.close();
    expect(verbs).toEqual(["add", "hold", "unhold", "done"]);
    const shown = await env.json(["show", decision]);
    expect(shown.reply.data).toMatchObject({ decision, state: "answered", answer: "sqlite", by: "leader", rationale: "one process, no server" });
  });

  test("a reserved decision refuses the leader", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const added = await env.json(["decision", "add", "--key", "drop-bucket", "--question", "Delete the old evidence bucket?", "--body-file", "-"], { stdin: "Frees 2 TB." });
    const { decision } = added.reply.data as { decision: string };
    expect(added.reply.data).toMatchObject({ reserved: "destructive" });
    const refused = await env.json(["decide", decision, "yes", "--rationale", "space"]);
    expect(refused.code).toBe(2);
    expect((refused.reply as { error: { code: string } }).error.code).toBe("reserved_decision");
  });

  test("answer refuses a standalone decision for a leader, pointing at decide --rationale", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const added = await env.json(["decision", "add", "--key", "answer-alias", "--question", "Keep both regions?", "--options", "yes,no", "--body-file", "-"], { stdin: "x" });
    const { decision } = added.reply.data as { decision: string };
    const refused = await env.json(["answer", decision, "yes"]);
    expect(refused.code).toBe(3);
    expect(JSON.stringify(refused.reply)).toContain(`flowryn decide ${decision} yes --rationale`);
    expect((await env.json(["show", decision])).reply.data).toMatchObject({ state: "open" });
  });

  test("decision add refuses a --blocks target that does not exist", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const refused = await env.json(["decision", "add", "--key", "ghost-blocker", "--question", "Proceed?", "--blocks", "no-such-task-zz", "--body-file", "-"], { stdin: "x" });
    expect(refused.code).toBe(4);
    expect(JSON.stringify(refused.reply)).toContain("no task no-such-task-zz");
  });

  test("a repeat decision add still records a block intent for a newly named target (block is idempotent)", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const { task: shipTask } = await env.dispatch("Build\nFAKE: sleep 30000", { kind: "ship" });
    const first = await env.json(["decision", "add", "--key", "repeat-block", "--question", "Ship this way?", "--body-file", "-"], { stdin: "x" });
    const { decision, task } = first.reply.data as { decision: string; task: string };
    const again = await env.json(["decision", "add", "--key", "repeat-block", "--question", "Ship this way?", "--blocks", shipTask, "--body-file", "-"], { stdin: "x" });
    expect(again.reply.data).toMatchObject({ decision, already: true });
    const db = env.h.db();
    const blocks = (db.query("SELECT task_id, args FROM intents WHERE verb = 'block' ORDER BY seq").all() as { task_id: string; args: string }[]);
    db.close();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ task_id: shipTask });
    expect(JSON.parse(blocks[0]!.args)).toMatchObject({ positional: [shipTask], flags: { by: task } });
  });

  test("a repeat decision add that newly blocks a non-yolo ship upgrades (never clears) the reserved reason", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    // The default project is not yolo, so blocking its ship makes the decision a merge reservation.
    const { task: shipTask } = await env.dispatch("Build\nFAKE: sleep 30000", { kind: "ship" });
    const first = await env.json(["decision", "add", "--key", "upgrade-reserved", "--question", "Ship this way?", "--body-file", "-"], { stdin: "x" });
    expect(first.reply.data).toMatchObject({ reserved: "-" });
    const { decision } = first.reply.data as { decision: string };
    const again = await env.json(["decision", "add", "--key", "upgrade-reserved", "--question", "Ship this way?", "--blocks", shipTask, "--body-file", "-"], { stdin: "x" });
    expect(again.reply.data).toMatchObject({ decision, already: true, reserved: "merge" });
    const reservedList = (await env.json(["decision", "list", "--reserved"])).reply.data as { decisions: { id: string }[] };
    expect(reservedList.decisions.map((d) => d.id)).toContain(decision);
    const refused = await env.json(["decide", decision, "yes", "--rationale", "x"]);
    expect(refused.code).toBe(2);
    expect((refused.reply as { error: { code: string } }).error.code).toBe("reserved_decision");
  });

  test("dispatching a non-yolo ship that waits on a decision reserves it for a merge", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const added = await env.json(["decision", "add", "--key", "late-merge", "--question", "Ship this way?", "--body-file", "-"], { stdin: "x" });
    expect(added.reply.data).toMatchObject({ reserved: "-" });
    const { decision, task } = added.reply.data as { decision: string; task: string };
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", task, "--body-file", "-"], { stdin: "Build it" });
    expect(filed.code).toBe(0);
    expect((await env.json(["show", decision])).reply.data).toMatchObject({ reserved: "merge" });
    const refused = await env.json(["decide", decision, "yes", "--rationale", "x"]);
    expect((refused.reply as { error: { code: string } }).error.code).toBe("reserved_decision");
  });

  test("under yolo, only a sensitive dependent reserves a decision for a merge, through dispatch or --blocks", async () => {
    const env = await makeFleetEnv({ yolo: true });
    envs.push(env);
    const plain = (await env.json(["decision", "add", "--key", "plain", "--question", "Ship this way?", "--body-file", "-"], { stdin: "x" })).reply.data as { decision: string; task: string };
    expect((await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", plain.task, "--body-file", "-"], { stdin: "Build it" })).code).toBe(0);
    expect((await env.json(["show", plain.decision])).reply.data).toMatchObject({ reserved: "-" });

    const viaDispatch = (await env.json(["decision", "add", "--key", "via-dispatch", "--question", "Ship this way?", "--body-file", "-"], { stdin: "x" })).reply.data as { decision: string; task: string };
    expect((await env.json(["dispatch", "web", "--kind", "ship", "--sensitive", "--blocked-by", viaDispatch.task, "--body-file", "-"], { stdin: "Build it" })).code).toBe(0);
    expect((await env.json(["show", viaDispatch.decision])).reply.data).toMatchObject({ reserved: "merge" });
    const refused = await env.json(["decide", viaDispatch.decision, "yes", "--rationale", "x"]);
    expect((refused.reply as { error: { code: string } }).error.code).toBe("reserved_decision");

    const sensitive = await env.json(["dispatch", "web", "--kind", "ship", "--sensitive", "--harness", "claude", "--body-file", "-"], { stdin: "Build\nFAKE: sleep 30000" });
    const shipTask = (sensitive.reply.data as { task: string }).task;
    const viaBlocks = await env.json(["decision", "add", "--key", "via-blocks", "--question", "Ship this way?", "--blocks", shipTask, "--body-file", "-"], { stdin: "x" });
    expect(viaBlocks.reply.data).toMatchObject({ reserved: "merge" });
  });

  test("dispatch never replaces a decision's existing reserved reason", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const added = (await env.json(["decision", "add", "--key", "keep-reason", "--question", "Delete the old bucket?", "--body-file", "-"], { stdin: "x" })).reply.data as { decision: string; task: string; reserved: string };
    expect(added.reserved).toBe("destructive");
    expect((await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", added.task, "--body-file", "-"], { stdin: "Build it" })).code).toBe(0);
    expect((await env.json(["show", added.decision])).reply.data).toMatchObject({ reserved: "destructive" });
  });

  test("answering one a non-auto ship waits on hints the dispatch", async () => {
    // Under yolo: a non-yolo ship would reserve the decision for the user's merge word.
    const env = await makeFleetEnv({ yolo: true });
    envs.push(env);
    const added = await env.json(["decision", "add", "--key", "naming", "--question", "Name it Foo or Bar?", "--options", "foo,bar", "--body-file", "-"], { stdin: "x" });
    const { decision, task } = added.reply.data as { decision: string; task: string };
    await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'hold' AND state = 'applied'").get(task) !== null, 10_000, "held");
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", task, "--body-file", "-"], { stdin: "Ship the name" });
    const ship = (filed.reply.data as { task: string }).task;
    // Dependents are read from the backlog snapshot: wait for the ship's add to apply.
    await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'add' AND state = 'applied'").get(ship) !== null, 10_000, "the ship filed");
    const decided = await env.json(["decide", decision, "foo", "--rationale", "shorter"]);
    expect(decided.reply.hints).toContain(`flowryn dispatch web --task ${ship}`);
  });

  test("defer hides it until the date; list shows open, reserved and deferred", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const a = (await env.json(["decision", "add", "--key", "one", "--question", "One?", "--body-file", "-"], { stdin: "x" })).reply.data as { decision: string };
    const b = (await env.json(["decision", "add", "--key", "two", "--question", "Revoke the old token?", "--body-file", "-"], { stdin: "x" })).reply.data as { decision: string };
    expect((await env.json(["decision", "defer", a.decision, "--until", "2999-01-01"])).code).toBe(0);
    const open = (await env.json(["decision", "list"])).reply.data as { decisions: { id: string }[] };
    expect(open.decisions.map((d) => d.id)).toEqual([b.decision]);
    const deferred = (await env.json(["decision", "list", "--deferred"])).reply.data as { decisions: { id: string }[] };
    expect(deferred.decisions.map((d) => d.id)).toEqual([a.decision]);
    const reserved = (await env.json(["decision", "list", "--reserved"])).reply.data as { decisions: { id: string; reserved: string }[] };
    expect(reserved.decisions).toEqual([expect.objectContaining({ id: b.decision, reserved: "credential" })]);
  });

  test("a scout's open decisions become standalone decisions once, even if it delivers again", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const spec = "FAKE: deliver-decisions report.md pick-db:Which database?:sqlite,postgres:sqlite:- ; drop-old:Delete the old bucket?:yes,no:no:-";
    // The second delivery is refused (run_not_active: the scout is landed) and opens nothing.
    const { task, run } = await env.dispatch(["Scout the design", spec, spec, "FAKE: sleep 30000"].join("\n"));
    await env.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "landed");
    const list = (await env.json(["decision", "list", "--all"])).reply.data as { decisions: { id: string; reserved: string }[] };
    expect(list.decisions).toHaveLength(2);
    expect(list.decisions.find((d) => d.reserved === "destructive")).toBeDefined();
    const origins = env.h.db().query("SELECT DISTINCT origin FROM decisions").all() as { origin: string }[];
    expect(origins).toEqual([{ origin: task }]);
  });

  test("answer stays an alias for run-scoped questions", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const { run } = await env.dispatch("Scout\nFAKE: ask yes,no proceed?\nFAKE: sleep 60000");
    await waitUntil(() => env.h.db().query("SELECT 1 FROM decisions WHERE run_id = ?1").get(run) !== null, 15_000, "the question");
    const q = env.h.db().query("SELECT id FROM decisions WHERE run_id = ?1").get(run) as { id: string };
    expect(q.id).toMatch(/^q\d+$/);
    const answered = await env.json(["answer", q.id, "yes"]);
    expect(answered.code).toBe(0);
    expect(answered.reply.data).toMatchObject({ decision: q.id, answer: "yes" });
  });
});

describe("deliver opens a scout's decisions", () => {
  test("the report_ready item names how many open decisions the report opened", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const spec = "FAKE: deliver-decisions report.md a:Pick A or B?:a,b:a:- ; b:Pick X or Y?:x,y:x:-";
    const { run } = await env.dispatch(["Scout", spec, "FAKE: sleep 30000"].join("\n"));
    await env.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "landed");
    const db = env.h.db();
    const item = db.query("SELECT line FROM items WHERE run_id = ?1 AND kind = 'report_ready'").get(run) as { line: string };
    db.close();
    expect(item.line).toContain("; 2 open decisions");
  });

  test("a malformed entry (a bare ### heading) never blocks landing; it is skipped, with a warning", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const body = ["Scout", "FAKE: deliver-raw report.md # Fake report\\n\\n## Open decisions\\n\\n### \\n\\n## Done", "FAKE: sleep 30000"].join("\n");
    const { run } = await env.dispatch(body);
    const landed = await env.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "landed despite the malformed entry");
    expect(landed.state === "landed" || landed.state === "cleaned").toBe(true);
    const db = env.h.db();
    const event = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'report.decisions'").get(run) as { payload: string } | null;
    db.close();
    expect(event).not.toBeNull();
    const payload = JSON.parse(event!.payload) as { opened: string[]; warnings: string[] };
    expect(payload.opened).toEqual([]);
    expect(payload.warnings.length).toBeGreaterThan(0);
  });
});

describe("run-scoped and standalone keys", () => {
  test("a report entry whose key is the run's own question is not folded into it: it is a warning, never lost silently", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const spec = "FAKE: deliver-decisions report.md db-choice:Which database?:sqlite,postgres:sqlite:- ; other:Pick A or B?:a,b:a:-";
    const { task, run } = await env.dispatch(["Scout", "FAKE: wait-file go", spec, "FAKE: sleep 30000"].join("\n"));
    const db = env.h.db();
    db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, created_at) VALUES ('q900', ?1, ?2, 'Which database?', '[\"sqlite\",\"postgres\"]', 0, 'open', ?1, 'db-choice', 1)").run(task, run);
    db.close();
    const dir = join(env.h.dataDir, task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "go"), "");
    await env.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "landed");
    const check = env.h.db();
    const event = check.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'report.decisions'").get(run) as { payload: string };
    const standalone = check.query("SELECT key FROM decisions WHERE run_id IS NULL").all() as { key: string }[];
    check.close();
    const payload = JSON.parse(event.payload) as { opened: string[]; warnings: string[] };
    expect(payload.opened).toHaveLength(1);
    expect(standalone).toEqual([{ key: "other" }]);
    expect(payload.warnings).toEqual([expect.stringContaining("q900")]);
  });

  test("decision add refuses a key a run's question already holds rather than returning the q id", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const { task, run } = await env.dispatch("Scout\nFAKE: sleep 30000");
    const db = env.h.db();
    db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, created_at) VALUES ('q901', ?1, ?2, 'Which?', '[]', 0, 'open', ?1, 'shared', 1)").run(task, run);
    db.close();
    const added = await env.json(["decision", "add", "--origin", task, "--key", "shared", "--question", "Which?", "--body-file", "-"], { stdin: "x" });
    expect(added.code).not.toBe(0);
    expect(JSON.stringify(added.reply)).toContain("q901");
  });
});

describe("C1 end to end", () => {
  test("exit 1: scout decisions, leader decides two, the user answers the reserved one, the waiting ship starts by itself", async () => {
    const ship = await makeShipEnv({ mode: "local-only" });
    try {
      const f = ship.fleet;
      const token = { env: { FLOWRYN_TOKEN: ship.leaderToken() } };
      const { task, run } = await f.dispatch(["Scout", "FAKE: deliver-decisions report.md a:Use A or B?:a,b:a:- ; c:Cache in SQLite?:yes,no:yes:- ; drop:Delete the old bucket?:yes,no:no:-", "FAKE: sleep 30000"].join("\n"));
      await f.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "landed");
      const all = (await f.json(["decision", "list", "--all"], token)).reply.data as { decisions: { id: string; task: string; reserved: string }[] };
      const reserved = all.decisions.find((d) => d.reserved !== "-")!;
      for (const d of all.decisions.filter((x) => x.reserved === "-")) {
        const db = f.h.db();
        const opt = (JSON.parse((db.query("SELECT options FROM decisions WHERE id = ?1").get(d.id) as { options: string }).options) as string[])[0]!;
        db.close();
        expect((await f.json(["decide", d.id, opt, "--rationale", "fine"], token)).code).toBe(0);
      }
      await waitUntil(() => f.h.db().query("SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'hold' AND state = 'applied'").get(reserved.task) !== null, 10_000, "held");
      const filed = await f.json(["dispatch", "web", "--kind", "ship", "--blocked-by", reserved.task, "--auto", "--body-file", "-"], { ...token, stdin: "After the decision\nFAKE: deliver-local\nFAKE: sleep 60000" });
      const shipTask = (filed.reply.data as { task: string }).task;
      const brief = await f.json(["brief"], token);
      expect(JSON.stringify(brief.reply)).toContain(`[${reserved.id}]`);
      const leader = await ship.claude();
      await leader.start();
      const yes = await leader.runBash(`flowryn decide ${reserved.id} no --by captain --body-file - --json <<'EOF'\nkeep it\nEOF`, { approve: true });
      expect(yes.code).toBe(0);
      const answeredRow = f.h.db().query("SELECT answered_by, answered_via, rationale FROM decisions WHERE id = ?1").get(reserved.id) as { answered_by: string; answered_via: string; rationale: string };
      expect(answeredRow).toEqual({ answered_by: "captain", answered_via: "claude-ask", rationale: "keep it" });
      await waitUntil(() => f.h.db().query("SELECT 1 FROM runs WHERE task_id = ?1").get(shipTask) !== null, 30_000, "the waiting ship started by itself");
      expect(task).toBeTruthy();
    } finally {
      await ship.cleanup();
    }
  }, 60_000);
});

describe("ask --key", () => {
  const homes: TestHome[] = [];
  const daemons: DaemonProc[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
    for (const h of homes.splice(0)) h.cleanup();
  });

  test("a repeated ask --key on the same task is idempotent; once answered, the key refuses rather than crashing", async () => {
    const h = makeHome();
    homes.push(h);
    const d = await startDaemon(h);
    daemons.push(d);
    const run = seedRun(h);
    const worker = { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId };
    const first = await cliJson(h, ["ask", "--key", "db", "--options", "sqlite,postgres", "--blocks", "the storage layer schema", "--body-file", "-"], { env: worker, stdin: "Which database?" });
    expect(first.code).toBe(0);
    const decisionId = (first.reply.data as { decision: string }).decision;
    const again = await cliJson(h, ["ask", "--key", "db", "--options", "sqlite,postgres", "--blocks", "the storage layer schema", "--body-file", "-"], { env: worker, stdin: "Which database?" });
    expect(again.code).toBe(0);
    expect(again.reply.data).toMatchObject({ decision: decisionId, already: true });
    const db = h.db();
    const count = db.query("SELECT COUNT(*) AS n FROM decisions").get() as { n: number };
    db.close();
    expect(count.n).toBe(1);

    const leader = seedLeader(h);
    const answered = await cliJson(h, ["decide", decisionId, "sqlite", "--rationale", "fine"], { env: { FLOWRYN_TOKEN: leader } });
    expect(answered.code).toBe(0);

    const refused = await cliJson(h, ["ask", "--key", "db", "--options", "sqlite,postgres", "--blocks", "the storage layer schema", "--body-file", "-"], { env: worker, stdin: "Which database?" });
    expect(refused.code).toBe(3);
    expect(JSON.stringify(refused.reply)).toContain(`key db already used by ${decisionId}`);
  });

  test("ask --key refuses a key a standalone decision from its task already holds", async () => {
    const h = makeHome();
    homes.push(h);
    const d = await startDaemon(h);
    daemons.push(d);
    const run = seedRun(h);
    const db = h.db();
    const taskId = (db.query("SELECT task_id FROM runs WHERE id = ?1").get(run.runId) as { task_id: string }).task_id;
    const standalone = tx(db, () => createStandaloneDecision(db, { key: "db", question: "Which database?", options: [], origin: taskId, now: 1 }));
    db.close();
    const asked = await cliJson(h, ["ask", "--key", "db", "--options", "sqlite,postgres", "--blocks", "the storage layer schema", "--body-file", "-"], { env: { FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId }, stdin: "Which database?" });
    expect(asked.code).toBe(3);
    expect(JSON.stringify(asked.reply)).toContain(standalone.id);
  });
});
