import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { DEFAULT_UPKEEP, upkeepConfig } from "../../src/config/upkeep.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { recordSync, syncPrimary } from "../../src/upkeep/sync.ts";
import { GIT_ENV, mergeOnOrigin, projectAt, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * Syncing a primary checkout (spec 3, phase 3), against real git: a bare
 * origin, the primary checkout cloned from it, and a second clone that
 * pushes the merges. The checkout moves only by a fast-forward on its
 * default branch with no tracked changes; every other state is left as it
 * was, and the ones you should hear about open one item.
 */

let dir: string;
let db: Db;
let repos: { origin: string; primary: string; other: string };
const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-upkeep-sync-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  repos = scratchRepos(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function openUnsynced(): string[] {
  return (db.query("SELECT line FROM items WHERE kind = 'checkout_unsynced' AND state IN ('open','presented')").all() as { line: string }[]).map((r) => r.line);
}

async function syncAndRecord(project = projectAt(repos.primary)) {
  const outcome = await syncPrimary(git, project);
  tx(db, () => recordSync(db, project, outcome, Date.now()));
  return outcome;
}

describe("syncPrimary", () => {
  test("a checkout behind origin is fast-forwarded to it, and the sync is an event", async () => {
    const before = sh(repos.primary, ["rev-parse", "HEAD"]);
    const merged = mergeOnOrigin(repos.other, "b.txt", "two\n");
    const outcome = await syncAndRecord();
    expect(outcome).toEqual({ outcome: "synced", from: before, to: merged });
    expect(sh(repos.primary, ["rev-parse", "HEAD"])).toBe(merged);
    expect(sh(repos.primary, ["status", "--porcelain"])).toBe("");
    const event = db.query("SELECT payload FROM events WHERE kind = 'upkeep.synced'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ project: "web", from: before, to: merged });
  });

  test("a checkout already in step changes nothing and records nothing", async () => {
    expect((await syncAndRecord()).outcome).toBe("current");
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind LIKE 'upkeep.%'").get()).toEqual({ n: 0 });
  });

  test("tracked changes: skipped, the change kept, and one item says why", async () => {
    mergeOnOrigin(repos.other, "b.txt", "two\n");
    writeFileSync(join(repos.primary, "a.txt"), "edited\n");
    const before = sh(repos.primary, ["rev-parse", "HEAD"]);
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "dirty" });
    expect(sh(repos.primary, ["rev-parse", "HEAD"])).toBe(before);
    expect(sh(repos.primary, ["status", "--porcelain"])).toBe("M a.txt");
    await syncAndRecord();
    expect(openUnsynced()).toEqual(["Primary checkout of web not synced with origin/main: it has uncommitted changes; new runs branch from it as it is"]);
  });

  test("an untracked file alone does not stop a sync that does not touch it", async () => {
    const merged = mergeOnOrigin(repos.other, "b.txt", "two\n");
    writeFileSync(join(repos.primary, "notes.txt"), "mine\n");
    expect((await syncAndRecord()).outcome).toBe("synced");
    expect(sh(repos.primary, ["rev-parse", "HEAD"])).toBe(merged);
  });

  test("an untracked file the merge would overwrite: git refuses, nothing moves, and an item says so", async () => {
    mergeOnOrigin(repos.other, "b.txt", "two\n");
    writeFileSync(join(repos.primary, "b.txt"), "mine\n");
    const before = sh(repos.primary, ["rev-parse", "HEAD"]);
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "merge_refused" });
    expect(sh(repos.primary, ["rev-parse", "HEAD"])).toBe(before);
    expect(openUnsynced()[0]).toContain("git merge --ff-only refused");
  });

  test("local commits not on origin: ahead, or diverged once origin moves too; never rewritten", async () => {
    writeFileSync(join(repos.primary, "local.txt"), "local\n");
    sh(repos.primary, ["add", "."]);
    sh(repos.primary, ["commit", "-q", "-m", "local"]);
    const local = sh(repos.primary, ["rev-parse", "HEAD"]);
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "ahead" });
    mergeOnOrigin(repos.other, "b.txt", "two\n");
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "diverged" });
    expect(sh(repos.primary, ["rev-parse", "HEAD"])).toBe(local);
    // The item follows the reason: one open item, the newest reason.
    expect(openUnsynced()).toHaveLength(1);
    expect(openUnsynced()[0]).toContain("have diverged");
  });

  test("off the default branch: skipped quietly (dispatch's checkout_tangle says it), nothing moves", async () => {
    mergeOnOrigin(repos.other, "b.txt", "two\n");
    sh(repos.primary, ["checkout", "-q", "-b", "feature"]);
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "off_branch" });
    expect(sh(repos.primary, ["branch", "--show-current"])).toBe("feature");
    expect(openUnsynced()).toEqual([]);
  });

  test("no origin remote, or a fetch that fails: skipped quietly", async () => {
    sh(repos.primary, ["remote", "set-url", "origin", join(dir, "gone.git")]);
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "fetch_failed" });
    sh(repos.primary, ["remote", "remove", "origin"]);
    expect(await syncAndRecord()).toMatchObject({ outcome: "skipped", reason: "no_origin" });
    expect(openUnsynced()).toEqual([]);
  });

  test("the item closes once a sync succeeds", async () => {
    mergeOnOrigin(repos.other, "b.txt", "two\n");
    writeFileSync(join(repos.primary, "a.txt"), "edited\n");
    await syncAndRecord();
    expect(openUnsynced()).toHaveLength(1);
    sh(repos.primary, ["checkout", "-q", "--", "a.txt"]);
    expect((await syncAndRecord()).outcome).toBe("synced");
    expect(openUnsynced()).toEqual([]);
  });
});

