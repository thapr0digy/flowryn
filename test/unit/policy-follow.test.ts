import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_VALIDATION, validationConfig } from "../../src/config/validation.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { CI_WAIT_ORIGIN } from "../../src/lifecycle/ci-wait.ts";
import { landRun } from "../../src/lifecycle/landing.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { KICK_DELAY_MS, POLICY_EVENT, PolicyFollower, policyChangesSince, policyHash, policySteerText } from "../../src/upkeep/policy-follow.ts";
import { projectAt, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * The policy follow-through (src/upkeep/policy-follow.ts) on a scratch
 * database and real git: a bare origin, the primary checkout, the runs'
 * linked worktrees of it, and a second clone that pushes what a merge on
 * GitHub would. The integration test through the real daemon is
 * test/integration/policy-follow.test.ts.
 */

const git = gitRunner("git", 30_000);
let dir: string;
let db: Db;
let now: number;
let primary: string;
let other: string;
let paths: string[];
let kicks: number;

/** A commit on origin's main from the other clone, as a merge on GitHub; the file's directory is made as needed. */
function mergeOnMain(file: string, text: string): string {
  sh(other, ["pull", "-q", "--ff-only"]);
  mkdirSync(dirname(join(other, file)), { recursive: true });
  writeFileSync(join(other, file), text);
  sh(other, ["add", "."]);
  sh(other, ["commit", "-q", "-m", `merge ${file}`]);
  sh(other, ["push", "-q", "origin", "main"]);
  return sh(other, ["rev-parse", "HEAD"]);
}

function commitIn(cwd: string, file: string, text: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  sh(cwd, ["add", "."]);
  sh(cwd, ["commit", "-q", "-m", `work ${file}`]);
}

interface SeedOpts {
  state?: string;
  stage?: string;
  stageState?: string;
  workflow?: string;
  deliveryMode?: string;
}

/** A ship's run with its own linked worktree of the primary checkout, branched from origin/main as it is now. */
function seedRun(id: string, opts: SeedOpts = {}): string {
  const worktree = join(dir, "wt", id);
  sh(primary, ["fetch", "-q", "origin", "main"]);
  sh(primary, ["worktree", "add", "-q", "-b", `b-${id}`, worktree, "origin/main"]);
  commitIn(worktree, `${id}.txt`, `${id}\n`);
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', ?2, 0, ?3, 0)").run(`t-${id}`, opts.deliveryMode ?? "no-mistakes", opts.workflow ?? "fix");
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', 'v', ?3, 'busy', ?4, ?5, ?6, ?7, ?8, 's', ?1, ?9, ?9)`,
    ).run(id, `t-${id}`, opts.state ?? "validating", opts.workflow ?? "fix", opts.stage ?? "ship", opts.stageState ?? "active", worktree, `b-${id}`, now);
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', ?1, ?2, ?3)").run(id, opts.stage ?? "ship", now);
  });
  return worktree;
}

function follower(): PolicyFollower {
  return new PolicyFollower({
    db,
    config: () => ({ follow_paths: paths, follow_interval_ms: 60_000 }),
    now: () => now,
    log: () => {},
    git,
    projects: () => [{ ...projectAt(primary, "web"), delivery_mode: "no-mistakes" }],
    kickScheduler: () => {
      kicks++;
    },
  });
}

function steers(run: string): string[] {
  return (db.query("SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at, id").all(run) as { body: string }[]).map((m) => m.body);
}

function followEvents(run: string): { hash: string; via: string; files: string[] }[] {
  return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(run, POLICY_EVENT) as { payload: string }[]).map((e) => JSON.parse(e.payload));
}

function openItemsOf(run: string): { kind: string; line: string }[] {
  return db.query("SELECT kind, line FROM items WHERE run_id = ?1 AND state IN ('open', 'presented') ORDER BY opened_at, id").all(run) as { kind: string; line: string }[];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-policy-follow-"));
  ({ primary, other } = scratchRepos(dir));
  mergeOnMain(".no-mistakes.yaml", "# settings\n");
  sh(primary, ["pull", "-q", "--ff-only"]);
  paths = [...DEFAULT_VALIDATION.follow_paths];
  kicks = 0;
  now = 1_000_000_000;
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web', ?1, 'main', 'no-mistakes')").run(primary);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("policy reads", () => {
  test("assumption: a directory pathspec (.github/workflows/) matches the files under it in ls-tree and diff", async () => {
    const wt = seedRun("r1");
    const before = await policyHash(git, wt, "origin/main", paths);
    const tip = mergeOnMain(".github/workflows/ci.yml", "on: push\n");
    sh(wt, ["fetch", "-q", "origin", "main"]);
    const after = await policyHash(git, wt, tip, paths);
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
    expect(await policyChangesSince(git, wt, tip, paths)).toEqual([".github/workflows/ci.yml"]);
  });

  test("only main's changes count: the branch's own edit of a policy file is not a change on main", async () => {
    const wt = seedRun("r1");
    commitIn(wt, ".no-mistakes.yaml", "# settings\nno_ci: true\n");
    const tip = mergeOnMain("README.md", "readme\n");
    sh(wt, ["fetch", "-q", "origin", "main"]);
    expect(await policyChangesSince(git, wt, tip, paths)).toEqual([]);
  });

  test("an unrelated file leaves the hash as it was", async () => {
    const wt = seedRun("r1");
    const before = await policyHash(git, wt, "origin/main", paths);
    const tip = mergeOnMain("src/app.ts", "x\n");
    sh(wt, ["fetch", "-q", "origin", "main"]);
    expect(await policyHash(git, wt, tip, paths)).toBe(before);
  });

  test("git that cannot tell (no such commit) is null, not a change", async () => {
    const wt = seedRun("r1");
    expect(await policyChangesSince(git, wt, "0".repeat(40), paths)).toBeNull();
    expect(await policyHash(git, wt, "0".repeat(40), paths)).toBeNull();
  });
});

