import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realTasksAxi, waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * M4 delivery against a fake GitHub (design section 17, the M4 exit's forge
 * cases): the named-head gate at deliver, the merge gate (green, red, a
 * waiver, pending checks, a head that moved, an unproven merge, a refused
 * merge, yolo and sensitive work), local-only merges into the primary
 * checkout, no-mistakes status, decline, and cleanup with and without a
 * discard approval. Every ship here ends cleaned or is shown not to.
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

const PR_STEPS = (api: string) => `FAKE: commit fix.txt fixed\nFAKE: push\nFAKE: pr ${api} acme/web\n`;

async function shipPr(e: ShipEnv, extra = "FAKE: deliver-pr\n"): Promise<{ task: string; run: string }> {
  return e.fleet.dispatch(`Fix the login loop\n${PR_STEPS(e.github.apiUrl)}${extra}FAKE: sleep 120000`, { kind: "ship" });
}

async function delivered(e: ShipEnv, run: string): Promise<void> {
  await e.fleet.waitRun(run, (r) => r.state === "ready", "the run ready");
}

function errorCode(reply: Record<string, unknown>): string {
  return (reply.error as { code?: string } | undefined)?.code ?? "";
}

function openItems(e: ShipEnv, kind: string): { id: string; line: string }[] {
  const db = e.fleet.h.db();
  try {
    return db.query("SELECT id, line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { id: string; line: string }[];
  } finally {
    db.close();
  }
}

async function taskState(e: ShipEnv, task: string): Promise<string> {
  const proc = Bun.spawnSync([realTasksAxi(), "show", task, "--file", e.fleet.h.backlog], { stdin: "ignore" });
  return /^\s*state:\s*(\S+)/m.exec(proc.stdout.toString())?.[1] ?? "?";
}

async function waitCleaned(e: ShipEnv, run: string, task: string): Promise<void> {
  const done = await e.fleet.waitRun(run, (r) => r.state === "cleaned", "cleaned", 30_000);
  expect(done.cleanup).toBe("done");
  expect(existsSync(done.worktree_path)).toBe(false);
  expect(git(e.fleet.repo, ["branch", "--list", done.branch])).toBe("");
  await waitUntil(async () => (await taskState(e, task)) === "done", 20_000, `${task} done in the backlog`);
}

describe("the named-head gate at deliver", () => {
  test(
    "green: verified, approved in your shell, merged, proven, cleaned, and done in the backlog",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task, run } = await shipPr(e);
      const [reply] = await e.replies(task, 1);
      expect(reply!.code).toBe(0);
      expect(reply!.reply.data).toMatchObject({ state: "ready", pr: "https://github.com/acme/web/pull/1" });
      await delivered(e, run);
      expect(openItems(e, "pr_ready")[0]!.line).toContain("PR ready: Fix the login loop (web), green");

      const refused = await e.fleet.json(["merge", task]);
      expect(refused.code).toBe(2);
      expect(errorCode(refused.reply)).toBe("approval_required");

      expect((await e.approve(task)).ok).toBe(true);
      const merged = await e.fleet.json(["merge", task]);
      expect(merged.code).toBe(0);
      expect(merged.reply.data).toMatchObject({ state: "merged", channel: "cli-tty" });
      await waitCleaned(e, run, task);
      expect(git(e.fleet.origin!, ["show", "main:fix.txt"])).toBe("fixed");
      expect(openItems(e, "pr_ready")).toHaveLength(0);
    },
    { timeout: 90_000 },
  );

  test(
    "head mismatch: a HEAD that is not the PR head is refused; after a push the same PR is accepted",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task, run } = await shipPr(e, "FAKE: commit later.txt local only\nFAKE: deliver-pr\nFAKE: push\nFAKE: deliver-pr\n");
      const [first, second] = await e.replies(task, 2);
      expect(first!.code).toBe(2);
      expect(errorCode(first!.reply)).toBe("head_mismatch");
      expect(second!.code).toBe(0);
      await delivered(e, run);
      expect(openItems(e, "divergence")).toHaveLength(0);
    },
    { timeout: 60_000 },
  );

  test(
    "a draft PR is refused and recorded as a divergence; a head that is not on the remote too",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task } = await e.fleet.dispatch(`Draft\nFAKE: commit fix.txt fixed\nFAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web draft\nFAKE: deliver-pr\nFAKE: sleep 120000`, { kind: "ship" });
      const [draft] = await e.replies(task, 1);
      expect(errorCode(draft!.reply)).toBe("pr_draft");
      await waitUntil(() => openItems(e, "divergence").some((i) => i.line.includes("draft")), 5_000, "a draft divergence");

      const second = await e.fleet.dispatch(`Gone\n${PR_STEPS(e.github.apiUrl)}FAKE: wait-file go\nFAKE: deliver-pr\nFAKE: sleep 120000`, { kind: "ship" });
      await waitUntil(() => existsSync(join(e.fleet.h.dataDir, second.task, "pr-url")), 20_000, "the second PR");
      const branch = e.fleet.run(second.run).branch;
      git(e.fleet.origin!, ["update-ref", "-d", `refs/heads/${branch}`]);
      writeFileSync(join(e.fleet.h.dataDir, second.task, "go"), "");
      const [gone] = await e.replies(second.task, 1);
      expect(errorCode(gone!.reply)).toBe("head_not_on_remote");
      expect(e.fleet.run(second.run).state).toBe("running");
      await waitUntil(() => openItems(e, "divergence").some((i) => i.line.includes("not the head")), 5_000, "a head divergence");
    },
    { timeout: 90_000 },
  );
});

