import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { sh } from "../helpers/scratch-git.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The landing queue end to end (docs/notes/2026-10-30-landing-queue-the-65.md): a real daemon,
 * the fake GitHub backed by the project's bare origin, fake workers, and a project with
 * `landing = "queue"`. Routine PRs land one at a time; the second is brought up to date by the
 * daemon's own merge of main in its worktree (a plain merge commit, pushed), verified again at
 * that head and merged. A merge that conflicts goes back to the worker with the conflicted files.
 */

let env: ShipEnv | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await env?.cleanup();
  env = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30_000);

const STEPS = ["printf ' 1 pass\\n 0 fail\\n 1 expect() calls\\nRan 1 tests across 1 file. [1.00ms]\\n'"];

function queueConfig(steps: string[] = STEPS): string {
  return `[projects.web]\nverify = ${JSON.stringify(steps)}\nlanding = "queue"\n`;
}

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** A routine ship that commits `file` and delivers its PR; the worker's turn then ends. */
async function ship(e: ShipEnv, file: string, text: string): Promise<{ task: string; run: string }> {
  const steps = `FAKE: commit ${file} ${text}\nFAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\nFAKE: deliver-pr\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `${file}\n${steps}` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const { task, run } = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(run, (r) => r.state === "ready", `${file} delivered`);
  return { task, run };
}

/** Hold every verify on a file, so both PRs are in line before the first lands. */
function gated(): { steps: string[]; open(): void } {
  const dir = mkdtempSync(join(tmpdir(), "fw-lq-gate-"));
  dirs.push(dir);
  const gate = join(dir, "go");
  return { steps: [`while [ ! -f ${gate} ]; do sleep 0.1; done; ${STEPS[0]}`], open: () => writeFileSync(gate, "") };
}

function mainLog(e: ShipEnv): string {
  return sh(e.fleet.origin!, ["log", "--first-parent", "--format=%s", "main"]);
}

describe("the landing queue", () => {
  test(
    "two routine PRs land one at a time; the second gets main merged in by the daemon, a new verify at that head, then its merge",
    async () => {
      const gate = gated();
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: queueConfig(gate.steps) });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      const first = await ship(e, "one.txt", "one");
      const second = await ship(e, "two.txt", "two");

      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE state IN ('waiting','landing')").length === 2, 30_000, "both PRs in line");
      // One at a time: only the first is landing; the second waits behind it, and the leader is not woken for either.
      const line = query<{ task_id: string; state: string }>(e, "SELECT task_id, state FROM landing_queue ORDER BY enqueued_at");
      expect(line).toEqual([
        { task_id: first.task, state: "landing" },
        { task_id: second.task, state: "waiting" },
      ]);
      expect(query(e, "SELECT 1 FROM auto_merges WHERE task_id = ?1", second.task)).toHaveLength(0);
      const shown = JSON.stringify((await e.fleet.json(["show", second.task])).reply.data);
      expect(shown).toContain(`landing queue: 2 of 2, behind ${first.task}`);

      gate.open();
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'landed'", second.task).length > 0, 120_000, "the second PR to land");

      const entries = query<{ task_id: string; state: string; integrations: number; head_sha: string; entered_head: string }>(e, "SELECT task_id, state, integrations, head_sha, entered_head FROM landing_queue ORDER BY enqueued_at");
      expect(entries.map((r) => [r.task_id, r.state, r.integrations])).toEqual([
        [first.task, "landed", 0],
        [second.task, "landed", 1],
      ]);
      const integrated = entries[1]!;
      expect(integrated.head_sha).not.toBe(integrated.entered_head);
      // A plain merge commit made by the daemon: two parents, the delivered head first, never a rebase.
      const parents = sh(e.fleet.origin!, ["rev-list", "--parents", "-n", "1", integrated.head_sha]).split(" ");
      expect(parents).toHaveLength(3);
      expect(parents[1]).toBe(integrated.entered_head);
      expect(sh(e.fleet.origin!, ["log", "-1", "--format=%s", integrated.head_sha])).toMatch(/^Merge origin\/main into .* \(Flowryn landing queue\)$/);
      // The delivery was carried by the queue itself: no head-moved divergence, and the verify ran again at the new head.
      const carried = query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'run.head_carried'").map((r) => JSON.parse(r.payload) as Record<string, unknown>);
      expect(carried).toEqual([expect.objectContaining({ from: integrated.entered_head, to: integrated.head_sha, via: "landing" })]);
      expect(query(e, "SELECT 1 FROM divergences WHERE summary LIKE 'the PR head moved%'")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM verifications WHERE head_sha = ?1 AND state = 'passed'", integrated.head_sha)).toHaveLength(1);
      // The merges went in order, each under yolo at the head it was verified at.
      const merges = query<{ task_id: string; head_sha: string; channel: string }>(e, "SELECT m.task_id, m.head_sha, a.channel FROM merges m JOIN approvals a ON a.id = m.approval_id ORDER BY m.requested_at");
      expect(merges.map((m) => [m.task_id, m.channel])).toEqual([
        [first.task, "yolo"],
        [second.task, "yolo"],
      ]);
      expect(merges[1]!.head_sha).toBe(integrated.head_sha);
      expect(mainLog(e).split("\n").length).toBeGreaterThanOrEqual(3);
    },
    { timeout: 200_000 },
  );

  test(
    "a PR whose merge of main conflicts goes back to its worker with the conflicted file, and the line moves on",
    async () => {
      const gate = gated();
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: queueConfig(gate.steps) });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      const first = await ship(e, "same.txt", "one");
      const second = await ship(e, "same.txt", "two");
      // GitHub has not read the conflict yet (the watcher's own nudge would otherwise send it back first): the queue's merge finds it.
      e.github.pr("acme/web", 2).mergeable = true;
      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE state IN ('waiting','landing')").length === 2, 30_000, "both PRs in line");
      gate.open();

      await waitUntil(() => query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'left'", second.task).length > 0, 120_000, "the second PR to leave the line");
      expect(query<{ state: string }>(e, "SELECT state FROM landing_queue WHERE task_id = ?1", first.task)).toEqual([{ state: "landed" }]);
      expect(query<{ reason: string }>(e, "SELECT reason FROM landing_queue WHERE task_id = ?1", second.task)).toEqual([{ reason: "conflict" }]);
      const nudge = query<{ source: string; payload: string }>(e, "SELECT source, payload FROM events WHERE kind = 'run.conflict_nudged' AND task_id = ?1", second.task);
      expect(nudge).toHaveLength(1);
      expect(nudge[0]!.source).toBe("daemon");
      expect(JSON.parse(nudge[0]!.payload)).toMatchObject({ base: "main", nudge: 1, files: ["same.txt"] });
      await e.fleet.waitRun(second.run, (r) => r.state === "running", "the second ship sent back");
      // The daemon's merge was undone: the worktree is clean and still at the delivered head, and nothing was pushed.
      const wt = query<{ worktree_path: string }>(e, "SELECT worktree_path FROM runs WHERE id = ?1", second.run)[0]!.worktree_path;
      expect(sh(wt, ["status", "--porcelain"])).toBe("");
      const entered = query<{ entered_head: string }>(e, "SELECT entered_head FROM landing_queue WHERE task_id = ?1", second.task)[0]!.entered_head;
      expect(sh(wt, ["rev-parse", "HEAD"])).toBe(entered);
    },
    { timeout: 200_000 },
  );
});
