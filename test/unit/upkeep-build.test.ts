import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo } from "../../src/api/verbs.ts";
import { DEFAULT_DAEMON } from "../../src/config/daemon.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { BuildWatcher, type GitResult } from "../../src/daemon/build-watch.ts";
import { RestartController, buildIdOfBytes, readPending, restartGuards, type Supervisor } from "../../src/daemon/restart.ts";
import { insertProject } from "../../src/lifecycle/projects.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { LANDING_HOLD_MS, MergeBuilder, STAGING_DIR, readAttempt, runStep, type StepRunner } from "../../src/upkeep/build.ts";
import { GIT_ENV, mergeOnOrigin, projectAt, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * The build after a Flowryn merge (spec 3, phase 3), against real git: a
 * scratch origin whose `scripts/build.sh` is a stand-in that stamps the way
 * the real one does (the commit, a dirty flag from `git status`, and
 * FLOWRYN_BUILD_SOURCE) into a JSON "binary". The real `build.sh` compiling
 * a real binary is covered by test/integration/binary.test.ts.
 */

const STUB_BUILD = `#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd -P)
OUT="$1"
if [ -f "$ROOT/fail-build" ]; then echo "compile error (stub)" >&2; exit 3; fi
COMMIT=$(git -C "$ROOT" rev-parse HEAD)
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then DIRTY=true; else DIRTY=false; fi
printf '{"commit":"%s","dirty":%s,"source":"%s"}\\n' "$COMMIT" "$DIRTY" "\${FLOWRYN_BUILD_SOURCE:-$ROOT}" > "$OUT"
ln -sf "$(basename "$OUT")" "$(dirname "$OUT")/flowrynd"
`;

const OLD_BINARY = "old build\n";

let dir: string;
let db: Db;
let repos: { origin: string; primary: string; other: string };
let target: string;
const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

interface Stamp {
  commit: string;
  dirty: boolean;
  source: string;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-upkeep-build-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  repos = scratchRepos(dir);
  mkdirSync(join(repos.other, "scripts"), { recursive: true });
  writeFileSync(join(repos.other, "scripts", "build.sh"), STUB_BUILD, { mode: 0o755 });
  // As in Flowryn's own repository: installed dependencies are ignored, so a build tree with them is still clean.
  writeFileSync(join(repos.other, ".gitignore"), "node_modules/\n");
  sh(repos.other, ["add", "."]);
  sh(repos.other, ["commit", "-q", "-m", "build script"]);
  sh(repos.other, ["push", "-q", "origin", "main"]);
  tx(db, () => insertProject(db, projectAt(repos.primary, "flowryn")));
  mkdirSync(join(dir, "dist"));
  target = join(dir, "dist", "flowryn");
  writeFileSync(target, OLD_BINARY);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Knobs {
  build?: string | null;
  commit?: string | null;
  source?: string | null;
  run?: StepRunner;
  stepTimeoutMs?: number;
  bun?: string | null;
  now?: () => number;
}

function builder(k: Knobs = {}): MergeBuilder {
  return new MergeBuilder({
    db,
    env: { ...process.env, ...GIT_ENV },
    now: k.now ?? Date.now,
    log: () => {},
    git,
    running: () => ({ build: k.build === undefined ? "aaaaaaaaaaaa" : k.build, commit: k.commit ?? null }),
    source: () => (k.source === undefined ? repos.primary : k.source),
    target: async () => target,
    bun: () => (k.bun === undefined ? process.execPath : k.bun),
    workDir: join(dir, "build"),
    logDir: join(dir, "logs"),
    run: k.run,
    stepTimeoutMs: k.stepTimeoutMs,
  });
}

/** The watcher's git, through the same runner. */
async function watchGit(args: string[], cwd: string): Promise<GitResult> {
  const result = await git(args, cwd);
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** build.sh hangs; every other step runs. */
const slow: StepRunner = (argv, opts) => runStep(argv[1]?.endsWith("build.sh") ? ["/bin/sleep", "5"] : argv, opts);

function tip(): string {
  return sh(repos.other, ["rev-parse", "HEAD"]);
}

function installed(): Stamp {
  return JSON.parse(readFileSync(target, "utf8")) as Stamp;
}

function openItems(kind: string): string[] {
  return (db.query("SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { line: string }[]).map((r) => r.line);
}

describe("the build after a Flowryn merge", () => {
  test("a new merge on origin builds its tip in a clean worktree and renames it over the installed binary", async () => {
    const merged = tip();
    const before = statSync(target).ino;
    const result = await builder().pass();
    expect(result).toEqual({ outcome: "built", commit: merged, target });
    expect(installed()).toEqual({ commit: merged, dirty: false, source: repos.primary });
    // The staging directory (and build.sh's flowrynd link in it) is gone; nothing else changed beside the binary.
    expect(existsSync(join(dir, "dist", STAGING_DIR))).toBe(false);
    expect(existsSync(join(dir, "dist", "flowrynd"))).toBe(false);
    expect(readAttempt(db)).toMatchObject({ commit: merged, outcome: "built" });
    const event = db.query("SELECT payload FROM events WHERE kind = 'upkeep.built'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ project: "flowryn", commit: merged, target });
    // Assumption: the rename is a new file at the installed path, so the watcher's stat key changes.
    expect(statSync(target).ino).not.toBe(before);
    // The primary checkout itself was not touched by the build (only fetched).
    expect(sh(repos.primary, ["status", "--porcelain"])).toBe("");
  });

  test("assumption: what the builder installs is a build the build watcher applies by itself", async () => {
    const running = buildIdOfBytes(new TextEncoder().encode(OLD_BINARY));
    const supervisor: Supervisor = { name: "fake", supervised: async () => null, target: async () => ({ program: [target, "daemon", "run"] }), restart: async () => ({ ok: true, detail: "" }) };
    const info = (): DaemonInfo => ({ pid: 1, version: "0.11.0", proto: 6, instance: "i", startedAt: 0, execPath: target, build: running, socket: "/s", stateDir: dir });
    const restart = new RestartController({ db, env: {}, now: Date.now, log: () => {}, info, work: () => ({ mergesInFlight: [], cleanups: [], launching: [], challenges: [] }), supervisor: () => supervisor, smoke: async () => ({ version: "0.11.0", proto: 6, build: null, schema: 13, commit: null, dirty: null, source: null }) });
    let now = 1_000_000;
    const watcher = new BuildWatcher({
      db,
      env: {},
      now: () => now,
      log: () => {},
      config: () => ({ ...DEFAULT_DAEMON, build_settle_ms: 1 }),
      info,
      supervisor: () => supervisor,
      restart,
      git: watchGit,
      // The stand-in binary answers version --json from its own stamp.
      smoke: async () => ({ version: "0.11.0", proto: 6, build: null, schema: 13, ...installed() }),
      schema: 13,
    });
    const look = async () => {
      await watcher.tick();
      now += 10;
      await watcher.tick();
    };
    await look();
    expect(readPending(db)).toBeNull();
    const merged = tip();
    expect((await builder({ build: running }).pass()).outcome).toBe("built");
    await look();
    expect(readPending(db)).toMatchObject({ by: "auto" });
    expect(JSON.stringify(readPending(db))).toContain(merged);
  });

  test("the commit the daemon runs, or one already tried, builds nothing", async () => {
    expect(await builder({ commit: tip() }).pass()).toEqual({ outcome: "skipped", reason: "the daemon runs this commit" });
    expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
    expect((await builder().pass()).outcome).toBe("built");
    writeFileSync(target, OLD_BINARY);
    expect(await builder().pass()).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("was tried already") });
    expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
  });

  test("a failed build: one P1 naming the log, the installed binary unchanged, the commit not retried; the next merge builds and closes it", async () => {
    const failing = mergeOnOrigin(repos.other, "fail-build", "1\n");
    const result = await builder().pass();
    expect(result).toEqual({ outcome: "failed", commit: failing, detail: "scripts/build.sh exited 3" });
    expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
    const log = join(dir, "logs", `build-${failing.slice(0, 12)}.log`);
    expect(readFileSync(log, "utf8")).toContain("compile error (stub)");
    // The log comes before the detail, so the 200-character item line keeps it whole; the event keeps everything.
    expect(openItems("build_failed")).toHaveLength(1);
    expect(openItems("build_failed")[0]).toStartWith(`Build after merge failed for flowryn at ${failing.slice(0, 8)}, the installed binary unchanged; log ${log}`);
    const failed = db.query("SELECT payload FROM events WHERE kind = 'upkeep.build_failed'").get() as { payload: string };
    expect(JSON.parse(failed.payload)).toMatchObject({ commit: failing, log, detail: "scripts/build.sh exited 3" });
    expect((await builder().pass()).outcome).toBe("skipped");
    expect(openItems("build_failed")).toHaveLength(1);

    sh(repos.other, ["rm", "-q", "fail-build"]);
    sh(repos.other, ["commit", "-q", "-m", "fix the build"]);
    sh(repos.other, ["push", "-q", "origin", "main"]);
    expect((await builder().pass()).outcome).toBe("built");
    expect(installed().commit).toBe(tip());
    expect(openItems("build_failed")).toEqual([]);
  });

  test("no bun: one build_failed P1 that says so, kept until a build runs", async () => {
    expect(await builder({ bun: null }).pass()).toMatchObject({ outcome: "skipped", reason: "bun is not found ([tools] bun)" });
    await builder({ bun: null }).pass();
    expect(openItems("build_failed")).toEqual(["Build after merge cannot run for flowryn: bun is not found; set [tools] bun in config.toml, or turn [upkeep] build_after_merge off"]);
    expect(readAttempt(db)).toBeNull();
    expect((await builder().pass()).outcome).toBe("built");
    expect(openItems("build_failed")).toEqual([]);
  });

  test("a step that hangs is killed at its limit and counts as a failure", async () => {
    const result = await builder({ run: slow, stepTimeoutMs: 1_000 }).pass();
    expect(result).toMatchObject({ outcome: "failed", detail: "scripts/build.sh did not finish within 1 s" });
    expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
  });

  test("a development daemon, or no project at the running build's source, builds nothing", async () => {
    expect(await builder({ build: null }).pass()).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("development daemon") });
    expect(await builder({ source: null }).pass()).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("no project") });
    expect(await builder({ source: join(dir, "elsewhere") }).pass()).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("no project") });
    expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
    expect(existsSync(join(dir, "build"))).toBe(false);
  });

  test("while it builds, a restart waits on its build guard", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: StepRunner = async (argv, opts) => {
      await gate;
      return runStep(argv, opts);
    };
    const b = builder({ run: held });
    const pass = b.pass();
    await Bun.sleep(300);
    const guards = restartGuards(db, { mergesInFlight: [], cleanups: [], launching: [], challenges: [], builds: b.building() }, Date.now());
    expect(guards).toEqual([{ kind: "build", task: null, detail: expect.stringContaining(`building ${tip().slice(0, 8)} after a merge`) }]);
    expect(await b.pass()).toEqual({ outcome: "skipped", reason: "a build is under way" });
    release();
    expect((await pass).outcome).toBe("built");
    expect(b.building()).toEqual([]);
  });

  test("the worktree is reused and cleaned between builds, node_modules kept", async () => {
    expect((await builder().pass()).outcome).toBe("built");
    const worktree = join(dir, "build", "flowryn");
    writeFileSync(join(worktree, "a.txt"), "edited in the build worktree\n");
    writeFileSync(join(worktree, "stray.txt"), "left behind\n");
    mkdirSync(join(worktree, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "dep", "index.js"), "kept\n");
    const merged = mergeOnOrigin(repos.other, "b.txt", "two\n");
    expect((await builder().pass()).outcome).toBe("built");
    expect(installed()).toEqual({ commit: merged, dirty: false, source: repos.primary });
    expect(existsSync(join(worktree, "stray.txt"))).toBe(false);
    expect(readFileSync(join(worktree, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(worktree, "node_modules", "dep", "index.js"))).toBe(true);
    expect(lstatSync(join(worktree, ".git")).isFile()).toBe(true);
  });
});

