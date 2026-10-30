import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * Stacked plans (docs/notes/2026-10-27-stack-a-plan-4y.md, phase 2): a plan
 * filed with `stack: on` starts phase 2 on phase 1's delivered PR, refuses its
 * merge until phase 1 lands, retargets its PR to main when phase 1 lands and
 * sends it back with the merges to run, then lands it. A real daemon, the fake
 * GitHub backed by the project's bare origin (squash merges, the default), and
 * fake workers. Nothing reaches GitHub.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: GIT_ENV });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
}

function errorOf(reply: Record<string, unknown>): { code: string; message: string } {
  const error = (reply.error ?? {}) as { code?: string; message?: string };
  return { code: error.code ?? "", message: error.message ?? "" };
}

interface RunView {
  id: string;
  state: string;
  stage_state: string;
  branch: string;
  base_branch: string | null;
  stacked_on: string | null;
  worktree_path: string;
}

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T | null {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).get(...params) as T | null;
  } finally {
    db.close();
  }
}

function runOf(e: ShipEnv, task: string): RunView | null {
  return query<RunView>(e, "SELECT * FROM runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT 1", task);
}

/**
 * Phase 1 adds shared.txt; phase 2 changes the line phase 1 added, which is
 * what makes a plain merge of main conflict after phase 1's squash merge.
 */
function stackedPlan(api: string): string {
  return [
    "# Stacked work",
    "stack: on",
    "## Phase 1: Add shared",
    "FAKE: commit shared.txt one",
    "FAKE: push",
    `FAKE: pr ${api} acme/web`,
    "FAKE: deliver-pr",
    "FAKE: sleep 120000",
    "## Phase 2: Change shared",
    "FAKE: wait-file base",
    "FAKE: commit shared.txt two",
    "FAKE: commit two.txt two",
    "FAKE: push",
    `FAKE: pr ${api} acme/web base:@base`,
    "FAKE: deliver-pr",
    "FAKE: wait-file again",
    "FAKE: push",
    "FAKE: deliver-pr",
    "FAKE: sleep 120000",
  ].join("\n");
}

describe("stacked plans", () => {
  test(
    "phase 2 starts on phase 1's delivery, cannot merge until phase 1 lands, is retargeted and sent back on landing, and lands",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      // Phase 1's branch stays after its merge, so Flowryn moves phase 2's PR itself (GitHub moves it only when it deletes the branch).
      e.github.repo("acme/web").deleteBranchOnMerge = false;
      const filed = await e.fleet.json(["plan", "web", "--body-file", "-"], { stdin: stackedPlan(e.github.apiUrl) });
      expect(filed.code).toBe(0);
      expect(filed.reply.data).toMatchObject({ stack: "on" });
      const [one, two] = (filed.reply.data as { phases: { task: string }[] }).phases.map((p) => p.task) as [string, string];

      // Phase 1 delivers; phase 2 starts on its branch without waiting for the merge.
      await waitUntil(() => runOf(e, one)?.state === "ready", 60_000, "phase 1 delivered");
      await waitUntil(() => runOf(e, two) !== null, 60_000, "phase 2 started on phase 1's PR");
      const first = runOf(e, one)!;
      const second = runOf(e, two)!;
      expect(second).toMatchObject({ base_branch: first.branch, stacked_on: one });
      mkdirSync(join(e.fleet.h.dataDir, two), { recursive: true });
      writeFileSync(join(e.fleet.h.dataDir, two, "base"), first.branch);
      await waitUntil(() => runOf(e, two)?.state === "ready", 60_000, "phase 2 delivered into phase 1's branch");
      expect(e.github.pr("acme/web", 2).baseRef).toBe(first.branch);
      // Started from phase 1's delivered head: its commit is in phase 2's history.
      expect(git(second.worktree_path, ["merge-base", "--is-ancestor", e.github.pr("acme/web", 1).headSha, "HEAD"]).code).toBe(0);

      const shownPlan = await e.fleet.json(["show", (filed.reply.data as { plan: string }).plan]);
      expect(JSON.stringify(shownPlan.reply.data)).toContain(`stacked on`);
      const shownTask = await e.fleet.json(["show", two]);
      expect(shownTask.reply.data).toMatchObject({ stacked_on: `${one} (merges after it lands)` });

      // Its merge is refused while phase 1 has not landed.
      expect((await e.approve(two)).ok).toBe(true);
      const refused = await e.fleet.json(["merge", two]);
      expect(refused.code).toBe(2);
      expect(errorOf(refused.reply)).toMatchObject({ code: "stack_not_landed" });

      // Phase 1 lands (a squash merge): phase 2's PR is pointed at main and the run sent back.
      expect((await e.approve(one)).ok).toBe(true);
      expect((await e.fleet.json(["merge", one])).code).toBe(0);
      await waitUntil(() => runOf(e, two)?.stacked_on === null, 30_000, "phase 2 retargeted");
      expect(e.github.pr("acme/web", 2).baseRef).toBe("main");
      expect(e.github.count("PATCH", "pulls/2")).toBe(1);
      const retargeted = runOf(e, two)!;
      expect(retargeted).toMatchObject({ base_branch: null, state: "running" });
      const event = query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'run.retargeted' AND task_id = ?1", two);
      expect(JSON.parse(event!.payload)).toMatchObject({ from: first.branch, to: "main", on: one });

      // The send-back's steer names the merges; a plain merge of main would conflict, the named ones do not.
      // The stage-start steer is written when the scheduler grants the stage again.
      const sql = "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%landed in main%' ORDER BY created_at DESC LIMIT 1";
      await waitUntil(() => query(e, sql, retargeted.id) !== null, 30_000, "the send-back's steer");
      const steer = query<{ body: string }>(e, sql, retargeted.id);
      const steps = steer!.body.split("\n").filter((line) => line.startsWith("git "));
      expect(steps).toHaveLength(5);
      const worktree = retargeted.worktree_path;
      expect(git(worktree, ["fetch", "-q", "origin", "main"]).code).toBe(0);
      expect(git(worktree, ["merge-tree", "--write-tree", "HEAD", "origin/main"]).code).not.toBe(0);
      for (const step of steps) {
        const ran = git(worktree, step.split(" ").slice(1));
        expect(ran, step).toMatchObject({ code: 0 });
      }
      expect(git(worktree, ["diff", "--name-only", "origin/main", "HEAD"]).out.split("\n").toSorted()).toEqual(["shared.txt", "two.txt"]);

      // Delivered again into main, it merges and lands.
      await waitUntil(() => runOf(e, two)?.stage_state === "active", 30_000, "the last stage started again");
      writeFileSync(join(e.fleet.h.dataDir, two, "again"), "");
      const head = git(worktree, ["rev-parse", "HEAD"]).out;
      await waitUntil(() => runOf(e, two)?.state === "ready" && e.github.pr("acme/web", 2).headSha === head, 30_000, "phase 2 delivered again");
      expect((await e.approve(two)).ok).toBe(true);
      const merged = await e.fleet.json(["merge", two]);
      expect(merged.code).toBe(0);
      await waitUntil(() => runOf(e, two)?.state === "cleaned", 30_000, "phase 2 landed and cleaned up");
      expect(git(e.fleet.origin!, ["show", "main:shared.txt"]).out).toBe("two");
      expect(git(e.fleet.origin!, ["show", "main:two.txt"]).out).toBe("two");
    },
    { timeout: 180_000 },
  );
});
