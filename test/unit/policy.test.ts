import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken } from "../../src/api/auth.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { cleanupConfig, githubConfig } from "../../src/config/delivery.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { tokenSource } from "../../src/forge/github.ts";
import { summarize, type PullRequest } from "../../src/forge/types.ts";
import { gatedCommands } from "../../src/leader/hooks.ts";
import { ATTEMPT_WINDOW_MS, ChallengeStore, findAttempt, insertApproval, matchAttempt, recordAttempt, voidPendingAttempts } from "../../src/policy/approvals.ts";
import { runCleanup } from "../../src/policy/cleanup.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { checkGate, chooseApproval, type MergeFacts } from "../../src/policy/merge.ts";
import { isActive, ownParkedRun, parseNmStatus } from "../../src/policy/nomistakes.ts";
import type { RunWithPolicy } from "../../src/lifecycle/runs.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";

let dir = "";
let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function freshDb(): Db {
  dir = mkdtempSync(join(tmpdir(), "fw-policy-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  return db;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return error.code;
    throw error;
  }
  return "ok";
}

describe("the Claude PreToolUse gate finds the commands that need your word", () => {
  test("merges and discards, however the shell line is written", () => {
    expect(gatedCommands("flowryn merge web-fix-a1")).toEqual([{ action: "merge", task: "web-fix-a1" }]);
    expect(gatedCommands("cd /tmp && /Users/me/.flowryn/leader/bin/flowryn merge web-fix-a1 --json")).toEqual([{ action: "merge", task: "web-fix-a1" }]);
    expect(gatedCommands("echo x; flowryn  merge  t2")).toEqual([{ action: "merge", task: "t2" }]);
    expect(gatedCommands("flowryn cleanup web-fix-a1 --discard")).toEqual([{ action: "discard", task: "web-fix-a1" }]);
    expect(gatedCommands("flowryn cleanup web-fix-a1")).toEqual([]);
    expect(gatedCommands("flowryn show web-fix-a1 && flowryn fleet")).toEqual([]);
    expect(gatedCommands("git merge main")).toEqual([]);
  });

  test("a captain answer is gated; a leader answer is not", () => {
    expect(gatedCommands("flowryn decide k1 yes --by captain --body-file -")).toEqual([{ action: "decide", task: "k1" }]);
    expect(gatedCommands("flowryn decide k1 yes --rationale fine")).toEqual([]);
  });

  test("a captain answer is gated under every spelling the CLI parser accepts, never just the verbatim form", () => {
    expect(gatedCommands("flowryn decide k1 yes --by=captain")).toEqual([{ action: "decide", task: "k1" }]);
    expect(gatedCommands("flowryn decide --by captain k1 yes")).toEqual([{ action: "decide", task: "k1" }]);
    expect(gatedCommands("flowryn decide k1 yes --by 'captain'")).toEqual([{ action: "decide", task: "k1" }]);
    expect(gatedCommands("flowryn decide k1 yes --words 'a;b' --by captain")).toEqual([{ action: "decide", task: "k1" }]);
    expect(gatedCommands("flowryn decide k1 yes \\\n --by captain")).toEqual([{ action: "decide", task: "k1" }]);
    expect(gatedCommands("flowryn decide k1 yes --rationale fine")).toEqual([]);
  });

  test("more than one captain decide in one command is gated but refused by construction (no attempt is ever matchable)", () => {
    expect(gatedCommands("flowryn decide k1 yes --by captain; flowryn decide k2 no --by captain")).toEqual([{ action: "decide", task: "k1", tooMany: true }]);
  });
});

describe("approvals", () => {
  test("a /dev/tty challenge is single use, case-insensitive, and expires", () => {
    const store = new ChallengeStore();
    const base = { task: "t", action: "merge" as const, ref: "r", head: "h", allowRed: null, channel: "cli-tty" as const };
    const a = store.create(base, 1_000);
    expect(a.code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    expect(store.take(a.id, a.code.toLowerCase(), 2_000)).toMatchObject({ task: "t" });
    expect(store.take(a.id, a.code, 2_000)).toBe("unknown");
    const b = store.create(base, 1_000);
    expect(store.take(b.id, "ZZZZ" === b.code ? "YYYY" : "ZZZZ", 2_000)).toBe("wrong");
    expect(store.take(b.id, b.code, 2_000)).toBe("unknown");
    const c = store.create(base, 1_000);
    expect(store.take(c.id, c.code, 1_000 + 3 * 60_000)).toBe("expired");
  });

  test("a Claude attempt matches within five minutes, never under bypassPermissions, and a newer one supersedes it", () => {
    const d = freshDb();
    const now = 10_000_000;
    tx(d, () => recordAttempt(d, { session: "L1", toolUseId: "t1", action: "merge", task: "web-a1", permissionMode: "bypassPermissions", prUrl: null, head: null, now }));
    expect(findAttempt(d, { session: "L1", action: "merge", task: "web-a1", now })).toBeNull();
    tx(d, () => recordAttempt(d, { session: "L1", toolUseId: "t2", action: "merge", task: "web-a1", permissionMode: "auto", prUrl: null, head: "abc", now }));
    const found = findAttempt(d, { session: "L1", action: "merge", task: "web-a1", now: now + 1_000 });
    expect(found?.tool_use_id).toBe("t2");
    expect(findAttempt(d, { session: "L1", action: "merge", task: "web-a1", now: now + ATTEMPT_WINDOW_MS + 1 })).toBeNull();
    expect(findAttempt(d, { session: "L2", action: "merge", task: "web-a1", now })).toBeNull();
    expect(findAttempt(d, { session: "L1", action: "discard", task: "web-a1", now })).toBeNull();
    tx(d, () => recordAttempt(d, { session: "L1", toolUseId: "t3", action: "merge", task: "web-a1", permissionMode: "auto", prUrl: null, head: "def", now: now + 2_000 }));
    expect(findAttempt(d, { session: "L1", action: "merge", task: "web-a1", now: now + 3_000 })?.tool_use_id).toBe("t3");
  });

  test("voidPendingAttempts voids only that session's unmatched rows, leaving matched rows and other sessions alone", () => {
    const d = freshDb();
    const now = 20_000_000;
    tx(d, () => recordAttempt(d, { session: "L1", toolUseId: "t1", action: "decide", task: "k1", permissionMode: "auto", prUrl: null, head: null, now }));
    tx(d, () => recordAttempt(d, { session: "L1", toolUseId: "t2", action: "merge", task: "m1", permissionMode: "auto", prUrl: null, head: null, now }));
    tx(d, () => recordAttempt(d, { session: "L2", toolUseId: "t3", action: "decide", task: "k2", permissionMode: "auto", prUrl: null, head: null, now }));
    const matched = findAttempt(d, { session: "L1", action: "merge", task: "m1", now })!;
    tx(d, () => matchAttempt(d, matched.id, now));

    const voided = tx(d, () => voidPendingAttempts(d, "L1", now + 1));
    expect(voided).toBe(1); // only L1's still-unmatched decide attempt
    expect(findAttempt(d, { session: "L1", action: "decide", task: "k1", now: now + 2 })).toBeNull();
    const row = d.query("SELECT matched_at FROM approval_attempts WHERE id = ?1").get(matched.id) as { matched_at: number };
    expect(row.matched_at).toBe(now); // the already-matched L1 merge attempt is untouched, not voided
    expect(findAttempt(d, { session: "L2", action: "decide", task: "k2", now: now + 2 })?.tool_use_id).toBe("t3"); // L2 is untouched
    expect(tx(d, () => voidPendingAttempts(d, "L1", now + 3))).toBe(0); // nothing left to void
  });
});

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { number: 1, url: "https://github.com/acme/web/pull/1", title: "t", state: "open", draft: false, headSha: "h1", headRef: "flowryn/t", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, ...over };
}

function facts(over: Partial<MergeFacts> = {}, sensitive = 0): MergeFacts {
  const run = { id: "r1", task_id: "t", sensitive, branch: "flowryn/t", state: "ready" } as unknown as RunWithPolicy;
  const project = { id: "web", path: "/p", default_branch: "main" } as unknown as ProjectRow;
  return {
    run,
    project,
    delivered: { kind: "pr", ref: "https://github.com/acme/web/pull/1", head: "h1", at: 0 },
    ref: "https://github.com/acme/web/pull/1",
    head: "h1",
    title: "t",
    pr: pr(),
    checks: summarize([{ name: "ci", state: "green", detail: "success" }]),
    remote: "h1",
    primaryBranch: null,
    primaryDirty: false,
    fastForward: false,
    ...over,
  };
}

const row = (allowRed: string | null = null) => ({ kind: "row" as const, row: { id: "a1", allow_red_check: allowRed, channel: "cli-tty" } as never });
const yolo = { kind: "yolo" as const };
const parked = (branch: string, head: string) => `run:\n  id: "01RUN"\n  branch: ${branch}\n  status: awaiting_approval\n  awaiting_agent: parked 2m\n  head: "${head}"\n  pr: ""\ngate: review\n`;

describe("the merge gate, in the design's order", () => {
  test("green with an approval passes; each failing condition refuses with its code", () => {
    expect(checkGate(facts(), { choice: row(), why: "" })).toEqual({ waived: null, alreadyMerged: false });
    expect(code(() => checkGate(facts(), { choice: null, why: "none" }))).toBe("approval_required");
    expect(code(() => checkGate(facts({ pr: pr({ state: "closed" }) }), { choice: row(), why: "" }))).toBe("pr_closed");
    expect(checkGate(facts({ pr: pr({ state: "merged", mergeSha: "m" }) }), { choice: null, why: "" }).alreadyMerged).toBe(true);
    expect(code(() => checkGate(facts({ head: "h2", pr: pr({ headSha: "h2" }), remote: "h2" }), { choice: row(), why: "" }))).toBe("head_moved");
    expect(code(() => checkGate(facts({ pr: pr({ draft: true }) }), { choice: row(), why: "" }))).toBe("pr_draft");
    expect(code(() => checkGate(facts({ remote: "hX" }), { choice: row(), why: "" }))).toBe("head_not_on_remote");
    expect(code(() => checkGate(facts({ checks: summarize([{ name: "ci", state: "pending", detail: "in_progress" }]) }), { choice: row(), why: "" }))).toBe("checks_pending");
  });

  test("one red check is waived only by a human record naming it; two never", () => {
    const oneRed = summarize([
      { name: "ci", state: "green", detail: "success" },
      { name: "lint", state: "red", detail: "failure" },
    ]);
    expect(code(() => checkGate(facts({ checks: oneRed }), { choice: row(), why: "" }))).toBe("red_checks");
    expect(code(() => checkGate(facts({ checks: oneRed }), { choice: yolo, why: "" }))).toBe("red_checks");
    expect(code(() => checkGate(facts({ checks: oneRed }), { choice: row("ci"), why: "" }))).toBe("red_checks");
    expect(checkGate(facts({ checks: oneRed }), { choice: row("lint"), why: "" }).waived).toBe("lint");
    const twoRed = summarize([
      { name: "ci", state: "red", detail: "failure" },
      { name: "lint", state: "red", detail: "failure" },
    ]);
    expect(code(() => checkGate(facts({ checks: twoRed }), { choice: row("lint"), why: "" }))).toBe("red_checks");
  });

  test("sensitive work needs a human record even under yolo", () => {
    expect(code(() => checkGate(facts({}, 1), { choice: yolo, why: "" }))).toBe("approval_required");
    expect(checkGate(facts({}, 1), { choice: row(), why: "" }).waived).toBeNull();
  });

  test("local-only: the primary checkout must be on its default branch, clean, and a fast-forward", () => {
    const local = { delivered: { kind: "local" as const, ref: "flowryn/t", head: "h1", at: 0 }, ref: "local:flowryn/t", pr: null, checks: null, remote: null };
    expect(code(() => checkGate(facts({ ...local, primaryBranch: "dev", fastForward: true }), { choice: row(), why: "" }))).toBe("primary_checkout_tangle");
    expect(code(() => checkGate(facts({ ...local, primaryBranch: "main", primaryDirty: true, fastForward: true }), { choice: row(), why: "" }))).toBe("primary_checkout_tangle");
    expect(code(() => checkGate(facts({ ...local, primaryBranch: "main", fastForward: false }), { choice: row(), why: "" }))).toBe("not_fast_forward");
    expect(checkGate(facts({ ...local, primaryBranch: "main", fastForward: true }), { choice: row(), why: "" }).alreadyMerged).toBe(false);
  });

  test("approval precedence: your standing record, then the harness channel, then yolo; a record for another head does not count", () => {
    const d = freshDb();
    const now = 5_000_000;
    tx(d, () => {
      d.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', 'x', '/p', 'main', 'direct-PR', 1)").run();
      d.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t', 'web', 'ship', 'direct-PR', 1, 'fix', 0)").run();
      d.query("INSERT INTO leader_sessions (session_id, harness, token_hash) VALUES ('L1', 'pi', 'x')").run();
      d.query("INSERT INTO leader_lease (id, session_id, harness, epoch, token_hash, approval_key_hash) VALUES (1, 'L1', 'pi', 1, 'x', ?1)").run(hashToken("k1"));
    });
    const leader = { role: "leader" as const, runId: null, taskId: null, session: "L1" };
    expect(chooseApproval(d, facts(), { caller: leader }, "merge", now).choice?.kind).toBe("yolo");
    expect(chooseApproval(d, facts(), { caller: leader, approvalKey: "k1", head: "h1" }, "merge", now).choice?.kind).toBe("key");
    const moved = chooseApproval(d, facts(), { caller: leader, approvalKey: "k1", head: "h0" }, "merge", now);
    expect(moved.choice).toBeNull();
    expect(moved.why).toContain("head moved");
    tx(d, () => d.query("UPDATE task_policy SET yolo = 0").run());
    expect(chooseApproval(d, facts(), { caller: leader, approvalKey: "nope" }, "merge", now).why).toContain("not this lease's");
    tx(d, () => insertApproval(d, { task: "t", ref: facts().ref, head: "h0", channel: "board", actor: "me", action: "merge", now }));
    expect(chooseApproval(d, facts(), { caller: leader }, "merge", now).why).toContain("was for head h0");
    tx(d, () => insertApproval(d, { task: "t", ref: facts().ref, head: "h1", channel: "cli-tty", actor: "me", action: "merge", now }));
    expect(chooseApproval(d, facts(), { caller: leader, approvalKey: "k1", head: "h1" }, "merge", now).choice?.kind).toBe("row");
  });
});

describe("no-mistakes status (read-only)", () => {
  test("parses a run and tells active from finished", () => {
    const run = parseNmStatus(parked("fm/x", "abc"))!;
    expect(run).toMatchObject({ id: "01RUN", branch: "fm/x", status: "awaiting_approval", head: "abc", outcome: "", gate: true, awaiting: true });
    expect(isActive(run)).toBe(true);
    const done = parseNmStatus('run:\n  id: "01M"\n  branch: fm/x\n  status: completed\n  head: "43255230"\nsteps[1]{step,status,findings,duration_ms}:\n  ci,completed,0,1\noutcome: passed\n')!;
    expect(done.status).toBe("completed");
    expect(done.outcome).toBe("passed");
    expect(isActive(done)).toBe(false);
    expect(parseNmStatus("")).toBeNull();
  });

  test("a parked run is the worktree's own only on its branch at its HEAD or a descendant", async () => {
    dir = mkdtempSync(join(tmpdir(), "fw-nm-"));
    const git = gitRunner(Bun.which("git") ?? "git");
    const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, ...env } }).stdout.toString().trim();
    g(["init", "-q", "-b", "fm/x"]);
    writeFileSync(join(dir, "a"), "a\n");
    g(["add", "a"]);
    g(["commit", "-q", "-m", "a"]);
    const head = g(["rev-parse", "HEAD"]);
    const child = g(["commit-tree", `${head}^{tree}`, "-p", head, "-m", "fix round"]);
    expect(await ownParkedRun(git, dir, parseNmStatus(parked("fm/x", head)))).toBe(true);
    expect(await ownParkedRun(git, dir, parseNmStatus(parked("fm/x", child.slice(0, 8))))).toBe(true);
    expect(await ownParkedRun(git, dir, parseNmStatus(parked("fm/other", head)))).toBe(false);
    expect(await ownParkedRun(git, dir, parseNmStatus(parked("fm/x", "deadbeef")))).toBe(false);
    expect(await ownParkedRun(git, dir, parseNmStatus(parked("fm/x", head).replace("awaiting_approval", "running").replace(/awaiting_agent.*\n/, "").replace("gate: review\n", "")))).toBe(false);
  });
});

