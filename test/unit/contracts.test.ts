import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractPrefix, removeOwnWorktrees, type GitRun } from "../../src/contracts/cleanup.ts";
import { contractBody, contractEstimateSeconds, contractSteps, type ContractEnv, type ContractState, type ContractStep } from "../../src/contracts/suite.ts";
import { removeScratchHome, runContractSteps, scratchConfig, type ContractOptions } from "../../src/contracts/runner.ts";
import { pinDrift, pinHarness } from "../../src/contracts/pin.ts";
import type { FlowrynConfig } from "../../src/config/config.ts";
import { harnessVersion } from "../../src/lifecycle/fleet-services.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import type { MessageRow } from "../../src/lifecycle/steers.ts";
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
  test("walks the design's list in order: launch, session, busy, both deliveries, an urgent cut, interrupt, (Claude) toolkit, exit, resume, deliver", () => {
    const pi = contractSteps("pi").map((s) => s.name);
    expect(contractSteps("claude").map((s) => s.name)).toEqual([...pi.slice(0, pi.indexOf("exit")), "toolkit", ...pi.slice(pi.indexOf("exit"))]);
    expect(pi).toEqual([
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
    // Pi's gate plays the scripted model, so only its real sleeps take time: quicker than Claude's live model.
    expect(contractEstimateSeconds("pi")).toBeGreaterThan(60);
    expect(contractEstimateSeconds("pi")).toBeLessThan(contractEstimateSeconds("claude"));
    const minutes = Math.round((contractEstimateSeconds("claude") + contractEstimateSeconds("pi")) / 60);
    expect(contractPlan(["claude", "pi"])).toStartWith(`contracts: claude, pi; 23 steps, about ${minutes} min`);
    expect(contractPlan([])).toBe("contracts: no harness installed to test");
  });
});

/**
 * A Pi worker behind a slow model, as the extension treats an urgent steer
 * (src/harness/pi/extension/flowryn-worker.ts): every steer is acknowledged at
 * once, and the long command starts `startMs` after the acknowledgement that
 * asked for it. An urgent steer that arrives while the command runs cuts it;
 * one that arrives before blocks the command's tool call and is read without
 * a cut, which is what the live suite met on a free model.
 */
function slowPiWorker(startMs: number): { env: ContractEnv; asked: string[] } {
  const steers: MessageRow[] = [];
  const asked: string[] = [];
  let commandAt = Number.POSITIVE_INFINITY;
  const running = () => Date.now() >= commandAt;
  const env: ContractEnv = {
    harness: "pi",
    scripted: false,
    claudeStore: null,
    async call(verb, args) {
      const now = Date.now();
      const id = `m${steers.length + 1}`;
      const urgent = args.urgent === true;
      steers.push({ id, created_at: now, carried_at: now, seen_at: now, acked_at: now, urgent: urgent ? 1 : 0, preempted_at: urgent && running() ? now : null } as MessageRow);
      if (!urgent) commandAt = now + startMs;
      return { ok: verb === "steer", data: { steer: id } };
    },
    run: () => ({ proc_pid: 1, proc_start: 1, proc_exe: "pi", liveness: "idle" }) as RunRow,
    events: () => [],
    steers: () => steers,
    lastHook: () => null,
    async waitFor(what, timeoutMs, check) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    },
    exitWorker: async () => ({ ok: true, detail: "" }),
    isAlive: async () => true,
    async commandRunning(command) {
      asked.push(command);
      return running();
    },
    log: () => {},
  };
  return { env, asked };
}

const urgentStep = contractSteps("pi").find((s) => s.name === "urgent while busy")!;

describe("contract urgent step on Pi", () => {
  test("sends the urgent steer only once the long command runs, however long the model takes to call it", async () => {
    // A fixed two seconds after the acknowledgement was the old wait; this model takes longer.
    const { env, asked } = slowPiWorker(2_500);
    const detail = await urgentStep.run(env, { ...state });
    expect(detail).toContain("cut a tool");
    expect(asked.at(-1)).toBe("perl -e sleep 60");
  }, 10_000);

  test("still fails a steer acknowledged without a cut", async () => {
    // The process check reads a command that is not the one the steer meets: the steer blocks a tool call instead.
    const { env } = slowPiWorker(60_000);
    const blocking: ContractEnv = { ...env, commandRunning: async () => true };
    await expect(urgentStep.run(blocking, { ...state })).rejects.toThrow("m2 was acknowledged without cutting the running tool");
  }, 10_000);
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

    // An updater replaces the file with a new one at the same path. Rewriting it in place instead would make
    // macOS SIGKILL its next exec (now and then), which reads as "cannot report its version", not an update.
    writeFileSync(`${file}.new`, `#!/bin/sh\necho "2.1.292 (Claude Code)"\n`, { mode: 0o755 });
    renameSync(`${file}.new`, file);
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

/** A scratch home with a spooled hook in it. */
function scratchHome(): string {
  const root = mkdtempSync(join(tmpdir(), "fwc-unit-"));
  dirs.push(root);
  mkdirSync(join(root, "data", "spool", "r1"), { recursive: true });
  writeFileSync(join(root, "data", "spool", "r1", "hook.json"), "{}");
  return root;
}

describe("removeScratchHome", () => {
  test("removes it again when a straggler recreates part of it just after", async () => {
    const root = scratchHome();
    // A worker's hook spooling after the daemon stopped: it lands once, inside the quiet spell.
    const straggler = setTimeout(() => mkdirSync(join(root, "data", "spool", "r1"), { recursive: true }), 50);
    const lines: string[] = [];
    expect(await removeScratchHome(root, (l) => lines.push(l))).toBe(true);
    clearTimeout(straggler);
    expect(existsSync(root)).toBe(false);
    expect(lines).toEqual([]);
  });

  test("says so, with the reason, when it keeps coming back past the deadline", async () => {
    const root = scratchHome();
    const straggler = setInterval(() => mkdirSync(join(root, "data"), { recursive: true }), 20);
    const lines: string[] = [];
    try {
      expect(await removeScratchHome(root, (l) => lines.push(l), 600)).toBe(false);
    } finally {
      clearInterval(straggler);
    }
    expect(lines).toEqual([`scratch home ${root} was not removed: something recreated it after removal`]);
  });
});
