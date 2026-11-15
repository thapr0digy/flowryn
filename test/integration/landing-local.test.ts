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
 * The merge queue for local-only projects end to end (docs/notes/2026-11-15-local-only-auto-x9.md):
 * a real daemon, fake workers that deliver --local, and a yolo local-only project with verify steps
 * and no `landing` key (it queues by default). Two branches ready together verify at once, the
 * second on top of the first, and both land on local main in turn with one verify each, no leader
 * steer and no worker turn.
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

/** A routine ship that commits `file` and delivers its branch; the worker's turn then ends. */
async function ship(e: ShipEnv, file: string, text: string): Promise<{ task: string; run: string }> {
  const steps = `FAKE: commit ${file} ${text}\nFAKE: deliver-local\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `${file}\n${steps}` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const { task, run } = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(run, (r) => r.state === "ready", `${file} delivered`);
  return { task, run };
}

/** Hold every verify on a file, so both branches are in line before the first lands. */
function gated(): { step: string; open(): void } {
  const dir = mkdtempSync(join(tmpdir(), "fw-lq-local-gate-"));
  dirs.push(dir);
  const gate = join(dir, "go");
  return { step: `while [ ! -f ${gate} ]; do sleep 0.1; done; ${PASS}`, open: () => writeFileSync(gate, "") };
}

describe("the merge queue, local-only", () => {
  test(
    "two branches ready together land in sequence on local main with one verify each and no steer",
    async () => {
      const gate = gated();
      env = await makeShipEnv({ mode: "local-only", yolo: true, extraConfig: `[projects.web]\nverify = ${JSON.stringify([gate.step])}\n` });
      const e = env;
      const first = await ship(e, "one.txt", "one");
      const second = await ship(e, "two.txt", "two");

      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND train_head IS NOT NULL", second.task).length > 0, 30_000, "the second branch's candidate");
      const line = query<{ task_id: string; state: string; train_head: string; train_base: string; head_sha: string }>(e, "SELECT task_id, state, train_head, train_base, head_sha FROM landing_queue ORDER BY enqueued_at");
      expect(line.map((r) => [r.task_id, r.state])).toEqual([
        [first.task, "landing"],
        [second.task, "waiting"],
      ]);
      const candidate = line[1]!;
      expect(candidate.train_base).toBe(line[0]!.head_sha);
      // No verify of a delivered head of its own: only the two candidates'.
      expect(query(e, "SELECT 1 FROM verify_queue")).toHaveLength(2);
      const fleet = JSON.stringify((await e.fleet.json(["fleet"])).reply.data);
      expect(fleet).toContain("queue 2/2");

      gate.open();
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'landed'", second.task).length > 0, 120_000, "the second branch to land");

      expect(query<{ state: string }>(e, "SELECT state FROM landing_queue ORDER BY enqueued_at").map((r) => r.state)).toEqual(["landed", "landed"]);
      const merges = query<{ task_id: string; head_sha: string; state: string }>(e, "SELECT task_id, head_sha, state FROM merges ORDER BY requested_at");
      expect(merges.map((m) => [m.task_id, m.state])).toEqual([
        [first.task, "merged"],
        [second.task, "merged"],
      ]);
      expect(merges[1]!.head_sha).toBe(candidate.train_head);
      expect(sh(e.fleet.repo, ["rev-parse", "main"])).toBe(candidate.train_head);
      expect(sh(e.fleet.repo, ["ls-tree", "--name-only", "main"]).split("\n")).toEqual(expect.arrayContaining(["one.txt", "two.txt"]));
      expect(query(e, "SELECT 1 FROM verifications")).toHaveLength(2);
      expect(query(e, "SELECT 1 FROM messages")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM events WHERE kind IN ('verify.sent_back','run.conflict_nudged','auto_merge.held')")).toHaveLength(0);
    },
    { timeout: 200_000 },
  );

  test(
    "not yolo: your approval and the merge verb put the branch in line, and the queue lands it",
    async () => {
      env = await makeShipEnv({ mode: "local-only", extraConfig: `[projects.web]\nverify = ${JSON.stringify([PASS])}\n` });
      const e = env;
      const { task, run } = await ship(e, "solo.txt", "solo");
      // Not routine: nothing joins the line without your word.
      expect(query(e, "SELECT 1 FROM landing_queue")).toHaveLength(0);
      expect((await e.approve(task)).ok).toBe(true);
      const merged = await e.call("merge", { task });
      expect(merged.ok).toBe(true);
      expect(merged.data).toMatchObject({ landing: expect.any(String) });
      await e.fleet.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "the branch to land");
      expect(sh(e.fleet.repo, ["show", "main:solo.txt"])).toBe("solo");
      expect(query<{ channel: string }>(e, "SELECT a.channel FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1", task).map((r) => r.channel)).toEqual(["cli-tty"]);
    },
    { timeout: 200_000 },
  );
});
