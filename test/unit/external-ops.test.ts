import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProc } from "../../src/daemon/restart.ts";
import { GitHubForge, tokenSource } from "../../src/forge/github.ts";
import { ForgeError } from "../../src/forge/types.ts";
import { processRunner } from "../../src/journal/tasks-axi.ts";
import { gitLabel, gitRunner } from "../../src/policy/git.ts";
import { concludeParkedRun, readNmStatus } from "../../src/policy/nomistakes.ts";
import { listLabelled } from "../../src/reconcile/docker.ts";
import { DEFAULT_DRAIN_MS, DEFAULT_GRACE_MS, TIMED_OUT, configureOwnedProcesses } from "../../src/runtime/bounded.ts";
import { probeQuota } from "../../src/sched/quota.ts";
import { runStep } from "../../src/upkeep/build.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { dockerScript } from "../helpers/fleet-env.ts";
import { FAKE_NO_MISTAKES } from "../helpers/harness.ts";

/**
 * Each long-lived external operation the daemon runs, with a peer that
 * never answers (docs/notes/2026-10-13-next-steps-md-xm.md): it fails within
 * its budget, the descendants it started are gone, its ledger entry is
 * settled, and an unrelated process and worktree are untouched.
 */

const TIMEOUT_MS = 300;
/** Deadline, grace, drain, the group's confirmation and scheduling slack. */
const BUDGET_MS = TIMEOUT_MS + DEFAULT_GRACE_MS + DEFAULT_DRAIN_MS + 1_000 + 1_000;

let dir = "";
let ledger = "";
let other = 0;
const strays: number[] = [];
const savedHome = process.env.FLOWRYN_HOME;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

function pidIn(path: string): number {
  const pid = Number(readFileSync(path, "utf8").trim());
  strays.push(pid);
  return pid;
}

