import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { validationConfig } from "../../src/config/validation.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { ChecksSummary, Forge, PullRequest } from "../../src/forge/types.ts";
import { ForgeError } from "../../src/forge/types.ts";
import { acceptedWithoutCi, CI_WAIT_ORIGIN, CI_WAIT_RESERVED, ciWaitMinutes, ciWaitSteer, declaresNoCi } from "../../src/lifecycle/ci-wait.ts";
import { answerDecision } from "../../src/lifecycle/decision-verbs.ts";
import { getDecision, type DecisionRow } from "../../src/lifecycle/decisions.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { parseNmStatus } from "../../src/policy/nomistakes.ts";
import { DeliveryWatcher } from "../../src/watch/delivery.ts";

/**
 * The CI-wait watchdog (src/lifecycle/ci-wait.ts) through the delivery
 * watcher's poll: a scratch database, real git (a seed checkout, its bare
 * origin and the run's worktree), a no-mistakes stand-in that prints a status
 * file, and a fake forge whose checks a test sets.
 */

let dir: string;
let db: Db;
let now: number;
let seed: string;
let worktree: string;
let statusFile: string;
let noMistakes: string;
let checks: ChecksSummary | Error;
let alertMin: number;
const git = gitRunner("git", 30_000);
const PR = "https://github.com/acme/web/pull/7";

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string, text: string, message: string): void {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", message);
}

/** Main gains `no_ci: true` after the run's branch was cut, as on 2026-10-08. */
function mainAddsNoCi(): void {
  commit(seed, ".no-mistakes.yaml", "# settings\nno_ci: true\n", "no_ci");
  sh(seed, "push", "-q", "origin", "main");
}

const CI_WAIT = (activeFor: string, id = "01NMCIWAIT") => `run:
  id: "${id}"
  branch: b
  status: running
  head: abc
  pr: "${PR}"
  active_steps[1]{step,status,active_for,last_activity,agent_pid,round}:
    ci,running,${activeFor},"1m ago: log: waiting for checks to register","",starting
`;

function nmSays(text: string): void {
  writeFileSync(statusFile, text);
}

const forge = {
  pull: async (): Promise<PullRequest> =>
    ({ number: 7, url: PR, title: "t", state: "open", draft: false, headSha: "abc", headRef: "b", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null }) satisfies PullRequest,
  checks: async (): Promise<ChecksSummary> => {
    if (checks instanceof Error) throw checks;
    return checks;
  },
} as unknown as Forge;

function watcher(): DeliveryWatcher {
  return new DeliveryWatcher({
    db,
    forge: () => forge,
    webUrl: () => "https://github.com",
    git,
    noMistakes: () => noMistakes,
    nmTimeoutMs: () => 5_000,
    pollMs: () => 60_000,
    ciWaitAlertMin: () => alertMin,
    inFlight: new Set(),
    cleanup: () => {},
    log: () => {},
    now: () => now,
  });
}

function ciWaits(): DecisionRow[] {
  return db.query("SELECT * FROM decisions WHERE origin = ?1 ORDER BY created_at, CAST(substr(id, 2) AS INTEGER)").all(CI_WAIT_ORIGIN) as DecisionRow[];
}

function openItems(): { kind: string; decision_id: string | null; line: string }[] {
  return db.query("SELECT kind, decision_id, line FROM items WHERE state IN ('open', 'presented')").all() as { kind: string; decision_id: string | null; line: string }[];
}

function steers(): string[] {
  return (db.query("SELECT body FROM messages WHERE run_id = 'r1' ORDER BY created_at, id").all() as { body: string }[]).map((m) => m.body);
}

