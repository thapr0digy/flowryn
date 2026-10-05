import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractPrefix, removeOwnWorktrees, type GitRun } from "../../src/contracts/cleanup.ts";
import { contractBody, contractEstimateSeconds, contractSteps, type ContractEnv, type ContractState, type ContractStep } from "../../src/contracts/suite.ts";
import { runContractSteps } from "../../src/contracts/runner.ts";
import { contractPlan } from "../../src/cli/commands/setup.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git: GitRun = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};

function branches(repo: string): string[] {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], repo).out.split("\n").filter(Boolean).toSorted();
}

describe("contract cleanup", () => {
  test("removes only the worktrees and branches this run created, by exact name under its own prefix", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "fw-cc-")));
    dirs.push(base);
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "a"), "a\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "init"], repo);
    git(["branch", "fm/flowryn-m2"], repo);
    const { prefix } = contractPrefix();
    const other = contractPrefix().prefix;
    const root = join(base, "wt");
    const mine = join(root, "t1");
    const theirs = join(root, "t2");
    const outside = join(base, "elsewhere");
    git(["worktree", "add", "-q", "-b", `${prefix}t1`, mine], repo);
    git(["worktree", "add", "-q", "-b", `${other}t2`, theirs], repo);
    git(["worktree", "add", "-q", "-b", `${prefix}t3`, outside], repo);
    const logs: string[] = [];
    removeOwnWorktrees(
      repo,
      [
        { branch: `${prefix}t1`, worktree: mine },
        { branch: `${other}t2`, worktree: theirs },
        { branch: `${prefix}t3`, worktree: outside },
        { branch: "main", worktree: repo },
        { branch: "fm/flowryn-m2", worktree: mine },
        { branch: prefix, worktree: mine },
      ],
      prefix,
      root,
      git,
      (l) => logs.push(l),
    );
    expect(branches(repo)).toEqual([`${prefix}t3`, `${other}t2`, "fm/flowryn-m2", "main"].toSorted());
    const listed = git(["worktree", "list", "--porcelain"], repo).out;
    expect(listed).not.toContain(`worktree ${mine}\n`);
    expect(listed).toContain(`worktree ${theirs}`);
    expect(listed).toContain(`worktree ${outside}`);
    expect(logs.filter((l) => l.startsWith("left")).length).toBe(5);
  });

  test("refuses a prefix that is not a contract run's", () => {
    expect(() => removeOwnWorktrees("/nonexistent", [], "flowryn/", "/tmp", git, () => {})).toThrow("refusing");
  });
});

describe("contract suite", () => {
  test("walks the design's list in order: launch, session, busy, both deliveries, an urgent cut, interrupt, exit, resume, deliver", () => {
    expect(contractSteps("claude").map((s) => s.name)).toEqual([
      "launch",
      "session id",
      "busy",
      "deliver while busy",
      "idle",
      "deliver while idle",
      "urgent while busy",
      "interrupt",
      "exit",
      "resume",
      "deliver",
    ]);
  });

  test("the scripted Pi worker acknowledges every steer the suite sends, each long command's before it runs", () => {
    const script = contractBody("pi", true).split("FLOWRYN-SCRIPT: ")[1]!.split(" ;; ");
    const acks = script.filter((s) => s.startsWith("bash $FLOWRYN_BIN ack ")).map((s) => s.split(" ").at(-1));
    expect(acks).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(script.indexOf("bash $FLOWRYN_BIN ack m3")).toBe(script.indexOf("bash perl -e 'sleep 60'") - 1);
    expect(script.indexOf("bash $FLOWRYN_BIN ack m5")).toBe(script.indexOf("bash perl -e 'sleep 120'") - 1);
  });

  test("only the scripted Pi model gets a script; a real model gets plain instructions", () => {
    expect(contractBody("pi", true)).toContain("FLOWRYN-SCRIPT:");
    expect(contractBody("pi", false)).not.toContain("FLOWRYN-SCRIPT:");
    expect(contractBody("claude", false)).not.toContain("FLOWRYN-SCRIPT:");
  });
});

const step = (name: string, run: () => Promise<string>): ContractStep => ({ name, typicalSeconds: 3, run });
const state: ContractState = { task: "t", run: "r", session: "s", pid: 0 };

describe("contract progress", () => {
  test("logs step N/M as each step starts and ends, and stops at the first failure", async () => {
    const lines: string[] = [];
    const results = await runContractSteps(
      [
        step("launch", async () => "pane 1"),
        step("busy", async () => {
          throw new Error("timed out");
        }),
        step("idle", async () => "never runs"),
      ],
      {} as ContractEnv,
      state,
      (line) => lines.push(line),
    );
    expect(results.map((r) => [r.step, r.ok])).toEqual([
      ["launch", true],
      ["busy", false],
    ]);
    expect(lines).toEqual(["step 1/3 launch (usually ~3s)", "step 1/3 ok launch (0s): pane 1", "step 2/3 busy (usually ~3s)", "step 2/3 FAILED busy (0s): timed out"]);
  });

  test("the up-front plan names the harnesses, counts every step and estimates the time", () => {
    expect(contractEstimateSeconds("claude")).toBeGreaterThan(60);
    expect(contractEstimateSeconds("pi")).toBeGreaterThan(contractEstimateSeconds("claude"));
    const minutes = Math.round((contractEstimateSeconds("claude") + contractEstimateSeconds("pi")) / 60);
    expect(contractPlan(["claude", "pi"])).toStartWith(`contracts: claude, pi; 22 steps, about ${minutes} min`);
    expect(contractPlan([])).toBe("contracts: no harness installed to test");
  });
});