/** A tool that never answers: a sleeper holding its stdout (pid in `<name>.pid`), waited on. */
function silentTool(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nsleep 600 &\necho $! > ${JSON.stringify(join(dir, `${name}.pid`))}\nwait\n`);
  chmodSync(path, 0o755);
  return path;
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const began = Date.now();
  const value = await work();
  return { value, ms: Date.now() - began };
}

/** The checks every case ends with: the descendant gone, nothing left in the ledger, the unrelated process alive. */
async function settled(sleeperPidFile: string): Promise<void> {
  expect(await gone(pidIn(sleeperPidFile))).toBe(true);
  expect(readdirSync(ledger)).toEqual([]);
  expect(alive(other)).toBe(true);
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with one commit and an unrelated worktree beside it. */
function repoWithWorktree(): { repo: string; unrelated: string } {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const unrelated = join(dir, "unrelated-wt");
  git(repo, ["worktree", "add", "-q", "-b", "unrelated", unrelated]);
  return { repo, unrelated };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-ext-"));
  ledger = join(dir, "owned");
  mkdirSync(ledger);
  // The daemon's mode: every child its own group, recorded in the ledger.
  configureOwnedProcesses({ dir: ledger, log: () => undefined });
  const proc = Bun.spawn(["/bin/sleep", "60"], { detached: true, stdout: "ignore", stderr: "ignore" });
  other = proc.pid;
  strays.push(other);
});

afterEach(() => {
  configureOwnedProcesses(null);
  if (savedHome === undefined) delete process.env.FLOWRYN_HOME;
  else process.env.FLOWRYN_HOME = savedHome;
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function silentNoMistakes(): string {
  const path = join(dir, "no-mistakes");
  writeFileSync(path, FAKE_NO_MISTAKES);
  chmodSync(path, 0o755);
  process.env.FLOWRYN_HOME = dir;
  writeFileSync(join(dir, "nm-silent"), "");
  return path;
}

describe("no-mistakes (the extended fake, silent)", () => {
  test("axi status fails within its budget (a failed read, never a status) and its forked helper is gone", async () => {
    const nm = silentNoMistakes();
    const { value, ms } = await timed(() => readNmStatus(nm, dir, TIMEOUT_MS));
    expect(value.code).toBe(TIMED_OUT);
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "nm-silent.pid"));
  });

  test("cleanup's parked-run check does not hang on it", async () => {
    const nm = silentNoMistakes();
    const { value, ms } = await timed(() => concludeParkedRun({ noMistakes: nm, git: gitRunner("git"), timeoutMs: TIMEOUT_MS, log: () => undefined }, dir));
    expect(value).toEqual({ ok: true, aborted: null });
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "nm-silent.pid"));
  });
});

describe("docker ps (the extended fake, silent)", () => {
  test("is Docker unknown (null) within its budget, never an empty list", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const docker = dockerScript(bin, dir);
    writeFileSync(join(dir, "docker-silent"), "");
    const { value, ms } = await timed(() => listLabelled(docker, TIMEOUT_MS));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "docker-silent.pid"));
  });

  test("a docker that answers and exits 0 while a helper it started holds its output, and floods stderr, still lists the containers", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const docker = dockerScript(bin, dir);
    writeFileSync(join(dir, "docker-helper"), "");
    writeFileSync(join(dir, "docker-ps.txt"), "c1\tweb-1\tr01\tproj\n");
    const { value, ms } = await timed(() => listLabelled(docker, 5_000));
    expect(value).toEqual([{ id: "c1", name: "web-1", run: "r01", project: "proj" }]);
    expect(ms).toBeLessThan(DEFAULT_DRAIN_MS + 2_000);
    // A normal exit is left alone: the helper still runs.
    expect(alive(pidIn(join(dir, "docker-helper.pid")))).toBe(true);
  });
});

describe("git (gitRunner and runTool)", () => {
  test("the label names the subcommand past git's global options and their values", () => {
    expect(gitLabel(["-C", "/some/worktree", "rev-parse", "HEAD"])).toBe("git rev-parse");
    expect(gitLabel(["-c", "core.sshCommand=ssh -v", "fetch", "origin"])).toBe("git fetch");
    expect(gitLabel(["--git-dir", "/r/.git", "--work-tree", "/r", "--no-pager", "worktree", "list"])).toBe("git worktree");
    expect(gitLabel(["--git-dir=/r/.git", "status"])).toBe("git status");
    expect(gitLabel(["-C", "/r"])).toBe("git");
  });

  test("a fetch over a silent ssh is cut off within its budget; ssh is gone, the refs and an unrelated worktree untouched", async () => {
    const { repo, unrelated } = repoWithWorktree();
    git(repo, ["remote", "add", "origin", "ssh://silent.invalid/r.git"]);
    const before = git(repo, ["for-each-ref"]);
    const ssh = silentTool("ssh");
    const { value, ms } = await timed(() => gitRunner("git", TIMEOUT_MS)(["-c", `core.sshCommand=${ssh}`, "fetch", "origin"], repo));
    expect(value.code).toBe(TIMED_OUT);
    expect(value.stderr).toContain("git fetch did not finish");
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "ssh.pid"));
    expect(git(repo, ["for-each-ref"])).toBe(before);
    expect(existsSync(join(unrelated, "a.txt"))).toBe(true);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(unrelated);
  });

  test("a worktree add whose hook hangs is cut off; the hook is gone and the new worktree is either absent or complete, never locked", async () => {
    const { repo, unrelated } = repoWithWorktree();
    const hooks = join(dir, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nsleep 600 &\necho $! > ${JSON.stringify(join(dir, "hook.pid"))}\nwait\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    const target = join(dir, "run-wt");
    const { value, ms } = await timed(() => gitRunner("git", TIMEOUT_MS)(["-c", `core.hooksPath=${hooks}`, "worktree", "add", "-b", "flowryn/run", target], repo));
    expect(value.code).toBe(TIMED_OUT);
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "hook.pid"));
    const admin = join(repo, ".git", "worktrees");
    const locked = existsSync(admin) ? readdirSync(admin).filter((name) => existsSync(join(admin, name, "locked"))) : [];
    expect(locked).toEqual([]);
    if (existsSync(target)) expect(git(target, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("flowryn/run");
    expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(unrelated);
  });
});

describe("the axi tools and the other helpers, silent", () => {
  test("tasks-axi times out within its budget (a transient failure)", async () => {
    const tool = silentTool("tasks-axi");
    const { value, ms } = await timed(() => processRunner(tool, null).run(["list"], TIMEOUT_MS));
    expect(value.timedOut).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "tasks-axi.pid"));
  });

  test("quota-axi reads unknown within its budget", async () => {
    const tool = silentTool("quota-axi");
    const { value, ms } = await timed(() => probeQuota(tool, null, TIMEOUT_MS));
    expect(value).toEqual({ state: "unknown", detail: "quota-axi took over 0.3 s" });
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "quota-axi.pid"));
  });

  test("gh auth token gives no token within its budget", async () => {
    const gh = silentTool("gh");
    const token = tokenSource({}, [], gh, "https://api.github.com", "https://github.com", TIMEOUT_MS);
    const { value, ms } = await timed(() => token());
    expect(value).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "gh.pid"));
  });

  test("gh auth token with a flooded stderr held open by a process it started still gives the token", async () => {
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!/bin/sh\nsleep 600 >/dev/null &\necho $! > ${JSON.stringify(join(dir, "gh.pid"))}\nhead -c 20000000 /dev/zero >&2\necho tok-123\n`);
    chmodSync(gh, 0o755);
    const token = tokenSource({}, [], gh, "https://api.github.com", "https://github.com", 5_000);
    expect(await token()).toBe("tok-123");
    expect(alive(pidIn(join(dir, "gh.pid")))).toBe(true);
  });

  test("the restart's smoke and launchd reads (runProc) time out within their budget", async () => {
    const tool = silentTool("smoke");
    const { value, ms } = await timed(() => runProc([tool], process.env, TIMEOUT_MS));
    expect(value.timedOut).toBe(true);
    expect(value.exitCode).toBe(TIMED_OUT);
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "smoke.pid"));
  });

  test("an upkeep build step whose compiler hangs is stopped with everything it started; its log says what ran", async () => {
    const script = silentTool("build.sh");
    const logPath = join(dir, "build.log");
    const { value, ms } = await timed(() => runStep(["/bin/sh", script], { cwd: dir, env: process.env, logPath, timeoutMs: TIMEOUT_MS }));
    expect(value.timedOut).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
    await settled(join(dir, "build.sh.pid"));
    expect(readFileSync(logPath, "utf8")).toContain(`$ /bin/sh ${script}`);
  });
});

describe("the forge (the extended fake, stalled)", () => {
  let fake: FakeGitHub;
  beforeEach(async () => {
    fake = await FakeGitHub.start();
    fake.addRepo("acme", "web");
  });
  afterEach(async () => {
    await fake.stop();
  });

  for (const stall of ["headers", "body"] as const) {
    test(`a forge that stalls its ${stall} fails within timeout_ms as a ForgeError, never a raw abort`, async () => {
      fake.stall = stall;
      const forge = new GitHubForge({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, token: async () => "t0ken", timeoutMs: TIMEOUT_MS });
      const began = Date.now();
      const error = await forge.pull({ owner: "acme", repo: "web", number: 1 }).catch((e: unknown) => e);
      expect(Date.now() - began).toBeLessThan(TIMEOUT_MS + 1_000);
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).kind).toBe("unreachable");
    });
  }
});
