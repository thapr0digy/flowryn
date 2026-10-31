import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The upkeep hooks through the real daemon (spec 3, phase 3), with the fake
 * Herdr and its fake workers, and the fake GitHub backed by the project's
 * bare origin: a conflicting PR nudges its ship (and asks you once a head
 * comes back unchanged), the switch turns the nudge off, a landing syncs the
 * primary checkout, and the sweep cleans an ended worktree through the
 * cleanup guard while it keeps one with unlanded work. The build after a
 * merge needs a compiled, stamped daemon; test/unit/upkeep-build.test.ts
 * covers it against real git.
 */

let env: ShipEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A merge on GitHub that someone else made: fix.txt on origin's main, which the ship's own fix.txt then conflicts with. */
function conflictingMergeOnOrigin(origin: string): void {
  const clone = mkdtempSync(join(tmpdir(), "fw-upkeep-clone-"));
  try {
    git(tmpdir(), ["clone", "-q", origin, clone]);
    writeFileSync(join(clone, "fix.txt"), "someone else's fix\n");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-q", "-m", "another fix"]);
    git(clone, ["push", "-q", "origin", "main"]);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function openItems(e: ShipEnv, kind: string): string[] {
  const db = e.fleet.h.db();
  try {
    return (db.query("SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { line: string }[]).map((r) => r.line);
  } finally {
    db.close();
  }
}

function steers(e: ShipEnv, run: string): string[] {
  const db = e.fleet.h.db();
  try {
    return (db.query("SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at, rowid").all(run) as { body: string }[]).map((r) => r.body);
  } finally {
    db.close();
  }
}

function events(e: ShipEnv, kind: string): Record<string, unknown>[] {
  const db = e.fleet.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

const shipSteps = (api: string, after: string) => `Fix the login loop\nFAKE: commit fix.txt fixed\nFAKE: push\nFAKE: pr ${api} acme/web\nFAKE: deliver-pr\n${after}FAKE: sleep 120000`;

describe("nudge a ship whose PR conflicts", () => {
  test(
    "a delivered PR GitHub reads as unmergeable sends its ship back to merge main; the same head delivered again asks you instead",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", extraConfig: "[upkeep]\nsync_primary = false" });
      const e = env;
      conflictingMergeOnOrigin(e.fleet.origin!);
      const { run } = await e.fleet.dispatch(shipSteps(e.github.apiUrl, "FAKE: sleep 4000\nFAKE: deliver-pr\n"), { kind: "ship" });
      await waitUntil(() => openItems(e, "conflict_nudged").length === 1, 30_000, "the nudge");
      expect(openItems(e, "conflict_nudged")[0]).toBe("PR conflicts with main: Fix the login loop (web); sent back to merge origin/main and deliver again (nudge 1 of 3)");
      await waitUntil(() => steers(e, run).some((s) => s.includes("conflicts with main")), 15_000, "the nudge's steer");
      const nudge = steers(e, run).find((s) => s.includes("conflicts with main"))!;
      expect(nudge).toContain(`Your PR ${e.github.prUrl("acme/web", 1)} conflicts with main`);
      expect(nudge).toContain("git merge origin/main");
      expect(nudge).toContain("Never rebase or force-push.");
      const [nudged] = events(e, "run.conflict_nudged");
      expect(nudged).toMatchObject({ pr: e.github.prUrl("acme/web", 1), base: "main", nudge: 1 });

      // The worker delivers the same head again, unchanged: no second nudge, one P1 for you.
      await waitUntil(() => openItems(e, "pr_conflict").length === 1, 30_000, "the pr_conflict P1");
      expect(openItems(e, "pr_conflict")[0]).toContain(`PR still conflicts with main after 1 nudge: Fix the login loop (web)`);
      expect(openItems(e, "pr_conflict")[0]).toEndWith(`; steer it or flowryn decline ${e.fleet.run(run).task_id}`);
      expect(e.fleet.run(run).state).toBe("ready");
      expect(events(e, "run.conflict_nudged")).toHaveLength(1);
      expect(openItems(e, "pr_ready")).toHaveLength(1);
    },
    { timeout: 90_000 },
  );

  test(
    "nudge_conflicts = false: a conflicting PR stays delivered and nobody is steered",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", extraConfig: "[upkeep]\nsync_primary = false\nnudge_conflicts = false" });
      const e = env;
      conflictingMergeOnOrigin(e.fleet.origin!);
      const { run } = await e.fleet.dispatch(shipSteps(e.github.apiUrl, ""), { kind: "ship" });
      await e.fleet.waitRun(run, (r) => r.state === "ready", "delivered");
      const polled = e.github.count("GET", "/pulls/1");
      await waitUntil(() => e.github.count("GET", "/pulls/1") >= polled + 3, 15_000, "three more PR reads");
      expect(e.fleet.run(run).state).toBe("ready");
      expect(steers(e, run).some((s) => s.includes("conflicts with"))).toBe(false);
      expect(openItems(e, "conflict_nudged")).toEqual([]);
    },
    { timeout: 60_000 },
  );
});

describe("sync the primary checkout after a merge", () => {
  test(
    "a merged PR lands, and the primary checkout is fast-forwarded to origin's main",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task, run } = await e.fleet.dispatch(shipSteps(e.github.apiUrl, ""), { kind: "ship" });
      await e.fleet.waitRun(run, (r) => r.state === "ready", "delivered");
      const before = git(e.fleet.repo, ["rev-parse", "HEAD"]);
      expect((await e.approve(task)).ok).toBe(true);
      expect((await e.fleet.json(["merge", task])).code).toBe(0);
      await e.fleet.waitRun(run, (r) => r.state === "cleaned", "cleaned", 30_000);
      const merged = git(e.fleet.origin!, ["rev-parse", "main"]);
      expect(merged).not.toBe(before);
      await waitUntil(() => git(e.fleet.repo, ["rev-parse", "HEAD"]) === merged, 15_000, "the primary checkout at origin's main");
      expect(git(e.fleet.repo, ["show", "HEAD:fix.txt"])).toBe("fixed");
      // The fast-forward moves HEAD before its event is written.
      await waitUntil(() => events(e, "upkeep.synced").length > 0, 5_000, "the sync's event");
      expect(events(e, "upkeep.synced")).toEqual([{ project: "web", from: before, to: merged }]);
    },
    { timeout: 90_000 },
  );
});

describe("clean failed or cancelled worktrees", () => {
  test(
    "an ended run idle past the wait is cleaned through the guard; one with unlanded work is kept, with no item",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", extraConfig: "[upkeep]\ninterval_ms = 300\nclean_ended_hours = 0.001" });
      const e = env;
      const empty = await e.fleet.dispatch("Nothing yet\nFAKE: sleep 120000", { kind: "ship" });
      const wip = await e.fleet.dispatch("Abandon\nFAKE: commit wip.txt work in progress\nFAKE: sleep 120000", { kind: "ship" });
      await e.fleet.waitRun(empty.run, (r) => r.worker_started_at !== null, "worker started");
      await e.fleet.waitRun(wip.run, (r) => r.worker_started_at !== null, "worker started");
      await waitUntil(() => git(e.fleet.run(wip.run).worktree_path, ["log", "--oneline", "-1"]).includes("wip.txt"), 10_000, "the commit");
      const emptyWorkspace = e.fleet.run(empty.run).workspace_id;
      expect((await e.fleet.json(["cancel", empty.task])).code).toBe(0);
      expect((await e.fleet.json(["cancel", wip.task])).code).toBe(0);

      const cleaned = await e.fleet.waitRun(empty.run, (r) => r.cleanup === "done", "the sweep's cleanup", 30_000);
      expect(cleaned.state).toBe("cancelled");
      expect(existsSync(cleaned.worktree_path)).toBe(false);
      expect(git(e.fleet.repo, ["branch", "--list", cleaned.branch])).toBe("");
      if (emptyWorkspace) await waitUntil(() => !e.fleet.herdr.workspaces.has(emptyWorkspace), 5_000, "the workspace closed");

      const refused = await e.fleet.waitRun(wip.run, (r) => r.cleanup === "refused", "the sweep's refusal", 30_000);
      expect(refused.state).toBe("cancelled");
      expect(existsSync(refused.worktree_path)).toBe(true);
      expect(git(refused.worktree_path, ["log", "--oneline", "-1"])).toContain("wip.txt");
      expect(openItems(e, "cleanup_refused")).toEqual([]);
      const swept = events(e, "cleanup.done").filter((p) => p.sweep === true);
      expect(swept).toHaveLength(1);
      expect(events(e, "cleanup.refused").filter((p) => p.sweep === true).length).toBeGreaterThanOrEqual(1);
    },
    { timeout: 90_000 },
  );
});
