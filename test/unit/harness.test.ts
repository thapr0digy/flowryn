import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/config.ts";
import { DEFAULT_TIMING, timingConfig, workerConfigProblems, workersConfig } from "../../src/config/workers.ts";
import { claudeAdapter, workerSettings } from "../../src/harness/claude/adapter.ts";
import { canonicalProject, checkOrRegisterTrust } from "../../src/harness/claude/trust.ts";
import { promptLine, steerLine, steerPointer, STYLE_BLOCK, workerContract } from "../../src/harness/contract-text.ts";
import { shipGitAccess } from "../../src/harness/git-access.ts";
import { loadExtensionSource, piAdapter } from "../../src/harness/pi/adapter.ts";
import type { RunContext } from "../../src/harness/types.ts";
import { MAX_TYPED_COMMAND, typedLength } from "../../src/lifecycle/launcher.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-hx-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeAll(async () => {
  await loadExtensionSource();
});

function git(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A primary checkout and one linked worktree of it. */
function repoWithWorktree(): { project: string; worktree: string; base: string } {
  const base = tempDir();
  const project = join(base, "repo");
  mkdirSync(project);
  git(project, ["init", "-q", "-b", "main"]);
  writeFileSync(join(project, "a.txt"), "a\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-q", "-m", "init"]);
  const worktree = join(base, "wt");
  git(project, ["worktree", "add", "-q", "-b", "flowryn/t1", worktree]);
  return { project, worktree, base };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "r01X",
    taskId: "scout-auth-k2",
    kind: "scout",
    worktree: "/w/scout-auth-k2",
    projectPath: "/p",
    runDir: "/state/runs/r01X",
    sessionId: "6f431b04-9b9c-47b1-866f-2ee3cfbc6746",
    instructionsFile: "/state/runs/r01X/task.md",
    contractFile: "/state/runs/r01X/contract.md",
    promptLine: "Flowryn scout scout-auth-k2. Full task: /state/runs/r01X/task.md (read it first). Scout auth",
    flowrynBin: "/opt/flowryn/bin/flowryn",
    binary: "/usr/local/bin/claude",
    daemonSocket: "/h/run/flowrynd.sock",
    writable: ["/h/data/spool/r01X", "/h/data/scout-auth-k2"],
    readOnly: [],
    ...overrides,
  };
}

const workers = workersConfig({ ...defaultConfig("/h"), extra: { workers: { claude: { model: "haiku", effort: "low" }, pi: { model: "flowryn-scripted/scripted", extensions: ["/x/scripted-provider.ts"], agent_dir: "/scratch/agent" } } } });