function answer(id: string, choice: string, words: string | null = null): void {
  tx(db, () => answerDecision({ db, now: () => now }, getDecision(db, id)!, { choice, words, by: "captain", via: "shell" }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-ci-wait-"));
  seed = join(dir, "seed");
  const origin = join(dir, "origin.git");
  worktree = join(dir, "wt");
  mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  commit(seed, ".no-mistakes.yaml", "# settings\n", "base");
  sh(dir, "clone", "-q", "--bare", seed, origin);
  sh(seed, "remote", "add", "origin", origin);
  sh(dir, "clone", "-q", origin, worktree);
  sh(worktree, "checkout", "-q", "-b", "b");
  commit(worktree, "b.txt", "b\n", "work");

  statusFile = join(dir, "nm-status");
  noMistakes = join(dir, "no-mistakes");
  writeFileSync(noMistakes, `#!/bin/sh\ncat "${statusFile}"\n`);
  chmodSync(noMistakes, 0o755);
  checks = { state: "none", checks: [] };
  alertMin = 60;
  now = 1_000_000_000;

  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web', ?1, 'main', 'no-mistakes')").run(seed);
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'ship', 'active', ?1, 'b', 's', 'r1', ?2, ?2)`,
    ).run(worktree, now);
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r1', 'ship', ?1)").run(now);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the CI-wait watchdog", () => {
  test("assumption: a pipeline waiting only on CI past the alert with no checks opens one reserved decision, naming main's missing no_ci", async () => {
    mainAddsNoCi();
    nmSays(CI_WAIT("1h5m"));
    await watcher().pass();
    const [d, ...rest] = ciWaits();
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ run_id: "r1", state: "open", blocking: 0, recommendation: "merge-main", reserved_reason: CI_WAIT_RESERVED });
    expect(JSON.parse(d!.options)).toEqual(["merge-main", "accept-without-ci", "keep-waiting"]);
    expect(d!.question).toContain("waited 65 min in CI with no checks registered on PR https://github.com/acme/web/pull/7");
    expect(d!.question).toContain("lacks main's `no_ci: true`");
    const items = openItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "worker_question", decision_id: d!.id });
    expect(items[0]!.line).toContain(`relay: flowryn decide ${d!.id} <choice> --by captain`);
    expect(items[0]!.line.length).toBeLessThanOrEqual(200);
    // One per stall: the next poll asks nothing new.
    now += 10 * 60_000;
    await watcher().pass();
    expect(ciWaits()).toHaveLength(1);
  });

  test("under the alert, with checks registered, or with GitHub unreadable, nothing is asked", async () => {
    nmSays(CI_WAIT("59m"));
    await watcher().pass();
    expect(ciWaits()).toEqual([]);
    nmSays(CI_WAIT("2h"));
    checks = { state: "pending", checks: [{ name: "ci/test", state: "pending", detail: "queued" }] };
    await watcher().pass();
    expect(ciWaits()).toEqual([]);
    checks = new ForgeError("unreachable", "down");
    await watcher().pass();
    expect(ciWaits()).toEqual([]);
    alertMin = 0;
    checks = { state: "none", checks: [] };
    await watcher().pass();
    expect(ciWaits()).toEqual([]);
  });

  test("a CI fix round runs a local agent: not a wait", async () => {
    nmSays(CI_WAIT("2h").replace(',"",starting', ",4242,1"));
    await watcher().pass();
    expect(ciWaits()).toEqual([]);
  });

  test("a branch that already has main: merging changes nothing, so it recommends keep-waiting and says so", async () => {
    nmSays(CI_WAIT("2h"));
    await watcher().pass();
    const [d] = ciWaits();
    expect(d!.recommendation).toBe("keep-waiting");
    expect(d!.question).toContain("already has origin/main: merging changes nothing");
    expect(d!.question).not.toContain("no_ci");
  });

  test("merge-main steers the worker to merge and ship again, and settles this pipeline run; the next run is a new stall", async () => {
    mainAddsNoCi();
    nmSays(CI_WAIT("2h"));
    await watcher().pass();
    const [d] = ciWaits();
    answer(d!.id, "merge-main", "go ahead");
    const [steer] = steers();
    expect(steer).toContain(`The user chose merge-main for ${d!.id}`);
    expect(steer).toContain("git merge origin/main");
    expect(steer).toContain("never rebase or force-push");
    expect(steer).toContain("no-mistakes rerun");
    expect(steer).toContain('The user\'s words: "go ahead"');
    expect(openItems()).toEqual([]);
    now += 3 * 60 * 60_000;
    await watcher().pass();
    expect(ciWaits()).toHaveLength(1);
    nmSays(CI_WAIT("1h10m", "01NMNEXTRUN"));
    await watcher().pass();
    expect(ciWaits().map((x) => x.state)).toEqual(["answered", "open"]);
  });

  test("accept-without-ci steers the worker to end the CI wait and deliver, and the merge prompt can name it", async () => {
    nmSays(CI_WAIT("2h"));
    await watcher().pass();
    const [d] = ciWaits();
    expect(acceptedWithoutCi(db, "r1")).toBeNull();
    answer(d!.id, "accept-without-ci");
    const [steer] = steers();
    expect(steer).toContain("no-mistakes axi abort");
    expect(steer).toContain("deliver --pr");
    expect(acceptedWithoutCi(db, "r1")).toBe(d!.id);
  });

  test("keep-waiting sends no steer and asks again only after another alert period", async () => {
    nmSays(CI_WAIT("2h"));
    await watcher().pass();
    answer(ciWaits()[0]!.id, "keep-waiting");
    expect(steers()).toEqual([]);
    now += 59 * 60_000;
    await watcher().pass();
    expect(ciWaits()).toHaveLength(1);
    now += 60_000;
    await watcher().pass();
    const waits = ciWaits();
    expect(waits.map((x) => x.state)).toEqual(["answered", "open"]);
    expect(waits[1]!.key!.endsWith("-2")).toBe(true);
  });

  test("a wait that ends before an answer closes its question unanswered, with no steer", async () => {
    nmSays(CI_WAIT("2h"));
    await watcher().pass();
    nmSays(`run:\n  id: "01NMCIWAIT"\n  branch: b\n  status: completed\n  head: abc\n  pr: "${PR}"\noutcome: passed\n`);
    await watcher().pass();
    expect(ciWaits()[0]).toMatchObject({ state: "dismissed", answered_via: "watchdog" });
    expect(openItems()).toEqual([]);
    expect(steers()).toEqual([]);
  });

  test("a run that leaves validation (cancelled) closes its open question", async () => {
    nmSays(CI_WAIT("2h"));
    await watcher().pass();
    tx(db, () => db.query("UPDATE runs SET state = 'cancelled' WHERE id = 'r1'").run());
    await watcher().pass();
    expect(ciWaits()[0]!.state).toBe("dismissed");
    expect(openItems()).toEqual([]);
  });

  test("assumption: with no-mistakes' clock unreadable, the wait is timed from when flowrynd first saw it, across reads", async () => {
    nmSays(CI_WAIT(""));
    await watcher().pass();
    expect(ciWaits()).toEqual([]);
    now += 61 * 60_000;
    await watcher().pass();
    expect(ciWaits()).toHaveLength(1);
    expect(ciWaits()[0]!.question).toContain("waited 61 min");
  });
});

describe("CI-wait pieces", () => {
  test("ciWaitMinutes reads the ci step's active_for, else ci_since", () => {
    const nm = parseNmStatus(CI_WAIT("2h17m"))!;
    expect(ciWaitMinutes(nm, null, now)).toBe(137);
    expect(ciWaitMinutes(parseNmStatus(CI_WAIT(""))!, now - 90 * 60_000, now)).toBe(90);
    expect(ciWaitMinutes({ ...nm, outcome: "passed" }, null, now)).toBeNull();
  });

  test("no_ci is a top-level true, comments allowed", () => {
    expect(declaresNoCi("# x\nno_ci: true\n")).toBe(true);
    expect(declaresNoCi("no_ci: true # until CI is back\n")).toBe(true);
    expect(declaresNoCi("no_ci: false\n")).toBe(false);
    expect(declaresNoCi("# no_ci: true\n")).toBe(false);
    expect(declaresNoCi("  no_ci: true\n")).toBe(false);
    expect(declaresNoCi(null)).toBe(false);
  });

  test("keep-waiting and unknown answers carry no steer", () => {
    expect(ciWaitSteer("q1", "keep-waiting", null)).toBeNull();
    expect(ciWaitSteer("q1", "other", null)).toBeNull();
  });

  test("[validation] ci_wait_alert: default 60, 0 allowed, unknown keys and bad values refused", () => {
    const at = (text: string) => validationConfig(parseConfig(text, "/x/config.toml"));
    expect(at("")).toEqual({ ci_wait_alert: 60 });
    expect(at("[validation]\nci_wait_alert = 0\n")).toEqual({ ci_wait_alert: 0 });
    expect(() => at("[validation]\nci_wait_alert = -1\n")).toThrow("whole number of minutes");
    expect(() => at("[validation]\nci_wait_alert = 1.5\n")).toThrow("whole number of minutes");
    expect(() => at('[validation]\nci_wait_alert = "60m"\n')).toThrow("whole number of minutes");
    expect(() => at("[validation]\nci_wait = 5\n")).toThrow("not a known setting");
  });
});
