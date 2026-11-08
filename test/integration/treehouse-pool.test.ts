/**
 * Run worktrees from Flowryn's treehouse pool
 * (docs/notes/2026-11-04-use-treehouse-for-2b.md), on the fake fleet with the
 * test home's stand-in treehouse (test/helpers/fake-treehouse.ts) and real
 * git: a ship leases a slot, cleanup returns it after the guard's verdict, the
 * next run gets the same slot back clean and branchless with its ignored files
 * kept; and a failing treehouse leaves the run on today's git worktree, logged,
 * recorded and shown by doctor.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { worktreeChecks } from "../../src/doctor/doctor.ts";
import { loadConfig } from "../../src/config/config.ts";
import { stateFiles } from "../../src/config/paths.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

let fleet: FleetEnv | null = null;
afterEach(async () => {
  await fleet?.cleanup();
  fleet = null;
});

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdin: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

function calls(env: FleetEnv): string[][] {
  const log = join(env.h.home, "treehouse-calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

function events(env: FleetEnv, runId: string, kind: string): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(runId, kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe("run worktrees from the treehouse pool", () => {
  test(
    "a ship leases a pool slot, cleanup returns it after the guard, and the next run reuses it clean with its ignored files kept",
    async () => {
      const env = (fleet = await makeFleetEnv({ worktreeProvider: "treehouse" }));
      // An ignored folder: the warm cache a reused slot keeps.
      writeFileSync(join(env.repo, ".gitignore"), "*.cache\n");
      git(env.repo, ["add", ".gitignore"]);
      git(env.repo, ["commit", "-q", "-m", "ignore cache"]);

      const first = await env.dispatch("Build\nFAKE: commit a.txt hello\nFAKE: scratch warm.cache warm\nFAKE: sleep 60000", { kind: "ship" });
      const busy = await env.waitRun(first.run, (r) => r.liveness === "busy", "busy");
      const slot = busy.worktree_path;
      expect(realpathSync(slot).startsWith(realpathSync(join(env.h.home, "wt", "web", ".pool", ".treehouse")))).toBe(true);
      expect(busy.worktree_lease).toMatch(/^[0-9a-f]{32}$/);
      expect(git(slot, ["branch", "--show-current"]).out).toBe(busy.branch);
      const get = calls(env).find((argv) => argv.includes("get"))!;
      expect(get).toEqual(expect.arrayContaining(["--lease", "--json", "--no-fetch", "--unique-leaf", "--lease-holder", `flowryn:${first.run}`]));
      expect(events(env, first.run, "run.worktree_leased")).toEqual([expect.objectContaining({ path: slot, lease: busy.worktree_lease, adopted: false })]);
      await waitUntil(() => existsSync(join(slot, "warm.cache")) && git(slot, ["log", "--oneline", "-1"]).out.includes("a.txt"), 10_000, "the commit and the cache file");

      expect((await env.json(["cancel", first.task])).code).toBe(0);
      // The work lands in the local main: the guard's verdict allows a plain return, no discard.
      expect(git(env.repo, ["merge", "-q", "--ff-only", busy.branch]).code).toBe(0);
      const cleaned = await env.json(["cleanup", first.task]);
      expect(cleaned.code).toBe(0);
      expect(cleaned.reply.data).toMatchObject({ removed: true });
      expect(events(env, first.run, "cleanup.done")[0]!.steps).toContain("worktree_return:ok");
      const ret = calls(env).find((argv) => argv.includes("return"))!;
      expect(ret).toEqual(expect.arrayContaining(["--if-lease-id", busy.worktree_lease!, slot]));
      expect(ret).not.toContain("--force");
      const after = env.run(first.run);
      expect(after.cleanup).toBe("done");
      expect(after.worktree_lease).toBeNull();
      // Back in the pool: detached, the branch deleted, the ignored cache kept.
      expect(existsSync(slot)).toBe(true);
      expect(git(slot, ["branch", "--show-current"]).out).toBe("");
      expect(git(env.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${busy.branch}`]).code).not.toBe(0);
      expect(existsSync(join(slot, "warm.cache"))).toBe(true);

      const second = await env.dispatch("Next\nFAKE: sleep 60000", { kind: "ship" });
      const next = await env.waitRun(second.run, (r) => r.liveness === "busy", "busy");
      expect(realpathSync(next.worktree_path)).toBe(realpathSync(slot));
      expect(next.worktree_lease).not.toBe(busy.worktree_lease);
      expect(git(slot, ["branch", "--show-current"]).out).toBe(next.branch);
      // Nothing of the first run leaks: no untracked or changed file, and its commit is only what main has.
      expect(git(slot, ["status", "--porcelain"]).out).toBe("");
      expect(git(slot, ["rev-parse", "HEAD"]).out).toBe(git(env.repo, ["rev-parse", "HEAD"]).out);
      expect(readFileSync(join(slot, "warm.cache"), "utf8")).toContain("warm");
    },
    { timeout: 90_000 },
  );

  test(
    "a resume whose pool slot was destroyed by hand hands the old lease back and takes a fresh slot",
    async () => {
      const env = (fleet = await makeFleetEnv({ worktreeProvider: "treehouse" }));
      const { run } = await env.dispatch("Build\nFAKE: commit a.txt hello\nFAKE: sleep 60000", { kind: "ship" });
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const lost = busy.worktree_path;
      await waitUntil(() => git(env.repo, ["log", "--oneline", "-1", busy.branch]).out.includes("a.txt"), 10_000, "the commit");
      const head = git(env.repo, ["rev-parse", busy.branch]).out;
      // The folder goes while the worker runs, then the worker dies: the resume finds its slot gone.
      rmSync(lost, { recursive: true, force: true });
      env.herdr.killHarness(busy.pane_id!, "SIGKILL");
      const back = await env.waitRun(run, (r) => r.resume_count === 1 && r.liveness === "busy" && r.proc_pid !== busy.proc_pid, "the resumed worker", 30_000);
      expect(back.worktree_lease).not.toBe(busy.worktree_lease);
      expect(existsSync(back.worktree_path)).toBe(true);
      expect(git(back.worktree_path, ["branch", "--show-current"]).out).toBe(busy.branch);
      expect(git(back.worktree_path, ["rev-parse", "HEAD"]).out).toBe(head);
      expect(events(env, run, "run.worktree_fallback")).toEqual([]);
      expect(events(env, run, "run.worktree_lost")).toEqual([expect.objectContaining({ path: lost, lease: busy.worktree_lease })]);
      const ret = calls(env).find((argv) => argv.includes("return"))!;
      expect(ret).toEqual(expect.arrayContaining(["--force", "--if-lease-id", busy.worktree_lease!, lost]));
      const pool = JSON.parse(readFileSync(join(env.h.home, "wt", "web", ".pool", ".treehouse", "fake-state.json"), "utf8")) as { path: string; lease_id: string }[];
      expect(pool.some((slot) => slot.lease_id === busy.worktree_lease)).toBe(false);
      expect(pool.filter((slot) => slot.lease_id !== "").map((slot) => slot.lease_id)).toEqual([back.worktree_lease!]);
    },
    { timeout: 90_000 },
  );

  test(
    "a failing treehouse leaves the run on a fresh git worktree, with a log line, an event and a doctor warning",
    async () => {
      const env = (fleet = await makeFleetEnv({ worktreeProvider: "treehouse" }));
      writeFileSync(join(env.h.home, "treehouse.fail"), "treehouse: all 1 worktrees are in use (max_trees = 1)\n");
      const { task, run } = await env.dispatch("Build\nFAKE: commit a.txt hello\nFAKE: sleep 60000", { kind: "ship" });
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      expect(busy.worktree_path).toBe(join(env.h.home, "wt", "web", task));
      expect(busy.worktree_lease).toBeNull();
      expect(git(busy.worktree_path, ["branch", "--show-current"]).out).toBe(busy.branch);
      const fallbacks = events(env, run, "run.worktree_fallback");
      expect(fallbacks).toEqual([{ reason: expect.stringContaining("max_trees = 1") }]);
      expect(readFileSync(join(stateFiles(env.h.stateDir).logs, "flowrynd.log"), "utf8")).toContain("no pool worktree (treehouse status failed");
      const doctor = await worktreeChecks(loadConfig(env.h.home).config);
      expect(doctor).toEqual(
        expect.arrayContaining([expect.objectContaining({ check: "worktree fallbacks", status: "warn", detail: expect.stringContaining("max_trees = 1") })]),
      );

      // Its cleanup is today's: the guard, then git removes the worktree.
      // Busy comes before the worker's commit lands; cancelling mid-commit would leave a.txt uncommitted.
      await waitUntil(() => git(env.repo, ["log", "--oneline", "-1", busy.branch]).out.includes("a.txt"), 10_000, "the commit");
      expect((await env.json(["cancel", task])).code).toBe(0);
      expect(git(env.repo, ["merge", "-q", "--ff-only", busy.branch]).code).toBe(0);
      const cleaned = await env.json(["cleanup", task]);
      expect(cleaned.code).toBe(0);
      expect(events(env, run, "cleanup.done")[0]!.steps).toContain("worktree_remove:ok");
      expect(existsSync(busy.worktree_path)).toBe(false);
      expect(calls(env).some((argv) => argv.includes("return"))).toBe(false);
    },
    { timeout: 90_000 },
  );
});
