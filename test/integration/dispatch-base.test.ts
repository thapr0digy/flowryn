import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { createStandaloneDecision } from "../../src/lifecycle/decisions.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * `dispatch --base <branch>` (docs/notes/2026-10-27-stack-a-plan-4y.md): a
 * ship that starts from a named branch on origin and opens its PR into it,
 * against a real daemon, the fake GitHub backed by the project's bare origin,
 * and fake workers. Nothing reaches GitHub.
 */

let ship: ShipEnv | null = null;
const fleets: FleetEnv[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
  for (const env of fleets.splice(0)) await env.cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A branch on origin with one commit main lacks (release.txt), pushed from a scratch clone. */
function pushReleaseBranch(origin: string, branch = "release/2"): void {
  const dir = mkdtempSync(join(tmpdir(), "fl-base-"));
  scratch.push(dir);
  git(dir, ["clone", "-q", origin, "c"]);
  const clone = join(dir, "c");
  writeFileSync(join(clone, "release.txt"), "release work\n");
  git(clone, ["add", "release.txt"]);
  git(clone, ["commit", "-q", "-m", "release work"]);
  git(clone, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
}

function errorOf(reply: Record<string, unknown>): { code: string; message: string } {
  const error = (reply.error ?? {}) as { code?: string; message?: string };
  return { code: error.code ?? "", message: error.message ?? "" };
}

const prSteps = (api: string, base: string | null) => `FAKE: commit fix.txt fixed\nFAKE: push\nFAKE: pr ${api} acme/web${base ? ` base:${base}` : ""}\nFAKE: deliver-pr\n`;

async function shipOnBase(e: ShipEnv, prBase: string | null): Promise<{ task: string; run: string }> {
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--base", "release/2", "--body-file", "-"], {
    stdin: `Fix the release\n${prSteps(e.github.apiUrl, prBase)}FAKE: sleep 120000`,
  });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  return dispatched.reply.data as { task: string; run: string };
}