describe("the follow-through pass", () => {
  test("a validating ship is steered once per policy hash: an unrelated merge steers nothing, a further policy change steers again", async () => {
    seedRun("r1");
    expect((await follower().pass()).steered).toEqual([]);

    const tip = mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    expect((await follower().pass()).steered).toEqual(["t-r1"]);
    const [steer, ...more] = steers("r1");
    expect(more).toEqual([]);
    expect(steer).toContain(`main changed its validation policy since your branch forked (.no-mistakes.yaml; origin/main at ${tip.slice(0, 8)})`);
    expect(steer).toContain("git merge origin/main; never rebase or force-push");
    expect(steer).toContain("no-mistakes rerun");
    expect(followEvents("r1")).toMatchObject([{ via: "steer", files: [".no-mistakes.yaml"] }]);

    // The same hash again: nothing.
    await follower().pass();
    expect(steers("r1")).toHaveLength(1);
    // An unrelated merge: the hash is unchanged.
    mergeOnMain("README.md", "readme\n");
    await follower().pass();
    expect(steers("r1")).toHaveLength(1);
    // A further policy change: a new hash, a new steer.
    mergeOnMain(".github/workflows/ci.yml", "on: push\n");
    expect((await follower().pass()).steered).toEqual(["t-r1"]);
    expect(steers("r1")).toHaveLength(2);
    expect(steers("r1")[1]).toContain(".github/workflows/ci.yml");
    const events = followEvents("r1");
    expect(events[0]!.hash).not.toBe(events[1]!.hash);
  });

  test("a ship that merged main is not behind: nothing is sent", async () => {
    const wt = seedRun("r1");
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    sh(wt, ["fetch", "-q", "origin", "main"]);
    sh(wt, ["merge", "-q", "--no-edit", "origin/main"]);
    await follower().pass();
    expect(steers("r1")).toEqual([]);
  });

  test("assumption: one fetch moves origin/main for every linked worktree of the project", async () => {
    seedRun("r1");
    seedRun("r2", { state: "running" });
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    const report = await follower().pass();
    expect(report.steered).toEqual(["t-r1", "t-r2"]);
  });

  test("only ships at their ship stage: an earlier stage, a waiting stage, a local ship and a merging run are left alone, and an earlier stage is steered once it reaches its ship stage", async () => {
    seedRun("early", { state: "running", workflow: "feature", stage: "build" });
    seedRun("waiting", { state: "running", stageState: "waiting" });
    seedRun("local", { deliveryMode: "local" });
    seedRun("merging", { state: "merging" });
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    expect((await follower().pass()).steered).toEqual([]);
    for (const run of ["early", "waiting", "local", "merging"]) expect(steers(run)).toEqual([]);

    tx(db, () => db.query("UPDATE runs SET stage = 'ship', stage_state = 'active' WHERE id IN ('early', 'waiting')").run());
    expect((await follower().pass()).steered).toEqual(["t-early", "t-waiting"]);
  });

  test("an open CI-wait question on a steered run is dismissed as superseded", async () => {
    seedRun("r1");
    tx(db, () => {
      db.query(
        `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, created_at)
         VALUES ('q1', 't-r1', 'r1', 'CI wait?', '["merge-main","accept-without-ci","keep-waiting"]', 0, 'open', ?1, '01nm-1', ?2)`,
      ).run(CI_WAIT_ORIGIN, now);
    });
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    await follower().pass();
    expect(db.query("SELECT state, answered_via FROM decisions WHERE id = 'q1'").get()).toEqual({ state: "dismissed", answered_via: "policy" });
    const dismissed = db.query("SELECT payload FROM events WHERE kind = 'decision.dismissed'").get() as { payload: string };
    expect(JSON.parse(dismissed.payload).why).toContain("superseded");
  });

  test("assumption: sendBack restarts a delivered ship's last stage with the instruction; a policy_sent_back line says so, and the scheduler is kicked", async () => {
    seedRun("r1", { state: "ready" });
    mergeOnMain(".github/workflows/ci.yml", "on: push\n");
    const report = await follower().pass();
    expect(report.sentBack).toEqual(["t-r1"]);
    expect(kicks).toBe(1);
    const run = getRunWithPolicy(db, "r1")!;
    expect(run).toMatchObject({ state: "running", stage: "ship", stage_state: "waiting" });
    expect(run.stage_note).toContain("Your delivered PR is behind: main changed its validation policy");
    expect(run.stage_note).toContain("ship it again and deliver");
    expect(followEvents("r1")).toMatchObject([{ via: "send_back" }]);
    const items = openItemsOf("r1");
    expect(items.map((i) => i.kind)).toEqual(["policy_sent_back"]);
    expect(items[0]!.line).toContain("sent back to merge origin/main and deliver again");
  });

  test("delivered again still behind a hash it was told about: one policy_behind line, no second send-back; it closes once the branch has main", async () => {
    const wt = seedRun("r1");
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    await follower().pass();
    expect(steers("r1")).toHaveLength(1);
    // The worker delivers without merging main.
    tx(db, () => db.query("UPDATE runs SET state = 'ready' WHERE id = 'r1'").run());
    expect((await follower().pass()).behind).toEqual(["t-r1"]);
    await follower().pass();
    expect(getRunWithPolicy(db, "r1")!.state).toBe("ready");
    expect(openItemsOf("r1").map((i) => i.kind)).toEqual(["policy_behind"]);
    expect(openItemsOf("r1")[0]!.line).toContain("merge as is, steer it, or flowryn decline t-r1");
    expect(followEvents("r1")).toHaveLength(1);

    sh(wt, ["merge", "-q", "--no-edit", "origin/main"]);
    await follower().pass();
    expect(openItemsOf("r1")).toEqual([]);
  });

  test("a landing settles the follow-through's lines", async () => {
    seedRun("r1", { state: "ready" });
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    await follower().pass();
    tx(db, () => db.query("UPDATE runs SET state = 'ready' WHERE id = 'r1'").run());
    tx(db, () => landRun(db, getRunWithPolicy(db, "r1")!, { mergeSha: "f".repeat(40), how: "merged_elsewhere" }, now));
    expect(openItemsOf("r1")).toEqual([]);
  });

  test("an empty follow_paths turns it off", async () => {
    seedRun("r1");
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    paths = [];
    await follower().pass();
    expect(steers("r1")).toEqual([]);
  });

  test("a failed fetch reads the last fetched tip", async () => {
    const wt = seedRun("r1");
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    sh(wt, ["fetch", "-q", "origin", "main"]);
    sh(primary, ["remote", "set-url", "origin", join(dir, "gone.git")]);
    expect((await follower().pass()).steered).toEqual(["t-r1"]);
  });

  test("kick runs a pass after KICK_DELAY_MS, and stop cancels it", async () => {
    seedRun("r1");
    mergeOnMain(".no-mistakes.yaml", "# settings\nno_ci: true\n");
    const f = follower();
    f.kick();
    f.kick();
    await Bun.sleep(KICK_DELAY_MS + 1_000);
    expect(steers("r1")).toHaveLength(1);
    const g = follower();
    mergeOnMain(".github/workflows/ci.yml", "on: push\n");
    g.kick();
    g.stop();
    await Bun.sleep(KICK_DELAY_MS + 300);
    expect(steers("r1")).toHaveLength(1);
  });
});