describe("the merge gate", () => {
  test(
    "red: refused; one failing check waived in your shell merges; two cannot be waived",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [
        { name: "ci/test", state: "green" },
        { name: "lint", state: "red" },
      ];
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      await waitUntil(() => openItems(e, "checks_red").length === 1, 10_000, "a checks_red item");
      expect((await e.approve(task)).ok).toBe(true);
      const red = await e.fleet.json(["merge", task]);
      expect(red.code).toBe(2);
      expect(errorCode(red.reply)).toBe("red_checks");
      expect((red.reply.error as { help: string }).help).toContain("--allow-red lint");

      const wrongWaiver = await e.approve(task, { allowRed: "ci/test" });
      expect(errorCode(wrongWaiver as never)).toBe("bad_args");
      expect((await e.approve(task, { allowRed: "lint" })).ok).toBe(true);
      const waived = await e.fleet.json(["merge", task]);
      expect(waived.code).toBe(0);
      expect(waived.reply.data).toMatchObject({ state: "merged", waived: "lint" });
      await waitCleaned(e, run, task);

      e.github.repo("acme/web").defaultChecks = [
        { name: "lint", state: "red" },
        { name: "ci/test", state: "red" },
      ];
      const two = await shipPr(e);
      await delivered(e, two.run);
      const refused = await e.approve(two.task, { allowRed: "lint" });
      expect(errorCode(refused as never)).toBe("red_checks");
    },
    { timeout: 120_000 },
  );

  test(
    "pending checks refuse; a head pushed after delivery refuses the merge and is a divergence",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [{ name: "ci/test", state: "pending" }];
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      expect((await e.approve(task)).ok).toBe(true);
      const pending = await e.fleet.json(["merge", task]);
      expect(errorCode(pending.reply)).toBe("checks_pending");

      e.github.repo("acme/web").defaultChecks = [{ name: "ci/test", state: "green" }];
      const wt = e.fleet.run(run).worktree_path;
      writeFileSync(join(wt, "more.txt"), "more\n");
      git(wt, ["add", "more.txt"]);
      git(wt, ["commit", "-q", "-m", "more"]);
      git(wt, ["push", "-q", "origin", "HEAD"]);
      const moved = await e.fleet.json(["merge", task]);
      expect(moved.code).toBe(2);
      expect(errorCode(moved.reply)).toBe("head_moved");
      await waitUntil(() => openItems(e, "divergence").some((i) => i.line.includes("head moved")), 10_000, "a head-moved divergence");
      // The approval was for the old head; approving the new head needs a new delivery first.
      const again = await e.approve(task);
      expect(errorCode(again as never)).toBe("head_moved");
    },
    { timeout: 90_000 },
  );

  test(
    "unproven: GitHub accepts the merge but the PR does not read merged; the task is not landed until it does, then it is cleaned",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      e.github.repo("acme/web").mergeMode = "accept-unproven";
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      expect((await e.approve(task)).ok).toBe(true);
      const merge = await e.fleet.json(["merge", task]);
      expect(merge.code).toBe(2);
      expect(errorCode(merge.reply)).toBe("not_landed");
      const merging = e.fleet.run(run);
      expect(merging.state).toBe("merging");
      expect(existsSync(merging.worktree_path)).toBe(true);
      expect(openItems(e, "unproven_merge")).toHaveLength(1);
      await Bun.sleep(1_000);
      expect(e.fleet.run(run).state).toBe("merging");

      e.github.prove("acme/web", 1);
      await waitCleaned(e, run, task);
      expect(openItems(e, "unproven_merge")).toHaveLength(0);
    },
    { timeout: 90_000 },
  );

  test(
    "a merge GitHub refuses leaves the run ready, and the approval is used up",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      e.github.repo("acme/web").mergeMode = "refuse";
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      expect((await e.approve(task)).ok).toBe(true);
      const refused = await e.fleet.json(["merge", task]);
      expect(errorCode(refused.reply)).toBe("merge_refused");
      expect(e.fleet.run(run).state).toBe("ready");
      expect(errorCode((await e.fleet.json(["merge", task])).reply)).toBe("approval_required");
    },
    { timeout: 60_000 },
  );

  test(
    "a PR you merge on GitHub lands the task and it is cleaned; a PR closed unmerged is a P1",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      const head = e.github.pr("acme/web", 1).headSha;
      const response = await fetch(`${e.github.apiUrl}/repos/acme/web/pulls/1/merge`, { method: "PUT", body: JSON.stringify({ sha: head, merge_method: "squash" }) });
      expect(response.status).toBe(200);
      await waitCleaned(e, run, task);

      const second = await shipPr(e);
      await delivered(e, second.run);
      await fetch(`${e.github.apiUrl}/repos/acme/web/pulls/2`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      await waitUntil(() => openItems(e, "pr_closed").length === 1, 10_000, "a pr_closed item");
      expect(e.fleet.run(second.run).state).toBe("ready");
    },
    { timeout: 90_000 },
  );

  test(
    "yolo merges green work without a human record; sensitive work still needs one",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true });
      const e = env;
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      const merged = await e.fleet.json(["merge", task]);
      expect(merged.code).toBe(0);
      expect(merged.reply.data).toMatchObject({ channel: "yolo" });
      await waitCleaned(e, run, task);
      const db = e.fleet.h.db();
      expect((db.query("SELECT line FROM items WHERE kind = 'yolo_merged'").get() as { line: string }).line).toContain("Merged under yolo");
      db.close();

      const body = `Secret\n${PR_STEPS(e.github.apiUrl)}FAKE: deliver-pr\nFAKE: sleep 120000`;
      const sensitive = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--sensitive", "--body-file", "-"], { stdin: body });
      const s = sensitive.reply.data as { task: string; run: string };
      await delivered(e, s.run);
      expect(openItems(e, "sensitive_action_waiting")).toHaveLength(1);
      const refused = await e.fleet.json(["merge", s.task]);
      expect(errorCode(refused.reply)).toBe("approval_required");
      expect((refused.reply.error as { message: string }).message).toContain("sensitive");
      expect((await e.approve(s.task)).ok).toBe(true);
      expect((await e.fleet.json(["merge", s.task])).code).toBe(0);
    },
    { timeout: 120_000 },
  );
});

