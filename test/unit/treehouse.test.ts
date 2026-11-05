/**
 * Flowryn's treehouse calls (src/runtime/treehouse.ts) and the cleanup's
 * return path (src/policy/cleanup.ts), against the test homes' stand-in
 * treehouse (test/helpers/fake-treehouse.ts) and real git. treehouse 3.1.8's
 * real behaviour was checked by hand in a scratch repository, not by this
 * suite (`bun test` never runs the real treehouse); the "stand-in fidelity"
 * tests only keep the stand-in faithful to what was seen there, so the tests
 * built on it rest on the same behaviour.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupConfig } from "../../src/config/delivery.ts";
import { parseConfig } from "../../src/config/config.ts";
import { runCleanup } from "../../src/policy/cleanup.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { acquireSlot, adoptSlot, leaseHolder, parseLease, parseStatus, poolRoot, poolSlots, poolStatus, returnSlot, treehouseVersion } from "../../src/runtime/treehouse.ts";
import { worktreeChecks, VERIFIED_TREEHOUSE } from "../../src/doctor/doctor.ts";
import { GIT_ENV, sh } from "../helpers/scratch-git.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface Scratch {
  repo: string;
  root: string;
  bin: string;
}

function scratch(): Scratch {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-th-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "*.cache\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "one"]);
  const bin = join(dir, "treehouse");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "helpers", "fake-treehouse.ts"))} "$@"\n`);
  chmodSync(bin, 0o755);
  const root = poolRoot(join(dir, "wt"), "web");
  mkdirSync(root, { recursive: true });
  return { repo, root, bin };
}

const git = (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, ...GIT_ENV } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};

async function leased(s: Scratch, holder = leaseHolder("r1")) {
  const got = await acquireSlot(s.bin, s.root, s.repo, holder);
  if (!got.ok) throw new Error(got.detail);
  return got.value;
}

describe("treehouse's output", () => {
  test("a lease is the object get --lease --json prints; anything else is no lease", () => {
    const line = '{"path":"/p/.pool/.treehouse/repo-1/1/repo-1","lease_id":"72250bae","lease_holder":"flowryn:r1","leased_at":"2026-11-04T17:05:24-05:00","base_branch":"main"}';
    expect(parseLease(line)).toEqual({ path: "/p/.pool/.treehouse/repo-1/1/repo-1", lease_id: "72250bae", lease_holder: "flowryn:r1" });
    expect(parseLease("🌳 Leased worktree at /p")).toBeNull();
    expect(parseLease('{"path":"relative","lease_id":"x"}')).toBeNull();
    expect(parseLease('{"path":"/p","lease_id":""}')).toBeNull();
    expect(parseLease("[]")).toBeNull();
  });

  test("a pool status is the list status --json prints, in 3.1.8's fields", () => {
    const list =
      '[{"name":"1","path":"/p/1/repo","status":"leased","branch":"","detached":true,"flavor":"git","lease_id":"72","lease_holder":"flowryn:r1","leased_at":"2026-11-04T17:05:24-05:00","processes":[]}]';
    expect(parseStatus(list)).toEqual([{ name: "1", path: "/p/1/repo", status: "leased", branch: "", detached: true, lease_id: "72", lease_holder: "flowryn:r1" }]);
    expect(parseStatus("")).toEqual([]);
    expect(parseStatus("{}")).toBeNull();
    expect(parseStatus('[{"name":"1"}]')).toBeNull();
  });

  test("the version drops 3.1.8's leading v", async () => {
    const s = scratch();
    expect(await treehouseVersion(s.bin)).toBe(VERIFIED_TREEHOUSE);
  });
});

describe("the pool calls", () => {
  test("get --lease hands out a detached slot under Flowryn's own root, named for its holder", async () => {
    const s = scratch();
    const slot = await leased(s);
    expect(slot.path.startsWith(join(s.root, ".treehouse"))).toBe(true);
    expect(slot.lease_holder).toBe("flowryn:r1");
    expect(git(slot.path, ["branch", "--show-current"]).out).toBe("");
    expect(poolSlots(s.root)).toEqual([slot.path]);
  });

  test("a slot leased but never recorded is found again by its holder (a launch after a crash adopts it)", async () => {
    const s = scratch();
    const slot = await leased(s, leaseHolder("r7"));
    expect(await adoptSlot(s.bin, s.root, s.repo, leaseHolder("r7"))).toEqual({ ok: true, value: { path: slot.path, lease_id: slot.lease_id, lease_holder: "flowryn:r7" } });
    expect(await adoptSlot(s.bin, s.root, s.repo, leaseHolder("r8"))).toEqual({ ok: true, value: null });
  });

  // Stand-in fidelity: what this checks lives in the stand-in, mirroring 3.1.8 as tried by hand.
  test("stand-in fidelity: a plain return refuses a slot with changes (no terminal to confirm) and leaves it as it was", async () => {
    const s = scratch();
    const slot = await leased(s);
    sh(slot.path, ["switch", "-q", "-c", "flowryn/t"]);
    writeFileSync(join(slot.path, "untracked.txt"), "work\n");
    const back = await returnSlot(s.bin, s.root, slot.path, slot.lease_id, false);
    expect(back.ok).toBe(false);
    expect(back.detail).toContain("exit 3");
    expect(readFileSync(join(slot.path, "untracked.txt"), "utf8")).toBe("work\n");
    expect(git(slot.path, ["branch", "--show-current"]).out).toBe("flowryn/t");
  });

  // Stand-in fidelity: what this checks lives in the stand-in, mirroring 3.1.8 as tried by hand.
  test("stand-in fidelity: a return detaches the slot, so the branch can be deleted, and keeps its commits on the branch", async () => {
    const s = scratch();
    const slot = await leased(s);
    sh(slot.path, ["switch", "-q", "-c", "flowryn/t"]);
    writeFileSync(join(slot.path, "b.txt"), "two\n");
    sh(slot.path, ["add", "."]);
    sh(slot.path, ["commit", "-q", "-m", "two"]);
    const head = git(slot.path, ["rev-parse", "HEAD"]).out;
    expect((await returnSlot(s.bin, s.root, slot.path, slot.lease_id, false)).ok).toBe(true);
    expect(git(slot.path, ["branch", "--show-current"]).out).toBe("");
    expect(git(s.repo, ["rev-parse", "flowryn/t"]).out).toBe(head);
    expect(git(s.repo, ["branch", "-D", "flowryn/t"]).code).toBe(0);
  });

  // Stand-in fidelity: what this checks lives in the stand-in, mirroring 3.1.8 as tried by hand.
  test("stand-in fidelity: a forced return cleans tracked and untracked changes but keeps ignored files (the warm cache)", async () => {
    const s = scratch();
    const slot = await leased(s);
    writeFileSync(join(slot.path, "a.txt"), "changed\n");
    writeFileSync(join(slot.path, "untracked.txt"), "work\n");
    writeFileSync(join(slot.path, "deps.cache"), "warm\n");
    expect((await returnSlot(s.bin, s.root, slot.path, slot.lease_id, true)).ok).toBe(true);
    expect(git(slot.path, ["status", "--porcelain"]).out).toBe("");
    expect(existsSync(join(slot.path, "untracked.txt"))).toBe(false);
    expect(readFileSync(join(slot.path, "deps.cache"), "utf8")).toBe("warm\n");
    // The next lease gets the same slot back.
    const again = await leased(s, leaseHolder("r2"));
    expect(again.path).toBe(slot.path);
    expect(again.lease_id).not.toBe(slot.lease_id);
  });

  // Stand-in fidelity: what this checks lives in the stand-in, mirroring 3.1.8 as tried by hand.
  test("stand-in fidelity: --if-lease-id refuses a slot another lease now holds", async () => {
    const s = scratch();
    const slot = await leased(s);
    expect((await returnSlot(s.bin, s.root, slot.path, slot.lease_id, true)).ok).toBe(true);
    const other = await leased(s, leaseHolder("r2"));
    const stale = await returnSlot(s.bin, s.root, other.path, slot.lease_id, true);
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain("lease precondition failed");
    expect((await adoptSlot(s.bin, s.root, s.repo, leaseHolder("r2"))).ok).toBe(true);
  });
});

describe("leases that would otherwise stay held", () => {
  test("a get that fails after leasing a slot hands that slot back forced, so the pool keeps it", async () => {
    const s = scratch();
    mkdirSync(join(s.root, ".treehouse"), { recursive: true });
    writeFileSync(join(s.root, ".treehouse", "fake-get-fails"), "");
    const got = await acquireSlot(s.bin, s.root, s.repo, leaseHolder("r1"));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.detail).toContain("treehouse get failed");
    expect(got.detail).toContain("the slot it leased was returned");
    expect(await adoptSlot(s.bin, s.root, s.repo, leaseHolder("r1"))).toEqual({ ok: true, value: null });
    rmSync(join(s.root, ".treehouse", "fake-get-fails"));
    const next = await leased(s, leaseHolder("r2"));
    expect(next.path).toBe(poolSlots(s.root)[0]!);
    expect(poolSlots(s.root)).toHaveLength(1);
  });

  test("a slot treehouse still lists for the holder but whose folder is gone is not adopted; a new one is leased", async () => {
    const s = scratch();
    const lost = await leased(s, leaseHolder("r1"));
    rmSync(lost.path, { recursive: true, force: true });
    expect(await adoptSlot(s.bin, s.root, s.repo, leaseHolder("r1"))).toEqual({ ok: true, value: null });
    sh(s.repo, ["worktree", "prune"]);
    const next = await leased(s, leaseHolder("r1"));
    expect(next.path).not.toBe(lost.path);
    expect(existsSync(next.path)).toBe(true);
  });
});

describe("the cleanup's return path", () => {
  const config = cleanupConfig(parseConfig('data_dir = "/tmp/d"\nstate_dir = "/tmp/s"\n', "/tmp/h"));
  function cleanup(s: Scratch, worktree: string, lease: string, discardApproved: boolean, returned: string[]) {
    return runCleanup(
      { guard: { mode: "local-only", kind: "ship", worktree, branch: "flowryn/t", defaultBranch: "main", repo: null, recordedPrUrl: null, discardApproved }, primary: s.repo },
      {
        git: gitRunner(Bun.which("git") ?? "git"),
        forge: null,
        webUrl: "https://github.com",
        lsof: null,
        noMistakes: null,
        ps: async () => "",
        config,
        log: () => {},
        returnWorktree: (path, discard) => {
          returned.push(`${path} ${discard ? "force" : "plain"}`);
          return returnSlot(s.bin, s.root, path, lease, discard);
        },
      },
    );
  }

  test("a discard you approved returns the slot forced, records the discarded head and deletes the branch", async () => {
    const s = scratch();
    const slot = await leased(s);
    sh(slot.path, ["switch", "-q", "-c", "flowryn/t"]);
    writeFileSync(join(slot.path, "b.txt"), "unlanded\n");
    sh(slot.path, ["add", "."]);
    sh(slot.path, ["commit", "-q", "-m", "unlanded"]);
    const head = git(slot.path, ["rev-parse", "HEAD"]).out;
    writeFileSync(join(slot.path, "dirty.txt"), "uncommitted\n");
    const returned: string[] = [];
    const refused = await cleanup(s, slot.path, slot.lease_id, false, returned);
    expect(refused.outcome).toBe("refused");
    expect(returned).toEqual([]);
    expect(existsSync(join(slot.path, "dirty.txt"))).toBe(true);

    const outcome = await cleanup(s, slot.path, slot.lease_id, true, returned);
    expect(outcome).toMatchObject({ outcome: "removed", reason: "discard_approved", branchDeleted: true, discardedHead: head });
    expect(returned).toEqual([`${slot.path} force`]);
    expect(outcome.steps.indexOf("worktree_return:ok")).toBeGreaterThan(outcome.steps.findIndex((step) => step.startsWith("reap:")));
    expect(outcome.steps).not.toContain("worktree_remove:ok");
    expect(existsSync(slot.path)).toBe(true);
    expect(git(slot.path, ["status", "--porcelain"]).out).toBe("");
    expect(git(s.repo, ["rev-parse", "--verify", "--quiet", "refs/heads/flowryn/t"]).code).not.toBe(0);
  });

  test("a slot whose folder is gone still has its lease handed back, forced, and the cleanup completes", async () => {
    const s = scratch();
    const slot = await leased(s);
    sh(slot.path, ["switch", "-q", "-c", "flowryn/t"]);
    sh(s.repo, ["merge", "-q", "--ff-only", "flowryn/t"]);
    rmSync(slot.path, { recursive: true, force: true });
    const returned: string[] = [];
    const outcome = await cleanup(s, slot.path, slot.lease_id, false, returned);
    expect(outcome).toMatchObject({ outcome: "removed", branchDeleted: true });
    expect(returned).toEqual([`${slot.path} force`]);
    expect(outcome.steps.indexOf("worktree_prune")).toBeGreaterThan(outcome.steps.indexOf("worktree_return:ok"));
    expect(outcome.steps).toContain("worktree_return:ok");
    expect(await adoptSlot(s.bin, s.root, s.repo, leaseHolder("r1"))).toEqual({ ok: true, value: null });
    const status = await poolStatus(s.bin, s.root, s.repo);
    expect(status.ok && status.value.some((entry) => entry.lease_id === slot.lease_id)).toBe(false);
    expect(git(s.repo, ["rev-parse", "--verify", "--quiet", "refs/heads/flowryn/t"]).code).not.toBe(0);
  });

  test("landed work is returned without force", async () => {
    const s = scratch();
    const slot = await leased(s);
    sh(slot.path, ["switch", "-q", "-c", "flowryn/t"]);
    writeFileSync(join(slot.path, "b.txt"), "landed\n");
    sh(slot.path, ["add", "."]);
    sh(slot.path, ["commit", "-q", "-m", "landed"]);
    sh(s.repo, ["merge", "-q", "--ff-only", "flowryn/t"]);
    const returned: string[] = [];
    const outcome = await cleanup(s, slot.path, slot.lease_id, false, returned);
    expect(outcome).toMatchObject({ outcome: "removed", branchDeleted: true, discardedHead: null });
    expect(returned).toEqual([`${slot.path} plain`]);
  });

  test("a failed return refuses the cleanup and keeps the slot, its branch and its head", async () => {
    const s = scratch();
    const slot = await leased(s);
    sh(slot.path, ["switch", "-q", "-c", "flowryn/t"]);
    sh(s.repo, ["merge", "-q", "--ff-only", "flowryn/t"]);
    const returned: string[] = [];
    const outcome = await cleanup(s, slot.path, "not-this-lease", false, returned);
    expect(outcome).toMatchObject({ outcome: "refused", reason: "remove_failed", branchDeleted: false });
    expect(outcome.detail).toContain("lease precondition failed");
    expect(git(slot.path, ["branch", "--show-current"]).out).toBe("flowryn/t");
    expect(git(s.repo, ["rev-parse", "--verify", "--quiet", "refs/heads/flowryn/t"]).code).toBe(0);
  });
});

function doctorConfig(extra: string, tools = "") {
  dir ||= realpathSync(mkdtempSync(join(tmpdir(), "fw-th-")));
  return parseConfig(`data_dir = ${JSON.stringify(join(dir, "d"))}\nstate_dir = ${JSON.stringify(join(dir, "s"))}\n[tools]\n${tools}\n[workers]\n${extra}\n`, dir);
}

describe("doctor's worktrees line", () => {
  test("git: says runs get a fresh git worktree", async () => {
    const checks = await worktreeChecks(doctorConfig('worktree_provider = "git"'));
    expect(checks).toEqual([expect.objectContaining({ check: "worktrees", status: "ok", detail: expect.stringContaining("git: a fresh git worktree per run") })]);
  });

  test("treehouse missing: says runs fall back to git", async () => {
    const checks = await worktreeChecks(doctorConfig("", `treehouse = ${JSON.stringify(join(tmpdir(), "no-such-treehouse"))}`));
    expect(checks).toEqual([expect.objectContaining({ check: "worktrees", status: "warn", detail: expect.stringContaining("treehouse is not installed") })]);
  });

  test("treehouse found: its version and where the pools live", async () => {
    const s = scratch();
    const checks = await worktreeChecks(doctorConfig("", `treehouse = ${JSON.stringify(s.bin)}`));
    expect(checks).toEqual([expect.objectContaining({ check: "worktrees", status: "ok", detail: expect.stringContaining(`treehouse ${VERIFIED_TREEHOUSE}: run worktrees come from a pool`) })]);
  });
});