describe("claude adapter", () => {
  test("launch: preassigned session id, per-run settings, contract file, permission mode, one single-line prompt", () => {
    const plan = claudeAdapter.launch(context(), workers);
    expect(plan.kind).toBe("claude");
    expect(plan.args.slice(0, 2)).toEqual(["--session-id", context().sessionId]);
    expect(plan.args).toEqual(expect.arrayContaining(["--settings", "/state/runs/r01X/claude-settings.json", "--append-system-prompt-file", "/state/runs/r01X/contract.md", "--permission-mode", "bypassPermissions", "--model", "haiku", "--effort", "low"]));
    expect(plan.args.at(-1)).toBe(context().promptLine);
    // Herdr refuses control characters in agent arguments.
    expect(plan.args.every((a) => !/[\n\t\r]/.test(a))).toBe(true);
    expect(plan.files[0]!.path).toBe("/state/runs/r01X/claude-settings.json");
    // Claude's Bash sandbox, when the user runs it, must let the worker's CLI reach the daemon and its spool.
    expect(JSON.parse(plan.files[0]!.content).sandbox).toEqual({
      network: { allowUnixSockets: ["/h/run/flowrynd.sock"] },
      filesystem: { allowWrite: ["/h/data/spool/r01X", "/h/data/scout-auth-k2"], denyWrite: [] },
    });
  });

  test("resume: claude --resume <session> with a continue prompt", () => {
    const plan = claudeAdapter.resume(context(), workers);
    expect(plan.args.slice(0, 2)).toEqual(["--resume", context().sessionId]);
    expect(plan.args.at(-1)).toContain("Continue your task");
  });

  test("the worker settings wire every hook verb, and the Stop waiter is asyncRewake with an 8 h timeout", () => {
    const settings = workerSettings("/opt/flowryn bin/flowryn") as { hooks: Record<string, { hooks: { command: string; asyncRewake?: boolean; timeout?: number }[] }[]> };
    expect(Object.keys(settings.hooks).toSorted()).toEqual(["Notification", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
    // The usage-limit resume signals, and a permission dialog waiting mid-run (cutover C2): a worker's idle_prompt means nothing to Flowryn.
    expect((settings.hooks.Notification![0] as unknown as { matcher: string }).matcher).toBe("quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled|permission_prompt");
    const stop = settings.hooks.Stop![0]!.hooks;
    expect(stop[1]).toMatchObject({ asyncRewake: true, timeout: 28_800 });
    expect(stop[1]!.command).toBe("'/opt/flowryn bin/flowryn' hook wait-steer --harness claude");
  });

  test("the harness process is recognised by argv0, whatever its process title", () => {
    expect(claudeAdapter.matchesProcess({ pid: 1, name: "2.1.281", argv0: "claude", argv: [], cwd: "" }, "/usr/local/bin/claude")).toBe(true);
    expect(claudeAdapter.matchesProcess({ pid: 1, name: "date", argv0: "date", argv: [], cwd: "" }, "/usr/local/bin/claude")).toBe(false);
    expect(claudeAdapter.parseVersion("2.1.281 (Claude Code)")).toBe("2.1.281");
  });
});

describe("pi adapter", () => {
  test("launch: the Flowryn extension with -e, extra extensions, the contract as a file, one positional prompt", () => {
    const plan = piAdapter.launch(context({ binary: "/opt/homebrew/bin/pi-signed" }), workers);
    const args = plan.args;
    expect(plan.kind).toBe("pi");
    expect(args.slice(0, 2)).toEqual(["--session-id", context().sessionId]);
    expect(args[args.indexOf("-e") + 1]).toBe("/state/runs/r01X/flowryn-worker.ts");
    expect(args).toEqual(expect.arrayContaining(["-e", "/x/scripted-provider.ts", "--model", "flowryn-scripted/scripted", "--append-system-prompt", "/state/runs/r01X/contract.md"]));
    expect(args.at(-1)).toBe(context().promptLine);
    expect(args.at(-2)).toBe("@/state/runs/r01X/task.md");
    expect(plan.env.PI_CODING_AGENT_DIR).toBe("/scratch/agent");
    expect(plan.files[0]!.content).toContain("project_trust");
  });

  test("resume reopens the same session id (Pi creates or reopens it)", () => {
    const plan = piAdapter.resume(context(), workers);
    expect(plan.args.slice(0, 2)).toEqual(["--session-id", context().sessionId]);
    expect(plan.args.at(-1)).toContain("Continue your task");
  });

  test("the Pi Launcher build is recognised as pi-signed; the shim or a plain install as pi", () => {
    expect(piAdapter.matchesProcess({ pid: 1, name: "pi-launcher", argv0: "pi-signed", argv: [], cwd: "" }, "/opt/homebrew/bin/pi-signed")).toBe(true);
    expect(piAdapter.matchesProcess({ pid: 1, name: "pi", argv0: "pi", argv: [], cwd: "" }, "/opt/homebrew/bin/pi-signed")).toBe(true);
    expect(piAdapter.parseVersion("0.87.1\n")).toBe("0.87.1");
  });
});

describe("worker contract text", () => {
  test("names the mid-turn steer channel (M0 c07) and carries the style block when terse", () => {
    const text = workerContract("claude", STYLE_BLOCK);
    expect(text).toContain('arrive mid-turn as hook context starting "Flowryn steer [<id>]:"');
    expect(text).toContain("Reply in the fewest words");
    expect(workerContract("pi", null)).not.toContain("fewest words");
    // The style block leads the instructions (design section 11).
    expect(text.startsWith("Reply in the fewest words")).toBe(true);
    expect(text).toContain("$FLOWRYN_BIN stage done [--review <lavish url>]");
    expect(text.split("\n").length).toBeLessThan(30);
  });

  test("the worker contract forbids history rewrites and unguarded rm, and says what to do at a prompt", () => {
    const text = workerContract("claude", null, { kind: "ship", mode: "direct-PR", defaultBranch: "main" });
    expect(text).toContain("- Never rewrite history on a branch you have pushed: no commit --amend, rebase, push --force or --force-with-lease, reset --hard to an older commit.");
    expect(text).toContain("  To take main: new commits, git merge origin/main, a plain git push.");
    expect(text).toContain('- Never rm a path built from a variable that may be empty; use "${VAR:?}" or a mktemp -d directory.');
    expect(text).toContain("- A confirmation prompt appears: do not answer it; $FLOWRYN_BIN ask --blocking naming it, then end your turn.");
  });

  test("the prompt line is one short line that points at the full task", () => {
    expect(promptLine("scout", "t1", "/r/task.md")).toBe("Flowryn scout t1. Your full task is in /r/task.md; read it first, then do it.");
  });

  test("a launch command stays under what a starting pane shell keeps (M0 finding 11)", () => {
    const long = "/private/var/folders/p_/skk6jrk90q3bh6tsnwspgj_00000gn/T/fwc-yt6i9w/state/runs/r01M38QYEFGD085FDTE6YSKTPPT";
    const ctx = context({ runDir: long, instructionsFile: `${long}/task.md`, contractFile: `${long}/contract.md`, promptLine: promptLine("scout", "contract-pi-0-p2", `${long}/task.md`) });
    for (const plan of [piAdapter.launch(ctx, workers), claudeAdapter.launch(ctx, workers)]) expect(typedLength(plan.kind, plan.args)).toBeLessThan(MAX_TYPED_COMMAND);
    expect(typedLength("pi", ["x".repeat(2_000)])).toBeGreaterThan(MAX_TYPED_COMMAND);
  });

  test("a steer names its id and how to ack it; the waiter's pointer stands on its own", () => {
    expect(steerLine("m3", "use\nthe new API")).toBe("Flowryn steer [m3]: use the new API (when done: $FLOWRYN_BIN ack m3)");
    expect(steerPointer("m3")).toContain("$FLOWRYN_BIN inbox");
  });
});

describe("worker configuration", () => {
  test("defaults follow the design: bypass, register trust, the design's clock", () => {
    const config = workersConfig(defaultConfig("/h"));
    expect(config.claude.permission_mode).toBe("bypassPermissions");
    expect(config.claude.pretrust).toBe("register");
    expect(config.worktree_root).toBe("/h/data/worktrees");
    expect(timingConfig(defaultConfig("/h"))).toEqual(DEFAULT_TIMING);
  });

  test("bad values are config_invalid problems, not launch-time surprises", () => {
    const bad = { ...defaultConfig("/h"), extra: { workers: { claude: { permission_mode: "yolo" } }, reconcile: { pass_ms: -1, bogus: 3 } } };
    const problems = workerConfigProblems(bad);
    expect(problems.join(" ")).toContain("permission_mode must be one of");
    expect(problems.join(" ")).toContain("pass_ms must be a positive integer");
  });
});

describe("claude trust", () => {
  test("a linked worktree canonicalizes to its primary checkout; a primary checkout is refused", () => {
    const { project, worktree } = repoWithWorktree();
    expect(canonicalProject(worktree, project)).toEqual({ worktree, canonical: project });
    expect(() => canonicalProject(project, project)).toThrow("primary checkout");
  });

  test("check mode: trusted through the primary checkout with no write; untrusted is refused and nothing is written", async () => {
    const { project, worktree, base } = repoWithWorktree();
    const store = join(base, "store");
    mkdirSync(store);
    const untrusted = await checkOrRegisterTrust({ worktree, project, storeDir: store, mode: "check" });
    expect(untrusted).toMatchObject({ ok: false, wrote: false });
    expect(() => readFileSync(join(store, ".claude.json"))).toThrow();
    writeFileSync(join(store, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    expect(await checkOrRegisterTrust({ worktree, project, storeDir: store, mode: "check" })).toMatchObject({ ok: true, wrote: false });
  });

  test("register mode writes both entries, keeps every other key, and never grants import consent", async () => {
    const { project, worktree, base } = repoWithWorktree();
    const store = join(base, "store");
    mkdirSync(store);
    writeFileSync(join(store, ".claude.json"), JSON.stringify({ oauthAccount: { id: 1 }, projects: { "/other": { x: 1 } } }, null, 2));
    const result = await checkOrRegisterTrust({ worktree, project, storeDir: store, mode: "register" });
    expect(result).toMatchObject({ ok: true, wrote: true });
    const after = JSON.parse(readFileSync(join(store, ".claude.json"), "utf8"));
    expect(after.oauthAccount).toEqual({ id: 1 });
    expect(after.projects["/other"]).toEqual({ x: 1 });
    expect(after.projects[worktree]).toEqual({ hasTrustDialogAccepted: true });
    expect(after.projects[project]).toEqual({ hasTrustDialogAccepted: true });
  });

  test("a project that declined external CLAUDE.md imports is refused, not overridden", async () => {
    const { project, worktree, base } = repoWithWorktree();
    const store = join(base, "store");
    mkdirSync(store);
    writeFileSync(join(store, ".claude.json"), JSON.stringify({ projects: { [project]: { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } } }));
    const result = await checkOrRegisterTrust({ worktree, project, storeDir: store, mode: "register" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("declined external CLAUDE.md imports");
  });
});

describe("a ship worker's git access under Claude's Bash sandbox", () => {
  const gitRun = async (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { stdin: "ignore" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString() };
  };
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
  const canSandbox = process.platform === "darwin" && existsSync(SANDBOX_EXEC) && Bun.spawnSync([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"]).exitCode === 0;

  async function shipSandbox(worktree: string): Promise<{ allowWrite: string[]; denyWrite: string[] }> {
    const access = await shipGitAccess(gitRun, worktree);
    const settings = workerSettings("/opt/flowryn/bin/flowryn", { socket: "/h/run/flowrynd.sock", writable: ["/h/data/spool/r01X", ...access.writable], readOnly: access.readOnly }) as {
      sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } };
    };
    return settings.sandbox.filesystem;
  }

  const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

  test("the settings let a ship write what a commit needs, never the project's git hooks or config", async () => {
    const { project, worktree } = repoWithWorktree();
    const common = join(project, ".git");
    const fs = await shipSandbox(worktree);
    expect(fs.allowWrite).toEqual(expect.arrayContaining([join(common, "objects"), join(common, "refs"), join(common, "logs"), join(common, "packed-refs"), join(common, "worktrees", "wt")]));
    expect(fs.allowWrite).not.toContain(common);
    for (const denied of [join(common, "hooks"), join(common, "config")]) {
      expect(fs.denyWrite).toContain(denied);
      expect(fs.allowWrite.some((allowed) => within(denied, allowed))).toBe(false);
    }
  });

  test.skipIf(!canSandbox)("under that profile a worker commits and pushes from its linked worktree, and cannot touch the hooks or config", async () => {
    const { project, worktree, base } = repoWithWorktree();
    const origin = join(base, "origin.git");
    git(base, ["init", "-q", "--bare", origin]);
    git(project, ["remote", "add", "origin", origin]);
    const common = join(project, ".git");
    const fs = await shipSandbox(worktree);
    const quote = (p: string) => JSON.stringify(p);
    // Claude's sandbox lets the shell write its working directory; the bare origin stands in for the network remote.
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* (subpath "/dev") (subpath ${quote(worktree)}) (subpath ${quote(origin)}) ${fs.allowWrite.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
      `(deny file-write* ${fs.denyWrite.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
    ].join("\n");
    const sandboxed = (argv: string[]) => Bun.spawnSync([SANDBOX_EXEC, "-p", profile, ...argv], { cwd: worktree, stdin: "ignore", env: gitEnv });
    const config = readFileSync(join(common, "config"), "utf8");

    writeFileSync(join(worktree, "fix.txt"), "fixed\n");
    expect(sandboxed(["git", "add", "fix.txt"]).exitCode).toBe(0);
    const commit = sandboxed(["git", "commit", "-q", "-m", "fix"]);
    expect(commit.stderr.toString()).toBe("");
    expect(commit.exitCode).toBe(0);
    const push = sandboxed(["git", "push", "-q", "origin", "HEAD"]);
    expect(push.stderr.toString()).toBe("");
    expect(push.exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", origin, "log", "-1", "--format=%s", "flowryn/t1"]).stdout.toString().trim()).toBe("fix");

    expect(sandboxed(["/bin/sh", "-c", `echo 'echo owned' > ${quote(join(common, "hooks", "post-checkout"))}`]).exitCode).not.toBe(0);
    expect(existsSync(join(common, "hooks", "post-checkout"))).toBe(false);
    expect(sandboxed(["git", "config", "core.fsmonitor", "/tmp/owned"]).exitCode).not.toBe(0);
    expect(sandboxed(["git", "push", "-q", "-u", "origin", "HEAD"]).stderr.toString()).toContain("Operation not permitted");
    expect(readFileSync(join(common, "config"), "utf8")).toBe(config);
  });
});