describe("no-mistakes, local-only, decline and cleanup", () => {
  test(
    "no-mistakes: an active pipeline run makes the run validating; the contract names the pipeline",
    async () => {
      env = await makeShipEnv({ mode: "no-mistakes" });
      const e = env;
      const { task, run } = await e.fleet.dispatch(`Pipeline\nFAKE: commit fix.txt fixed\nFAKE: wait-file go\n${`FAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\n`}FAKE: deliver-pr\nFAKE: sleep 120000`, { kind: "ship" });
      const started = await e.fleet.waitRun(run, (r) => r.worker_started_at !== null, "worker started");
      expect(readFileSync(join(e.fleet.h.stateDir, "runs", run, "contract.md"), "utf8")).toContain("Ship with no-mistakes");
      const statusFile = join(e.fleet.h.home, "nm-status");
      writeFileSync(statusFile, `run:\n  id: "01NM"\n  branch: ${started.branch}\n  status: running\n  head: "abc"\n  pr: ""\n`);
      await e.fleet.waitRun(run, (r) => r.state === "validating", "validating", 10_000);
      writeFileSync(statusFile, `run:\n  id: "01NM"\n  branch: ${started.branch}\n  status: completed\n  head: "abc"\n  pr: ""\noutcome: passed\n`);
      await e.fleet.waitRun(run, (r) => r.state === "running", "running again", 10_000);
      writeFileSync(join(e.fleet.h.dataDir, task, "go"), "");
      await delivered(e, run);
      expect((await e.approve(task)).ok).toBe(true);
      expect((await e.fleet.json(["merge", task])).code).toBe(0);
      await waitCleaned(e, run, task);
    },
    { timeout: 90_000 },
  );

  test(
    "local-only: delivered as a branch, fast-forwarded into the primary checkout's main, cleaned; a diverged main refuses",
    async () => {
      env = await makeShipEnv({ mode: "local-only" });
      const e = env;
      const { task, run } = await e.fleet.dispatch("Local fix\nFAKE: commit local.txt landed\nFAKE: deliver-local\nFAKE: sleep 120000", { kind: "ship" });
      const [reply] = await e.replies(task, 1);
      expect(reply!.code).toBe(0);
      expect(reply!.reply.data).toMatchObject({ state: "ready", commits: 1 });
      await delivered(e, run);
      expect(openItems(e, "pr_ready")[0]!.line).toContain("Branch ready to merge");
      expect(errorCode((await e.fleet.json(["merge", task])).reply)).toBe("approval_required");
      expect((await e.approve(task)).ok).toBe(true);
      const merged = await e.fleet.json(["merge", task]);
      expect(merged.code).toBe(0);
      await waitCleaned(e, run, task);
      expect(git(e.fleet.repo, ["show", "main:local.txt"])).toBe("landed");

      const second = await e.fleet.dispatch("Local two\nFAKE: commit two.txt two\nFAKE: deliver-local\nFAKE: sleep 120000", { kind: "ship" });
      await delivered(e, second.run);
      writeFileSync(join(e.fleet.repo, "main-moved.txt"), "moved\n");
      git(e.fleet.repo, ["add", "main-moved.txt"]);
      git(e.fleet.repo, ["commit", "-q", "-m", "main moved"]);
      expect((await e.approve(second.task)).ok).toBe(true);
      expect(errorCode((await e.fleet.json(["merge", second.task])).reply)).toBe("not_fast_forward");
    },
    { timeout: 90_000 },
  );

  test(
    "decline sends the worker your words and voids the approval",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task, run } = await shipPr(e);
      await delivered(e, run);
      expect((await e.approve(task)).ok).toBe(true);
      const declined = await e.fleet.json(["decline", task, "--body-file", "-"], { stdin: "Rename the flag." });
      expect(declined.code).toBe(0);
      expect(e.fleet.run(run).state).toBe("running");
      const db = e.fleet.h.db();
      const steer = db.query("SELECT body FROM messages WHERE run_id = ?1").get(run) as { body: string };
      const standing = db.query("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?1 AND consumed_at IS NULL").get(task) as { n: number };
      db.close();
      expect(steer.body).toContain("Rename the flag.");
      expect(standing.n).toBe(0);
    },
    { timeout: 60_000 },
  );

  test(
    "cleanup refuses unlanded work, and discards it only with your discard approval",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const { task, run } = await e.fleet.dispatch("Abandon\nFAKE: commit wip.txt work in progress\nFAKE: sleep 120000", { kind: "ship" });
      await e.fleet.waitRun(run, (r) => r.worker_started_at !== null, "worker started");
      await waitUntil(() => git(e.fleet.run(run).worktree_path, ["log", "--oneline", "-1"]).includes("wip.txt"), 10_000, "the commit");
      const early = await e.fleet.json(["cleanup", task]);
      expect(errorCode(early.reply)).toBe("not_ready");
      expect((await e.fleet.json(["cancel", task])).code).toBe(0);
      const refused = await e.fleet.json(["cleanup", task]);
      expect(refused.code).toBe(2);
      expect(errorCode(refused.reply)).toBe("cleanup_refused");
      expect(existsSync(e.fleet.run(run).worktree_path)).toBe(true);
      expect(errorCode((await e.fleet.json(["cleanup", task, "--discard"])).reply)).toBe("approval_required");
      expect((await e.approve(task, { discard: true })).ok).toBe(true);
      const discarded = await e.fleet.json(["cleanup", task, "--discard"]);
      expect(discarded.code).toBe(0);
      expect(discarded.reply.data).toMatchObject({ removed: true, reason: "discard_approved" });
      expect(existsSync(e.fleet.run(run).worktree_path)).toBe(false);
      expect(e.fleet.run(run).state).toBe("cancelled");
    },
    { timeout: 90_000 },
  );
});
