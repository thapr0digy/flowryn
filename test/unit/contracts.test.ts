import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractPrefix, removeOwnWorktrees, type GitRun } from "../../src/contracts/cleanup.ts";
import { contractBody, contractEstimateSeconds, contractSteps, type ContractEnv, type ContractState, type ContractStep } from "../../src/contracts/suite.ts";
import { runContractSteps, scratchConfig, type ContractOptions } from "../../src/contracts/runner.ts";
import { pinDrift, pinHarness } from "../../src/contracts/pin.ts";
import type { FlowrynConfig } from "../../src/config/config.ts";
import { harnessVersion } from "../../src/lifecycle/fleet-services.ts";
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

/** A fake Claude native install: versions/<ver> files and a `claude` symlink the updater repoints. */
function fakeClaudeInstall(): { link: string; install(version: string): string; repoint(version: string): void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fw-pin-")));
  dirs.push(base);
  mkdirSync(join(base, "versions"));
  const link = join(base, "claude");
  const install = (version: string) => {
    const file = join(base, "versions", version);
    writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
    return file;
  };
  const repoint = (version: string) => {
    rmSync(link, { force: true });
    symlinkSync(join(base, "versions", version), link);
  };
  return { link, install, repoint };
}

describe("contract harness pin", () => {
  test("pins the versioned file behind the claude symlink, so an auto-update mid-run does not change the version under test", async () => {
    const claude = fakeClaudeInstall();
    const started = claude.install("2.1.291");
    claude.repoint("2.1.291");
    const pin = await pinHarness("claude", claude.link, harnessVersion);
    expect(pin).toEqual({ harness: "claude", binary: started, version: "2.1.291" });

    const options = { harness: "claude", config: { tools: { claude: claude.link }, extra: {} } as unknown as FlowrynConfig, herdrSocket: "/missing", model: null } as ContractOptions;
    expect(scratchConfig(options, pin, "/scratch", "flowryn/contract-x-")).toContain(`claude = ${JSON.stringify(started)}`);

    claude.install("2.1.292");
    claude.repoint("2.1.292");
    expect(await harnessVersion("claude", claude.link)).toBe("2.1.292");
    expect(await pinDrift(pin, harnessVersion)).toBeNull();
  });

  test("a pinned file replaced in place or removed mid-run fails fast with the reason", async () => {
    const claude = fakeClaudeInstall();
    const file = claude.install("2.1.291");
    claude.repoint("2.1.291");
    const pin = await pinHarness("claude", claude.link, harnessVersion);

    writeFileSync(file, `#!/bin/sh\necho "2.1.292 (Claude Code)"\n`, { mode: 0o755 });
    // The version cache keys on mtime; a same-millisecond rewrite must still read as a change.
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const updated = (await pinDrift(pin, harnessVersion))!;
    expect(updated).toBe("claude updated to 2.1.292 mid-run (the run started on 2.1.291); re-run flowryn doctor --contracts --harness claude");

    const ran: string[] = [];
    const results = await runContractSteps(
      [step("resume", async () => (ran.push("resume"), "resumed"))],
      {} as ContractEnv,
      state,
      () => undefined,
      () => pinDrift(pin, harnessVersion),
    );
    expect(ran).toEqual([]);
    expect(results.map((r) => [r.step, r.ok, r.detail])).toEqual([["resume", false, updated]]);

    unlinkSync(file);
    expect(await pinDrift(pin, harnessVersion)).toStartWith(`claude 2.1.291 at ${file} was removed`);
  });

  test("refuses a configured harness path that does not exist", async () => {
    await expect(pinHarness("pi", "/nonexistent/pi", harnessVersion)).rejects.toThrow("pi is configured at /nonexistent/pi, which does not exist");
  });
});
