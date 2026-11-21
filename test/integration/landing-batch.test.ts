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
 * local main through the merge verb's path and are cleaned up, with no leader turn.
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
});