describe("the cleanup procedure", () => {
  test("a step that cannot run refuses with guard_error and leaves the worktree", async () => {
    dir = mkdtempSync(join(tmpdir(), "fw-cleanup-"));
    const logged: string[] = [];
    const outcome = await runCleanup(
      { guard: { mode: "local-only", kind: "ship", worktree: dir, branch: "fm/x", defaultBranch: "main", repo: null, recordedPrUrl: null, discardApproved: false }, primary: dir },
      {
        git: async () => {
          throw new Error("posix_spawn EPERM");
        },
        forge: null,
        webUrl: "https://github.com",
        lsof: null,
        noMistakes: null,
        ps: async () => "",
        config: cleanupConfig(parseConfig('data_dir = "/tmp/d"\nstate_dir = "/tmp/s"\n', "/tmp/h")),
        log: (line) => logged.push(line),
      },
    );
    expect(outcome).toMatchObject({ outcome: "refused", reason: "guard_error", branchDeleted: false });
    expect(outcome.detail).toContain("posix_spawn EPERM");
    expect(outcome.detail).toContain("the worktree is kept");
    expect(logged.join("\n")).toContain("posix_spawn EPERM");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("a cleanup whose worktree is already gone", () => {
  const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (cwd: string, args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, ...env } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };

  /** A primary checkout on main, and a run branch with one commit whose worktree someone deleted by hand. */
  function abandonedBranch(): { primary: string; worktree: string; tip: string } {
    dir = mkdtempSync(join(tmpdir(), "fw-absent-"));
    const primary = join(dir, "repo");
    g(dir, ["init", "-q", "-b", "main", primary]);
    writeFileSync(join(primary, "a.txt"), "a\n");
    g(primary, ["add", "."]);
    g(primary, ["commit", "-q", "-m", "init"]);
    const worktree = join(dir, "wt");
    g(primary, ["worktree", "add", "-q", "-b", "fm/x", worktree]);
    writeFileSync(join(worktree, "work.txt"), "only copy\n");
    g(worktree, ["add", "."]);
    g(worktree, ["commit", "-q", "-m", "work"]);
    const tip = g(worktree, ["rev-parse", "HEAD"]);
    rmSync(worktree, { recursive: true, force: true });
    return { primary, worktree, tip };
  }

  function cleanup(primary: string, worktree: string, discardApproved: boolean) {
    return runCleanup(
      { guard: { mode: "local-only", kind: "ship", worktree, branch: "fm/x", defaultBranch: "main", repo: null, recordedPrUrl: null, discardApproved }, primary },
      {
        git: gitRunner(Bun.which("git") ?? "git"),
        forge: null,
        webUrl: "https://github.com",
        lsof: null,
        noMistakes: null,
        ps: async () => "",
        config: cleanupConfig(parseConfig('data_dir = "/tmp/d"\nstate_dir = "/tmp/s"\n', "/tmp/h")),
        log: () => {},
      },
    );
  }

  const branchTip = (primary: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/heads/fm/x"], { cwd: primary }).stdout.toString().trim();

  test("the branch holding unlanded work is judged itself, refused, and kept", async () => {
    const { primary, worktree, tip } = abandonedBranch();
    const outcome = await cleanup(primary, worktree, false);
    expect(outcome).toMatchObject({ outcome: "refused", reason: "unpushed", branchDeleted: false });
    expect(outcome.detail).toContain("fm/x");
    expect(branchTip(primary)).toBe(tip);
  });

  test("a branch whose work is landed goes, and a gone branch has nothing to lose", async () => {
    const { primary, worktree } = abandonedBranch();
    g(primary, ["merge", "-q", "--ff-only", "fm/x"]);
    expect(await cleanup(primary, worktree, false)).toMatchObject({ outcome: "removed", reason: "merged_to_local_default", branchDeleted: true });
    expect(branchTip(primary)).toBe("");
    expect(await cleanup(primary, worktree, false)).toMatchObject({ outcome: "removed", reason: "worktree_absent", branchDeleted: false });
  });

  test("with a human discard approval the unlanded branch goes, and its tip is reported for recovery", async () => {
    const { primary, worktree, tip } = abandonedBranch();
    expect(await cleanup(primary, worktree, true)).toMatchObject({ outcome: "removed", reason: "discard_approved", branchDeleted: true, discardedHead: tip });
    expect(branchTip(primary)).toBe("");
  });
});

describe("M4 config", () => {
  test("[github] and [cleanup] have the design's defaults and refuse nonsense", () => {
    const base = "data_dir = \"/tmp/d\"\nstate_dir = \"/tmp/s\"\n";
    const config = parseConfig(`${base}[github]\napi_url = "http://127.0.0.1:5000/"\nmerge_method = "merge"\n[cleanup]\nlock_age_ms = 5\n`, "/tmp/h");
    expect(githubConfig(config)).toMatchObject({ api_url: "http://127.0.0.1:5000", web_url: "https://github.com", merge_method: "merge", poll_ms: 60_000 });
    expect(cleanupConfig(config)).toMatchObject({ lock_age_ms: 5, lock_retries: 3, reap_passes: 3 });
    expect(() => githubConfig(parseConfig(`${base}[github]\nmerge_method = "yolo"\n`, "/tmp/h"))).toThrow("merge_method");
    expect(() => githubConfig(parseConfig(`${base}[github]\npoll = 1\n`, "/tmp/h"))).toThrow("not a known setting");
    expect(() => cleanupConfig(parseConfig(`${base}[cleanup]\nreap_passes = 0\n`, "/tmp/h"))).toThrow("positive integer");
  });

  test("a token goes only to GitHub's own API, never to another api_url", async () => {
    const env = { GH_TOKEN: "secret" };
    expect(await tokenSource(env, ["GH_TOKEN"], null, "https://api.github.com", "https://github.com")()).toBe("secret");
    expect(await tokenSource(env, ["GH_TOKEN"], null, "https://ghe.example.com/api/v3", "https://ghe.example.com")()).toBe("secret");
    expect(await tokenSource(env, ["GH_TOKEN"], null, "http://127.0.0.1:4000", "https://github.com")()).toBeNull();
    expect(await tokenSource({}, ["GH_TOKEN"], null, "https://api.github.com", "https://github.com")()).toBeNull();
  });
});