function upkeepTable(extra: Record<string, unknown>): FlowrynConfig {
  return { ...defaultConfig("/h"), extra: { upkeep: extra } };
}

describe("[upkeep]", () => {
  test("defaults: every chosen hook on, 24 h before an ended worktree is cleaned", () => {
    expect(upkeepConfig(defaultConfig("/h"))).toEqual(DEFAULT_UPKEEP);
    expect(DEFAULT_UPKEEP).toEqual({ build_after_merge: true, sync_primary: true, clean_ended_hours: 24, nudge_conflicts: true, explanations_keep_days: 30, explanations_keep_per_run: 200, interval_ms: 600_000 });
  });

  test("each hook has its own switch", () => {
    expect(upkeepConfig(upkeepTable({ build_after_merge: false, sync_primary: false, clean_ended_hours: 0, nudge_conflicts: false, explanations_keep_days: 0, explanations_keep_per_run: 5, interval_ms: 500 }))).toEqual({
      build_after_merge: false,
      sync_primary: false,
      clean_ended_hours: 0,
      nudge_conflicts: false,
      explanations_keep_days: 0,
      explanations_keep_per_run: 5,
      interval_ms: 500,
    });
  });

  test("an unknown key, a wrong type or a negative wait is refused", () => {
    expect(() => upkeepConfig(upkeepTable({ prune_done: true }))).toThrow("[upkeep] prune_done is not a known setting");
    expect(() => upkeepConfig(upkeepTable({ sync_primary: "yes" }))).toThrow("[upkeep] sync_primary must be true or false");
    expect(() => upkeepConfig(upkeepTable({ clean_ended_hours: -1 }))).toThrow("clean_ended_hours");
    expect(() => upkeepConfig(upkeepTable({ interval_ms: 0 }))).toThrow("interval_ms");
    expect(() => upkeepConfig(upkeepTable({ explanations_keep_days: -1 }))).toThrow("[upkeep] explanations_keep_days must be a whole number");
    expect(() => upkeepConfig(upkeepTable({ explanations_keep_per_run: 2.5 }))).toThrow("[upkeep] explanations_keep_per_run must be a whole number");
  });
});