describe("the steer text", () => {
  test("names at most three files", () => {
    const text = policySteerText(["a", "b", "c", "d", "e"], "1234567890", "main", false);
    expect(text).toContain("(a, b, c +2 more; origin/main at 12345678)");
  });
});

const at = (text: string) => validationConfig(parseConfig(text, "/x/config.toml"));

describe("[validation] follow_paths and follow_interval_ms", () => {
  test("defaults: .no-mistakes.yaml and .github/workflows/, every 5 min", () => {
    expect(at("")).toMatchObject({ follow_paths: [".no-mistakes.yaml", ".github/workflows/"], follow_interval_ms: 300_000 });
  });

  test("an empty list is allowed; anything but plain relative paths is refused", () => {
    expect(at("[validation]\nfollow_paths = []\n").follow_paths).toEqual([]);
    expect(at('[validation]\nfollow_paths = ["ci/"]\n').follow_paths).toEqual(["ci/"]);
    for (const bad of ['"x"', '[""]', '["/etc"]', '[":(exclude)a"]', '["--output=x"]', '["../up"]', "[1]"]) {
      expect(() => at(`[validation]\nfollow_paths = ${bad}\n`)).toThrow("follow_paths must be a list of relative paths");
    }
    expect(() => at("[validation]\nfollow_interval_ms = 0\n")).toThrow("follow_interval_ms must be a positive integer");
  });
});
