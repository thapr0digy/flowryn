import { afterEach, describe, expect, test } from "bun:test";
import { tx } from "../../src/db/db.ts";
import { createStandaloneDecision } from "../../src/lifecycle/decisions.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
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

  test("answering one a non-auto ship waits on hints the dispatch", async () => {
    const env = await makeFleetEnv();
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
      await waitUntil(() => f.h.db().query("SELECT 1 FROM runs WHERE task_id = ?1").get(shipTask) !== null, 30_000, "the waiting ship started by itself");
      expect(task).toBeTruthy();
    } finally {
      await ship.cleanup();
    }
  }, 60_000);
});
