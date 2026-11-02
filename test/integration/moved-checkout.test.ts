/**
 * A moved project checkout and a cancelled run resumed in place
 * (docs/notes/2026-11-01-flowryn-survive-a-xa.md), on the fake fleet with
 * real git checkouts in the test home: the checkout is renamed under its
 * worktrees, `project set --path` relinks them, and a run cancelled after
 * its design gate passed resumes in its own worktree with its uncommitted
 * change, its stage and its passed gate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import { listTasks, processRunner } from "../../src/journal/tasks-axi.ts";
import { realTasksAxi, waitUntil } from "../helpers/harness.ts";
import { checkoutChecks } from "../../src/doctor/doctor.ts";

let fleet: FleetEnv | null = null;
let ship: ShipEnv | null = null;
afterEach(async () => {
  await fleet?.cleanup();
  await ship?.cleanup();
  fleet = null;
  ship = null;
});

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdin: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

function doctorChecks(env: FleetEnv) {
  const db = env.h.db();
  try {
    return checkoutChecks(db);
  } finally {
    db.close();
  }
}

async function backlogTask(env: FleetEnv, taskId: string) {
  const tasks = await listTasks(processRunner(realTasksAxi(), Bun.which("node")), env.h.backlog);
  return tasks.find((t) => t.id === taskId) ?? null;
}

describe("a moved project checkout", () => {
  test(
    "project set --path relinks the worktree git broke, lists the live worker, and a rerun is a retry; the doctor fails until then",
    async () => {
      const env = (fleet = await makeFleetEnv());
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000", { kind: "ship" });
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const worktree = busy.worktree_path;
      expect(git(worktree, ["rev-parse", "HEAD"]).code).toBe(0);

      const moved = join(dirname(env.repo), "moved", "repo");
      mkdirSync(dirname(moved), { recursive: true });
      renameSync(env.repo, moved);
      // The worktree's .git names the old admin dir: git cannot read it, and the doctor says how to fix the project.
      expect(git(worktree, ["rev-parse", "HEAD"]).code).not.toBe(0);
      expect(doctorChecks(env)).toEqual([expect.objectContaining({ check: "project web", status: "fail", detail: expect.stringContaining("flowryn project set web --path") })]);

      const set = await env.json(["project", "set", "web", "--path", moved]);
      expect(set.code).toBe(0);
      const data = set.reply.data as { changed: string[]; worktrees: { task: string; result: string }[]; live: string[]; project: { path: string } };
      expect(data.changed).toEqual(["path"]);
      expect(data.project.path).toBe(realpathSync(moved));
      expect(data.worktrees).toEqual([expect.objectContaining({ task, result: "repaired" })]);
      expect(data.live).toEqual([task]);
      expect((set.reply.hints as string[]).join("\n")).toContain(`flowryn cancel ${task}, then flowryn resume ${task}`);
      // Both directions are linked again: the worktree reads its head, and its common dir is the moved checkout's.
      expect(git(worktree, ["rev-parse", "HEAD"]).code).toBe(0);
      expect(realpathSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out)).toBe(realpathSync(join(moved, ".git")));
      expect(git(moved, ["worktree", "list", "--porcelain"]).out).not.toContain("prunable");
      expect(doctorChecks(env)).toEqual([expect.objectContaining({ check: "checkouts", status: "ok" })]);

      // Again with the same path: nothing changes, the repair runs as a retry and finds the link fine.
      const again = await env.json(["project", "set", "web", "--path", moved]);
      expect(again.code).toBe(0);
      expect((again.reply.data as { changed: string[]; worktrees: { result: string }[]; live: string[] }).worktrees.map((w) => w.result)).toEqual(["ok"]);
      expect((again.reply.data as { live: string[] }).live).toEqual([]);
    },
    { timeout: 60_000 },
  );

  test(
    "a worktree whose link alone is broken fails the doctor with the relink command; project set with the same path fixes it",
    async () => {
      const env = (fleet = await makeFleetEnv());
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000", { kind: "ship" });
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      // The checkout's admin dir for the worktree is renamed away: the worktree's .git points at a missing dir.
      const admin = git(busy.worktree_path, ["rev-parse", "--path-format=absolute", "--git-dir"]).out;
      renameSync(admin, `${admin}-gone`);
      expect(doctorChecks(env)).toEqual([
        expect.objectContaining({ check: `worktree ${task}`, status: "fail", detail: expect.stringContaining(`worktree repair ${busy.worktree_path}`) }),
      ]);
      const set = await env.json(["project", "set", "web", "--path", env.repo]);
      expect(set.code).toBe(0);
      expect((set.reply.data as { worktrees: { result: string }[] }).worktrees.map((w) => w.result)).toEqual(["repaired"]);
      expect(git(busy.worktree_path, ["rev-parse", "HEAD"]).code).toBe(0);
      expect(doctorChecks(env)).toEqual([expect.objectContaining({ check: "checkouts", status: "ok" })]);
    },
    { timeout: 60_000 },
  );

  test(
    "project set --path refuses a folder inside a checkout, another project's checkout, and another repository",
    async () => {
      const env = (fleet = await makeFleetEnv());
      const inside = join(env.repo, "sub");
      mkdirSync(inside);
      const nested = await env.json(["project", "set", "web", "--path", inside]);
      expect(nested.reply.error).toMatchObject({ code: "invalid_project" });

      const other = join(dirname(env.repo), "other");
      mkdirSync(other);
      git(other, ["init", "-q", "-b", "main"]);
      writeFileSync(join(other, "a.txt"), "a\n");
      git(other, ["add", "."]);
      git(other, ["commit", "-q", "-m", "a"]);
      expect((await env.json(["project", "add", other, "--id", "other", "--mode", "local-only"])).code).toBe(0);
      const taken = await env.json(["project", "set", "web", "--path", other]);
      expect(taken.reply.error).toMatchObject({ code: "already_exists" });

      // A registered remote that the new checkout's origin does not match.
      expect((await env.json(["project", "set", "web", "--repo-url", "https://github.com/acme/web.git"])).code).toBe(0);
      const third = join(dirname(env.repo), "third");
      mkdirSync(third);
      git(third, ["init", "-q", "-b", "main"]);
      git(third, ["remote", "add", "origin", "https://github.com/acme/elsewhere.git"]);
      writeFileSync(join(third, "a.txt"), "a\n");
      git(third, ["add", "."]);
      git(third, ["commit", "-q", "-m", "a"]);
      const elsewhere = await env.json(["project", "set", "web", "--path", third]);
      expect(elsewhere.reply.error).toMatchObject({ code: "invalid_project" });
      expect((elsewhere.reply.error as { message: string }).message).toContain("acme/elsewhere");
      const db = env.h.db();
      try {
        expect((db.query("SELECT path FROM projects WHERE id = 'web'").get() as { path: string }).path).toBe(realpathSync(env.repo));
      } finally {
        db.close();
      }
    },
    { timeout: 60_000 },
  );
});

describe("a cancelled run resumed in place", () => {
  test(
    "resume takes a run cancelled after its design gate passed: same worktree and branch, the uncommitted change kept, the stage and the passed gate stand, the task In flight",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const steps = [
        "Feature kept",
        `FAKE: write design/design.html ${filledDesignPage()}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: scratch kept.txt work in progress",
        "FAKE: sleep 120000",
      ].join("\n");
      const { task, run } = await f.dispatch(steps, { kind: "ship" });
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      expect((await e.approve(task, { gate: "design" })).ok).toBe(true);
      const building = await f.waitRun(run, (r) => r.stage === "build" && r.liveness === "busy", "the build stage");
      await waitUntil(() => existsSync(join(building.worktree_path, "kept.txt")), 20_000, "the uncommitted change");

      const cancelled = await f.json(["cancel", task, "--reason", "its sandbox names the old path"]);
      expect(cancelled.code).toBe(0);
      expect(f.run(run).state).toBe("cancelled");
      await waitUntil(async () => (await backlogTask(f, task))?.hold?.kind === "parked", 10_000, "the task parked");

      const resumed = await f.json(["resume", task]);
      expect(resumed.code).toBe(0);
      expect(resumed.reply.data).toMatchObject({ run, task });
      const back = await f.waitRun(run, (r) => r.resume_count === 1 && r.liveness === "busy", "the resumed worker", 30_000);
      expect(back.state).toBe("running");
      expect(back.worktree_path).toBe(building.worktree_path);
      expect(back.branch).toBe(building.branch);
      expect(back.stage).toBe("build");
      expect(readFileSync(join(back.worktree_path, "kept.txt"), "utf8")).toContain("work in progress");
      expect(git(back.worktree_path, ["status", "--porcelain"]).out).toContain("kept.txt");
      const db = f.h.db();
      try {
        expect(db.query("SELECT stage, state FROM gates WHERE run_id = ?1 AND kind = 'review'").all(run)).toEqual([{ stage: "design", state: "passed" }]);
        const payload = (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.resume_requested'").get(run) as { payload: string }).payload;
        expect(JSON.parse(payload)).toMatchObject({ from: "cancelled" });
      } finally {
        db.close();
      }
      await waitUntil(async () => {
        const t = await backlogTask(f, task);
        return t?.state === "in_flight" && t.hold === null;
      }, 10_000, "the task back In flight");
    },
    { timeout: 150_000 },
  );

  test(
    "a resume over a broken worktree link fails naming the relink; after project set relinks it, resume starts the worker",
    async () => {
      const env = (fleet = await makeFleetEnv());
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000", { kind: "ship" });
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      expect((await env.json(["cancel", task])).code).toBe(0);
      const admin = git(busy.worktree_path, ["rev-parse", "--path-format=absolute", "--git-dir"]).out;
      renameSync(admin, `${admin}-gone`);
      expect((await env.json(["resume", task])).code).toBe(0);
      await env.waitRun(run, (r) => r.state === "failed", "the refused launch");
      const db = env.h.db();
      try {
        const reason = JSON.parse((db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.failed'").get(run) as { payload: string }).payload).reason as string;
        expect(reason).toContain("which is gone");
        expect(reason).toContain(`worktree repair ${busy.worktree_path}`);
      } finally {
        db.close();
      }
      expect((await env.json(["project", "set", "web", "--path", env.repo])).code).toBe(0);
      expect((await env.json(["resume", task])).code).toBe(0);
      const back = await env.waitRun(run, (r) => r.state === "running" && r.liveness === "busy" && r.resume_count === 2, "the resumed worker", 30_000);
      expect(back.worktree_path).toBe(busy.worktree_path);
    },
    { timeout: 90_000 },
  );

  test(
    "resume refuses a cancelled run once it is cleaned up",
    async () => {
      const env = (fleet = await makeFleetEnv());
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000", { kind: "ship" });
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      expect((await env.json(["cancel", task])).code).toBe(0);
      expect((await env.json(["cleanup", task])).code).toBe(0);
      await env.waitRun(run, (r) => r.cleanup === "done", "the cleanup");
      const resumed = await env.json(["resume", task]);
      expect(resumed.code).not.toBe(0);
      expect(resumed.reply.error).toMatchObject({ code: "run_not_active" });
    },
    { timeout: 60_000 },
  );
});