describe("the build after a Flowryn merge, with Flowryn's landing queue", () => {
  /** A PR of Flowryn's own project in its landing queue, its run in `state`. */
  function inLine(state: string): void {
    tx(db, () => {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES ('t1', 'flowryn', 'ship', 'direct-PR', 1, 0, 'fix', 0)").run();
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r1', 't1', 'claude', '2.1.281', ?1, 'idle', 'fix', 'ship', 'done', '/tmp/wt', 'flowryn/t1', 'abc', 'x', 1, 1)`,
      ).run(state);
      db.query("INSERT INTO landing_queue (id, project_id, run_id, task_id, ref, entered_head, head_sha, state, enqueued_at, state_since, updated_at) VALUES ('lq1', 'flowryn', 'r1', 't1', 'u', 'h', 'h', 'waiting', 1, 1, 1)").run();
    });
  }

  test("a merge while the queue still has PRs to land waits, so the daemon rebuilds once the line is empty", async () => {
    inLine("ready");
    let clock = 1_000_000;
    const held = await builder({ now: () => clock }).pass();
    expect(held).toMatchObject({ outcome: "skipped" });
    expect((held as { reason: string }).reason).toContain("landing queue has 1 PR(s) to land");
    expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'upkeep.build_held'").get()).toEqual({ n: 1 });
    // Still held a while later: one event for the whole wait.
    clock += 60_000;
    expect(await builder({ now: () => clock }).pass()).toMatchObject({ outcome: "skipped" });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'upkeep.build_held'").get()).toEqual({ n: 1 });
    // The last PR landed (its entry not yet settled): the build goes.
    db.query("UPDATE runs SET state = 'landed' WHERE id = 'r1'").run();
    expect(await builder({ now: () => clock }).pass()).toMatchObject({ outcome: "built", commit: tip() });
  });

  test("a line that does not drain holds the build for at most LANDING_HOLD_MS", async () => {
    inLine("ready");
    let clock = 1_000_000;
    expect(await builder({ now: () => clock }).pass()).toMatchObject({ outcome: "skipped" });
    clock += LANDING_HOLD_MS + 1;
    expect(await builder({ now: () => clock }).pass()).toMatchObject({ outcome: "built", commit: tip() });
  });
});
