import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { sh } from "../helpers/scratch-git.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Landing batches end to end (docs/notes/2026-11-21-landing-batches-one-27.md): a real daemon, fake
 * workers that deliver --local, and a yolo local-only project with `landing = "batch"` and a light
 * check. Each branch's light check runs on its delivered head; the first branch's batch verifies
 * (held on a gate) while the second is delivered, which waits for the next batch; both land on
 * local main through the merge verb's path and are cleaned up, with no leader turn. A red batch
 * splits until its bad branch is alone, which goes back to its worker while the rest land.
 */

let env: ShipEnv | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await env?.cleanup();
  env = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30_000);

const PASS = "printf ' 1 pass\\n 0 fail\\n 1 expect() calls\\nRan 1 tests across 1 file. [1.00ms]\\n'";

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function ship(e: ShipEnv, file: string, text: string): Promise<{ task: string; run: string }> {
  const steps = `FAKE: commit ${file} ${text}\nFAKE: deliver-local\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `${file}\n${steps}` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const { task, run } = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(run, (r) => r.state === "ready", `${file} delivered`);
  return { task, run };
}

/** Hold the full verify on a file; the light check runs freely. */
function gated(): { step: string; open(): void } {
  const dir = mkdtempSync(join(tmpdir(), "fw-batch-gate-"));
  dirs.push(dir);
  const gate = join(dir, "go");
  return { step: `while [ ! -f ${gate} ]; do sleep 0.1; done; ${PASS}`, open: () => writeFileSync(gate, "") };
}

describe("landing batches", () => {
  test(
    "a light check per branch, one verify per batch, the next batch forming while one is in flight, and both landing on local main",
    async () => {
      const gate = gated();
      env = await makeShipEnv({ mode: "local-only", yolo: true, extraConfig: `[projects.web]\nverify = ${JSON.stringify([gate.step])}\nlanding = "batch"\nlight_verify = ${JSON.stringify([PASS])}\n` });
      const e = env;
      const first = await ship(e, "one.txt", "one");
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND batch_id IS NOT NULL", first.task).length > 0, 60_000, "the first branch's batch");
      const second = await ship(e, "two.txt", "two");
      await waitUntil(
        () => query(e, "SELECT 1 FROM verifications v JOIN landing_queue l ON l.ref = v.pr_url AND l.head_sha = v.head_sha WHERE l.task_id = ?1 AND v.state = 'passed'", second.task).length > 0,
        60_000,
        "the second branch's light check",
      );
      // The first batch is in flight with the first branch alone; the second waits for the next.
      const line = query<{ task_id: string; state: string; batch_id: string | null }>(e, "SELECT task_id, state, batch_id FROM landing_queue ORDER BY enqueued_at");
      expect(line.map((r) => [r.task_id, r.state, r.batch_id !== null])).toEqual([
        [first.task, "landing", true],
        [second.task, "waiting", false],
      ]);
      const fleet = JSON.stringify((await e.fleet.json(["fleet"])).reply.data);
      expect(fleet).toContain(`batch ${line[0]!.batch_id} 1/1`);
      const shown = await e.fleet.json(["show", line[0]!.batch_id!]);
      expect(shown.reply.data).toMatchObject({ batch: line[0]!.batch_id, state: "verifying", members: [expect.objectContaining({ task: first.task })] });

      gate.open();
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'landed'", second.task).length > 0, 120_000, "the second branch to land");

      const batches = query<{ id: string; state: string; head_sha: string }>(e, "SELECT id, state, head_sha FROM landing_batches ORDER BY created_at, id");
      expect(batches.map((b) => b.state)).toEqual(["landed", "landed"]);
      expect(sh(e.fleet.repo, ["rev-parse", "main"])).toBe(batches[1]!.head_sha);
      expect(sh(e.fleet.repo, ["ls-tree", "--name-only", "main"]).split("\n")).toEqual(expect.arrayContaining(["one.txt", "two.txt"]));
      const merges = query<{ task_id: string; state: string }>(e, "SELECT task_id, state FROM merges ORDER BY requested_at");
      expect(merges.map((m) => [m.task_id, m.state])).toEqual([
        [first.task, "merged"],
        [second.task, "merged"],
      ]);
      // Two light checks (one per branch) and two full verifies (one per batch), each full one at its batch head.
      const verifies = query<{ pr_url: string }>(e, "SELECT pr_url FROM verifications ORDER BY started_at");
      expect(verifies.filter((v) => v.pr_url.startsWith("batch:"))).toHaveLength(2);
      expect(verifies.filter((v) => v.pr_url.startsWith("local:"))).toHaveLength(2);
      expect(query(e, "SELECT 1 FROM messages")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM events WHERE kind IN ('verify.sent_back','run.conflict_nudged','landing.batch_held')")).toHaveLength(0);
      for (const { run } of [first, second]) await e.fleet.waitRun(run, (r) => r.state === "cleaned", "cleanup");
    },
    { timeout: 240_000 },
  );

  test(
    "a red batch splits by itself: the good branch lands, the bad one goes back to its worker after main is shown green, and nobody is asked",
    async () => {
      // The first batch waits on the gate while the other two are delivered, so they form the next batch together.
      // bad.txt fails the verify; its output rides in the send-back, so the bad branch's fresh worker sleeps instead of redelivering.
      const gate = gated();
      const step = `${gate.step.replace(PASS, "true")}; if [ -f bad.txt ]; then printf 'bad.txt is not allowed\\nFAKE: sleep 120000\\n'; exit 1; fi; ${PASS}`;
      env = await makeShipEnv({ mode: "local-only", yolo: true, extraConfig: `[projects.web]\nverify = ${JSON.stringify([step])}\nlanding = "batch"\n` });
      const e = env;
      const first = await ship(e, "one.txt", "one");
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND batch_id IS NOT NULL", first.task).length > 0, 60_000, "the first branch's batch");
      const bad = await ship(e, "bad.txt", "bad");
      const third = await ship(e, "three.txt", "three");
      gate.open();
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'landed'", third.task).length > 0, 240_000, "the third branch to land");

      // [one] landed; [bad, three] went red and split; [bad] alone went red, main was verified once, and bad went back.
      const built = query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'landing.batch_built' ORDER BY seq").map((r) => (JSON.parse(r.payload) as { members: { task: string }[] }).members.map((m) => m.task));
      expect(built).toEqual([[first.task], [bad.task, third.task], [bad.task], [third.task]]);
      expect(query(e, "SELECT 1 FROM events WHERE kind = 'landing.batch_split'")).toHaveLength(1);
      expect(query(e, "SELECT 1 FROM events WHERE kind = 'landing.batch_baseline'")).toHaveLength(1);
      expect(query<{ pr_url: string; state: string }>(e, "SELECT pr_url, state FROM verifications WHERE pr_url LIKE 'base:%'").map((v) => v.state)).toEqual(["passed"]);
      expect(query(e, "SELECT 1 FROM events WHERE kind = 'landing.batch_sent_back' AND task_id = ?1", bad.task)).toHaveLength(1);
      expect(e.fleet.events(bad.run).filter((k) => k === "verify.sent_back")).toHaveLength(1);
      expect(query<{ reason: string }>(e, "SELECT reason FROM landing_queue WHERE task_id = ?1", bad.task).map((r) => r.reason)).toEqual(["culprit"]);
      const merges = query<{ task_id: string; state: string }>(e, "SELECT task_id, state FROM merges ORDER BY requested_at, rowid");
      expect(merges.map((m) => [m.task_id, m.state])).toEqual([
        [first.task, "merged"],
        [third.task, "merged"],
      ]);
      const onMain = sh(e.fleet.repo, ["ls-tree", "--name-only", "main"]).split("\n");
      expect(onMain).toEqual(expect.arrayContaining(["one.txt", "three.txt"]));
      expect(onMain).not.toContain("bad.txt");
      // Nothing waited on a person.
      expect(query(e, "SELECT 1 FROM items WHERE kind IN ('landing_batch_held','auto_merge_held')")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM landing_batches WHERE state = 'held'")).toHaveLength(0);
      for (const { run } of [first, third]) await e.fleet.waitRun(run, (r) => r.state === "cleaned", "cleanup");
    },
    { timeout: 360_000 },
  );

  test(
    "a delivery frees its worker slot and the idle worker is retired; a send-back starts a fresh session that delivers again and lands",
    async () => {
      // The light check fails until fixed.txt exists. Its output rides in the send-back, which the fresh session's task file
      // carries as its note, ahead of the dispatch body: the new worker commits fixed.txt and delivers again.
      const light = `if [ -f fixed.txt ]; then ${PASS}; else printf 'missing fixed.txt\\nFAKE: commit fixed.txt fixed\\nFAKE: deliver-local\\nFAKE: sleep 120000\\n'; exit 1; fi`;
      const gate = gated();
      env = await makeShipEnv({ mode: "local-only", yolo: true, extraConfig: `[projects.web]\nverify = ${JSON.stringify([PASS])}\nlanding = "batch"\nlight_verify = ${JSON.stringify([`${gate.step.replace(PASS, "true")}; ${light}`])}\n` });
      const e = env;
      const first = await ship(e, "one.txt", "one");
      const [session] = query<{ agent_session: string }>(e, "SELECT agent_session FROM runs WHERE id = ?1", first.run);
      // Delivered: the run holds no live lease, and its worker slot was freed at delivery.
      expect(query(e, "SELECT 1 FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL", first.run)).toHaveLength(0);
      expect(query<{ released_by: string }>(e, "SELECT released_by FROM pool_leases WHERE run_id = ?1 AND pool = 'worker' ORDER BY id DESC LIMIT 1", first.run)[0]!.released_by).toBe("delivered to the landing line");
      // The light check waits on the gate while the idle worker is retired and read dead.
      await waitUntil(() => e.fleet.events(first.run).includes("run.worker_retired"), 60_000, "the delivered worker retired");
      await e.fleet.waitRun(first.run, (r) => r.liveness === "dead", "the retired worker read dead");

      gate.open();
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'landed'", first.task).length > 0, 180_000, "the redelivered branch to land");
      const kinds = e.fleet.events(first.run);
      expect(kinds.filter((k) => k === "verify.sent_back")).toHaveLength(1);
      expect(kinds.filter((k) => k === "run.fresh_worker")).toHaveLength(1);
      expect(kinds).not.toContain("run.auto_resumed");
      const [after] = query<{ agent_session: string }>(e, "SELECT agent_session FROM runs WHERE id = ?1", first.run);
      expect(after!.agent_session).not.toBe(session!.agent_session);
      expect(sh(e.fleet.repo, ["ls-tree", "--name-only", "main"]).split("\n")).toEqual(expect.arrayContaining(["one.txt", "fixed.txt"]));
      await e.fleet.waitRun(first.run, (r) => r.state === "cleaned", "cleanup");
    },
    { timeout: 300_000 },
  );
});