describe("dispatch --base", () => {
  test(
    "a ship starts from origin's release branch, is told to target it, delivers a PR into it, and merges and cleans up there",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      pushReleaseBranch(e.fleet.origin!);
      const { task, run } = await shipOnBase(e, "release/2");
      await e.fleet.waitRun(run, (r) => r.state === "ready", "delivered into release/2");
      const row = e.fleet.run(run) as unknown as { base_branch: string | null; worktree_path: string };
      expect(row.base_branch).toBe("release/2");
      // Started from the release branch: its commit is in the worktree's history.
      expect(git(row.worktree_path, ["log", "--format=%s"])).toContain("release work");
      const contract = readFileSync(join(e.fleet.h.stateDir, "runs", run, "contract.md"), "utf8");
      expect(contract).toContain("open a PR into release/2 (gh-axi pr create)");
      expect(contract).toContain("To take your base: new commits, git merge origin/release/2, a plain git push.");
      expect(contract).not.toContain("To take main");
      const shown = await e.fleet.json(["show", task]);
      expect(shown.reply.data).toMatchObject({ base: "release/2" });

      expect((await e.approve(task)).ok).toBe(true);
      const merged = await e.fleet.json(["merge", task]);
      expect(merged.code).toBe(0);
      const done = await e.fleet.waitRun(run, (r) => r.state === "cleaned", "cleaned", 30_000);
      expect(done.cleanup).toBe("done");
      expect(existsSync(done.worktree_path)).toBe(false);
      expect(git(e.fleet.origin!, ["show", "release/2:fix.txt"])).toBe("fixed");
      expect(Bun.spawnSync(["git", "show", "main:fix.txt"], { cwd: e.fleet.origin!, env: GIT_ENV }).exitCode).not.toBe(0);
    },
    { timeout: 90_000 },
  );

  test(
    "a based ship's PR into main is refused at deliver",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      pushReleaseBranch(e.fleet.origin!);
      const { task } = await shipOnBase(e, null);
      const [reply] = await e.replies(task, 1);
      expect(reply!.code).not.toBe(0);
      expect(errorOf(reply!.reply)).toMatchObject({ code: "delivery_refused" });
      expect(errorOf(reply!.reply).message).toContain("targets main, not release/2");
    },
    { timeout: 60_000 },
  );

  test(
    "the merge gate refuses a PR whose base moved away from the run's (base_mismatch)",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      pushReleaseBranch(e.fleet.origin!);
      const { task, run } = await shipOnBase(e, "release/2");
      await e.fleet.waitRun(run, (r) => r.state === "ready", "delivered");
      e.github.pr("acme/web", 1).baseRef = "main";
      const refused = await e.fleet.json(["merge", task]);
      expect(refused.code).toBe(2);
      expect(errorOf(refused.reply)).toMatchObject({ code: "base_mismatch" });
      expect(errorOf(refused.reply).message).toContain("targets main, not its base release/2");
    },
    { timeout: 60_000 },
  );

  test("a queued ship keeps its base; starting a queued task refuses a new --base", async () => {
    const env = await makeFleetEnv({ mode: "no-mistakes", origin: true });
    fleets.push(env);
    pushReleaseBranch(env.origin!);
    const blocker = await env.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { stdin: "first\nFAKE: sleep 60000" });
    expect(blocker.code).toBe(0);
    const queued = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", (blocker.reply.data as { task: string }).task, "--base", "release/2", "--body-file", "-"], { stdin: "second" });
    expect(queued.code).toBe(0);
    expect(queued.reply.data).toMatchObject({ state: "queued", base: "release/2" });
    const task = (queued.reply.data as { task: string }).task;
    const db = env.h.db();
    const policy = db.query("SELECT base_branch FROM task_policy WHERE task_id = ?1").get(task) as { base_branch: string | null };
    db.close();
    expect(policy.base_branch).toBe("release/2");
    const restart = await env.json(["dispatch", "web", "--task", task, "--base", "main"]);
    expect(restart.code).toBe(3);
    expect(errorOf(restart.reply).message).toContain("--base is set when a task is filed");
  });

  test(
    "a queued --base ship that starts by itself (the scheduler) starts from its base and delivers into it",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR", yolo: true });
      const e = ship;
      pushReleaseBranch(e.fleet.origin!);
      const token = { env: { FLOWRYN_TOKEN: e.leaderToken() } };
      const db = e.fleet.h.db();
      const decision = tx(db, () => createStandaloneDecision(db, { key: "go", question: "Go?", options: ["yes", "no"], origin: "test", project: "web", now: Date.now() }));
      db.close();
      const filed = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--blocked-by", decision.taskId, "--auto", "--base", "release/2", "--body-file", "-"], {
        ...token,
        stdin: `After the decision\n${prSteps(e.github.apiUrl, "release/2")}FAKE: sleep 120000`,
      });
      expect(filed.code).toBe(0);
      const task = (filed.reply.data as { task: string }).task;
      expect((await e.fleet.json(["decide", decision.id, "yes", "--rationale", "go"], token)).code).toBe(0);
      let run = "";
      await waitUntil(() => {
        const read = e.fleet.h.db();
        try {
          run = (read.query("SELECT id FROM runs WHERE task_id = ?1").get(task) as { id: string } | null)?.id ?? "";
        } finally {
          read.close();
        }
        return run !== "";
        // About 30 s here, the same without --base.
      }, 60_000, "the queued ship started by itself");
      const ready = await e.fleet.waitRun(run, (r) => r.state === "ready", "delivered into release/2");
      expect((ready as unknown as { base_branch: string | null }).base_branch).toBe("release/2");
      expect(git(ready.worktree_path, ["log", "--format=%s"])).toContain("release work");
      expect(e.github.pr("acme/web", 1).baseRef).toBe("release/2");
    },
    { timeout: 150_000 },
  );

  test("refusals: a missing branch, a bad name, a scout, a local-only project; the default branch is no base", async () => {
    const env = await makeFleetEnv({ mode: "no-mistakes", origin: true });
    fleets.push(env);
    const missing = await env.json(["dispatch", "web", "--kind", "ship", "--base", "release/9", "--body-file", "-"], { stdin: "x" });
    expect(missing.code).toBe(3);
    expect(errorOf(missing.reply).message).toContain("cannot fetch release/9 from origin");
    const bad = await env.json(["dispatch", "web", "--kind", "ship", "--base", "a..b", "--body-file", "-"], { stdin: "x" });
    expect(bad.code).toBe(3);
    expect(errorOf(bad.reply).message).toContain("not a valid branch name");
    const scout = await env.json(["dispatch", "web", "--kind", "scout", "--base", "main", "--body-file", "-"], { stdin: "x" });
    expect(scout.code).toBe(3);
    expect(errorOf(scout.reply).message).toContain("a scout opens no PR");
    const plain = await env.json(["dispatch", "web", "--kind", "ship", "--base", "main", "--body-file", "-"], { stdin: "on main\nFAKE: sleep 60000" });
    expect(plain.code).toBe(0);
    expect(plain.reply.data).not.toHaveProperty("base");
    const db = env.h.db();
    const run = db.query("SELECT base_branch FROM runs WHERE id = ?1").get((plain.reply.data as { run: string }).run) as { base_branch: string | null };
    db.close();
    expect(run.base_branch).toBeNull();

    const local = await makeFleetEnv();
    fleets.push(local);
    const refused = await local.json(["dispatch", "web", "--kind", "ship", "--base", "main2", "--body-file", "-"], { stdin: "x" });
    expect(refused.code).toBe(3);
    expect(errorOf(refused.reply).message).toContain("ships local-only");
  });
});
