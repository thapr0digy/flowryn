import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { RESTART_HOLDS_VERIFIES_MS, restartHoldingVerifies } from "../../src/daemon/restart.ts";
import { migrate, openDb, setMeta, tx, type Db } from "../../src/db/db.ts";
import { MIGRATIONS } from "../../src/db/schema.ts";
import { ForgeError, type Forge, type PullRequest } from "../../src/forge/types.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease, liveJobLeases } from "../../src/sched/pools.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { verifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { cancelRequest, findQueued, getRequest, insertRequest, positionOf, queuedRequests, RECOVERED_RANK, requeuedFrom, type NewRequest } from "../../src/verify/queue.ts";
import { isVerifying, recoverVerifications, stopVerifications, type VerifyDeps } from "../../src/verify/runner.ts";
import { admitRequest, drainVerifyQueue, queueHold, waitingOn, type QueueDeps } from "../../src/verify/start.ts";
import { getVerification, insertVerification } from "../../src/verify/store.ts";
import { verificationView } from "../../src/verify/verbs.ts";
import { initialSteps } from "../../src/verify/runner.ts";

/**
 * The verify queue (docs/notes/2026-10-22-daemon-run-verify-y3.md), below the
 * daemon: the table, its order, the drain (FIFO up to the validation pool,
 * under the host check, held while a restart waits), cancellation of a request
 * whose PR closed or moved, and the rerun of a verification the daemon stopped.
 */

const dirs: string[] = [];
afterEach(() => {
  stopVerifications();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-vq-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const PR = (n: number) => `https://github.com/acme/web/pull/${n}`;

interface Fixture {
  db: Db;
  repo: string;
  head: string;
  root: string;
  logs: string[];
  /** What the fake GitHub says of each PR number. */
  prs: Map<number, Partial<PullRequest> | Error>;
  host: HostVerdict;
  config: FlowrynConfig;
  deps: QueueDeps;
  request(n: number, over?: Partial<NewRequest>): ReturnType<typeof insertRequest>;
}

function fixture(steps: string[] = ["true"], caps = "validation = 5"): Fixture {
  const dir = tempDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  db.exec(`INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', '${repo}', 'main', 'direct-PR')`);
  const config = parseConfig(`[projects.web]\nverify = ${JSON.stringify(steps)}\n[capacity]\n${caps}\n`, dir);
  const root = join(dir, "state", "verify");
  const logs: string[] = [];
  const prs = new Map<number, Partial<PullRequest> | Error>();
  const f: Fixture = {
    db,
    repo,
    head,
    root,
    logs,
    prs,
    host: { ok: true, sample: null, reason: "ok" },
    config,
    deps: null as unknown as QueueDeps,
    request(n, over = {}) {
      return tx(db, () =>
        insertRequest(db, { project_id: "web", pr_url: PR(n), task_id: null, head_sha: head, policy_id: verifyPolicyId(verifyConfig(config, "web")!), pr_number: n, head_ref: `b${n}`, worktree: null, source: "cli", path: null, now: Date.now(), ...over }),
      );
    },
  };
  const forge: Forge = {
    async pull(ref) {
      const pr = prs.get(ref.number) ?? {};
      if (pr instanceof Error) throw pr;
      return { number: ref.number, url: PR(ref.number), title: "t", state: "open", draft: false, headSha: head, headRef: `b${ref.number}`, headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true, ...pr };
    },
    pullsForBranch: async () => [],
    checks: async () => ({ state: "none", checks: [] }),
    annotations: async () => [],
    merge: async () => {
      throw new Error("no merges here");
    },
  };
  f.deps = {
    db,
    git: gitRunner("git", 30_000),
    now: Date.now,
    log: (m) => logs.push(m),
    root,
    config: () => f.config,
    forge: () => forge,
    webUrl: () => "https://github.com",
    projectPath: (id) => (id === "web" ? repo : null),
    host: async () => f.host,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  };
  return f;
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

async function settled(db: Db, ids: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (ids.some((id) => getVerification(db, id)?.state === "running" || isVerifying(id))) {
    if (Date.now() > deadline) throw new Error("verifications did not finish");
    await Bun.sleep(20);
  }
}

const CAPS = { validation: 5 };

describe("migration 29", () => {
  test("applies forward on a database at 28 and leaves verifications alone", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "flowryn.db"));
    migrate(db, MIGRATIONS.slice(0, 28));
    db.exec("INSERT INTO verifications (id, project_id, pr_url, head_sha, state, steps, dir, worktree_path, project_path, started_at) VALUES ('v1', 'web', 'u', 'h', 'passed', '[]', '/d', '/d/wt', '/p', 1)");
    expect(migrate(db)).toEqual([29]);
    expect(db.query("SELECT id, state FROM verifications").all()).toEqual([{ id: "v1", state: "passed" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM verify_queue").get()).toEqual({ n: 0 });
    expect(() => db.exec("INSERT INTO verify_queue (id, project_id, pr_url, head_sha, policy_id, source, state, requested_at) VALUES ('vq1', 'web', 'u', 'h', 'p', 'cli', 'running', 1)")).toThrow();
    db.close();
  });
});

describe("the queue", () => {
  test("FIFO within rank; a recovered request goes first; position and what is ahead; one queued request per PR, head and policy", () => {
    const f = fixture();
    const a = f.request(1);
    const b = f.request(2);
    const c = f.request(3, { rank: RECOVERED_RANK, source: "recovered", recovered_from: "v9" });
    expect(queuedRequests(f.db).map((r) => r.id)).toEqual([c.id, a.id, b.id]);
    expect(positionOf(f.db, b.id)).toEqual({ position: 3, of: 3, ahead: [c.id, a.id] });
    expect(findQueued(f.db, PR(2), f.head, b.policy_id)?.id).toBe(b.id);
    expect(findQueued(f.db, PR(2), f.head, "vp1:other")).toBeNull();
    expect(requeuedFrom(f.db, "v9")?.id).toBe(c.id);
    expect(events(f.db, "verify.queued").map((e) => [e.request, e.source, e.rank])).toEqual([
      [a.id, "cli", 0],
      [b.id, "cli", 0],
      [c.id, "recovered", -1],
    ]);
    // Cancelled once, with its reason; a second cancel records nothing.
    expect(tx(f.db, () => cancelRequest(f.db, a, "the PR closed", Date.now()))).toBe(true);
    expect(tx(f.db, () => cancelRequest(f.db, a, "again", Date.now()))).toBe(false);
    expect(getRequest(f.db, a.id)).toMatchObject({ state: "cancelled", detail: "the PR closed" });
    expect(positionOf(f.db, a.id)).toBeNull();
    expect(events(f.db, "verify.cancelled")).toHaveLength(1);
  });

  test("what a queued request waits on: the requests ahead, a restart, a full pool, the host check", () => {
    const f = fixture();
    const a = f.request(1);
    const b = f.request(2);
    const now = Date.now();
    expect(waitingOn(f.db, b, CAPS, now)).toBe(`behind ${a.id}`);
    expect(waitingOn(f.db, a, CAPS, now)).toBe("starting");
    tx(f.db, () => grantJobLease(f.db, { kind: "verify", id: "v7", taskId: null }, "validation", { validation: 1 }, now));
    expect(waitingOn(f.db, a, { validation: 1 }, now)).toBe("the validation pool is full (1/1: v7 (verify))");
    tx(f.db, () => setMeta(f.db, "restart_pending", JSON.stringify({ by: "auto", session: null, requested_at: now - 5 * 60_000, expires_at: now + 60_000, force: false })));
    expect(waitingOn(f.db, a, CAPS, now)).toBe("a daemon restart asked for 5 min ago waits for the running verifies first");
    expect(waitingOn(f.db, b, CAPS, now)).toBe(`behind ${a.id}`);
  });
});

describe("a restart holds queued verifies back, for a bounded time", () => {
  test("a parked request or a handoff holds them; after RESTART_HOLDS_VERIFIES_MS, or with none, nothing does", () => {
    const f = fixture();
    const now = Date.now();
    expect(restartHoldingVerifies(f.db, now)).toBeNull();
    tx(f.db, () => setMeta(f.db, "restart_pending", JSON.stringify({ by: "you", session: null, requested_at: now - 1_000, expires_at: now + 60_000, force: false })));
    expect(restartHoldingVerifies(f.db, now)).toEqual({ since: now - 1_000, by: "you" });
    expect(restartHoldingVerifies(f.db, now - 1_000 + RESTART_HOLDS_VERIFIES_MS)).toBeNull();
    f.db.exec("DELETE FROM meta WHERE key = 'restart_pending'");
    tx(f.db, () => setMeta(f.db, "restart_handoff", JSON.stringify({ by: "leader", session: "s", requested_at: now, old: {} })));
    expect(restartHoldingVerifies(f.db, now)).toEqual({ since: now, by: "leader" });
    expect(queueHold(f.db, CAPS, now)).toContain("a daemon restart asked for 0 min ago");
  });
});

describe("draining the queue", () => {
  test("starts requests in order up to the validation pool's cap; the rest wait their turn and start as slots free", async () => {
    const f = fixture(["sleep 0.3"], "validation = 2");
    const ids = [1, 2, 3].map((n) => f.request(n).id);
    expect(await drainVerifyQueue(f.deps)).toBe(2);
    expect(ids.map((id) => getRequest(f.db, id)!.state)).toEqual(["started", "started", "queued"]);
    expect(liveJobLeases(f.db).map((l) => l.job_id)).toEqual(["v1", "v2"]);
    expect(events(f.db, "verify.dequeued").map((e) => [e.request, e.verification])).toEqual([
      [ids[0], "v1"],
      [ids[1], "v2"],
    ]);
    await settled(f.db, ["v1", "v2"]);
    expect(await drainVerifyQueue(f.deps)).toBe(1);
    expect(getRequest(f.db, ids[2]!)).toMatchObject({ state: "started", verification_id: "v3" });
    await settled(f.db, ["v3"]);
    expect(["v1", "v2", "v3"].map((id) => getVerification(f.db, id)!.state)).toEqual(["passed", "passed", "passed"]);
  }, 30_000);

  test("assumption: jobs in one repository at once do not collide: each fetches its own PR head from origin, adds its worktree and prunes", async () => {
    const f = fixture(['test "$(git rev-parse HEAD)" = "$(git rev-parse HEAD)" && sleep 0.3']);
    // An origin with one PR head per number that the project's own repository does not have yet.
    const origin = join(tempDir(), "origin.git");
    git(f.repo, ["clone", "-q", "--bare", f.repo, origin]);
    git(f.repo, ["remote", "add", "origin", origin]);
    const work = join(tempDir(), "work");
    git(tempDir(), ["clone", "-q", origin, work]);
    const heads: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      git(work, ["checkout", "-q", "-B", `b${n}`, "main"]);
      writeFileSync(join(work, `f${n}.txt`), `${n}\n`);
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", `pr ${n}`]);
      const head = git(work, ["rev-parse", "HEAD"]);
      git(work, ["push", "-q", "origin", `HEAD:refs/pull/${n}/head`]);
      heads.push(head);
      f.prs.set(n, { headSha: head });
      f.request(n, { head_sha: head });
    }
    expect(await drainVerifyQueue(f.deps)).toBe(4);
    await settled(f.db, ["v1", "v2", "v3", "v4"]);
    expect(["v1", "v2", "v3", "v4"].map((id) => [getVerification(f.db, id)!.state, getVerification(f.db, id)!.head_sha])).toEqual(heads.map((h) => ["passed", h]));
    expect(git(f.repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
  }, 30_000);

  test("nothing starts while a restart is held, the host check fails, or the pool is full; the first request holds those behind it", async () => {
    const f = fixture();
    const a = f.request(1);
    f.request(2);
    tx(f.db, () => setMeta(f.db, "restart_pending", JSON.stringify({ by: "auto", session: null, requested_at: Date.now(), expires_at: Date.now() + 60_000, force: false })));
    expect(await drainVerifyQueue(f.deps)).toBe(0);
    f.db.exec("DELETE FROM meta WHERE key = 'restart_pending'");
    f.host = { ok: false, sample: null, reason: "2.0 GB available, under 8 GB" };
    expect(await drainVerifyQueue(f.deps)).toBe(0);
    f.host = { ok: true, sample: null, reason: "ok" };
    f.config = parseConfig('[projects.web]\nverify = ["true"]\n[capacity]\nvalidation = 1\n', tempDir());
    tx(f.db, () => grantJobLease(f.db, { kind: "verify", id: "v99", taskId: null }, "validation", { validation: 1 }, Date.now()));
    expect(await drainVerifyQueue(f.deps)).toBe(0);
    expect(queuedRequests(f.db)[0]!.id).toBe(a.id);
    expect(f.db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 0 });
  });

  test("a request whose PR closed, whose head moved, or whose project lost its verify steps is cancelled; a GitHub outage leaves it queued", async () => {
    const f = fixture();
    const closed = f.request(1);
    const moved = f.request(2);
    const outage = f.request(3);
    f.prs.set(1, { state: "closed" });
    f.prs.set(2, { headSha: "f".repeat(40) });
    f.prs.set(3, new ForgeError("unreachable", "connect ECONNREFUSED"));
    expect(await drainVerifyQueue(f.deps)).toBe(0);
    expect(getRequest(f.db, closed.id)).toMatchObject({ state: "cancelled", detail: `${PR(1)} is closed` });
    expect(getRequest(f.db, moved.id)).toMatchObject({ state: "cancelled", detail: `the PR head moved from ${f.head.slice(0, 8)} to ffffffff; verify the new head` });
    expect(getRequest(f.db, outage.id)!.state).toBe("queued");
    expect(f.logs.some((l) => l.includes(`verify ${outage.id}: waits: GitHub is unavailable`))).toBe(true);
    f.prs.delete(3);
    f.config = parseConfig("[projects.other]\nverify = [\"true\"]\n", tempDir());
    expect(await drainVerifyQueue(f.deps)).toBe(0);
    expect(getRequest(f.db, outage.id)).toMatchObject({ state: "cancelled", detail: "project web has no verify steps now" });
  });

  test("once the daemon is stopping, nothing starts; the queue is left as it was", async () => {
    const f = fixture();
    const a = f.request(1);
    let stopping = false;
    f.deps.stopped = () => stopping;
    stopping = true;
    expect(await drainVerifyQueue(f.deps)).toBe(0);
    expect(getRequest(f.db, a.id)!.state).toBe("queued");
    expect(f.db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 0 });
  });

  test("a request queued under an older policy follows a running verification of its PR and head under today's: no second job, no slot", async () => {
    const f = fixture(["sleep 0.3"]);
    const old = f.request(1, { policy_id: "vp1:queued-under-old-steps" });
    const fresh = f.request(1);
    expect(await drainVerifyQueue(f.deps)).toBe(1);
    expect(getRequest(f.db, old.id)).toMatchObject({ state: "started", verification_id: "v1" });
    expect(getRequest(f.db, fresh.id)).toMatchObject({ state: "started", verification_id: "v1" });
    expect(f.db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 1 });
    expect(liveJobLeases(f.db).map((l) => l.job_id)).toEqual(["v1"]);
    expect(events(f.db, "verify.dequeued").map((e) => [e.request, e.verification])).toEqual([
      [old.id, "v1"],
      [fresh.id, "v1"],
    ]);
    await settled(f.db, ["v1"]);
  }, 20_000);

  test("a request covered by a running verification follows it while the pool is full", async () => {
    const f = fixture(["sleep 0.3"], "validation = 1");
    const old = f.request(1, { policy_id: "vp1:queued-under-old-steps" });
    const fresh = f.request(1);
    const other = f.request(2);
    expect(await drainVerifyQueue(f.deps)).toBe(1);
    expect(getRequest(f.db, old.id)).toMatchObject({ state: "started", verification_id: "v1" });
    expect(getRequest(f.db, fresh.id)).toMatchObject({ state: "started", verification_id: "v1" });
    expect(getRequest(f.db, other.id)!.state).toBe("queued");
    expect(f.db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 1 });
    expect(liveJobLeases(f.db).map((l) => l.job_id)).toEqual(["v1"]);
    await settled(f.db, ["v1"]);
  }, 20_000);

  test("a start runs today's verify steps, whatever policy the request was queued under", async () => {
    const f = fixture(["true"]);
    const queued = f.request(1, { policy_id: "vp1:queued-under-old-steps" });
    expect(await drainVerifyQueue(f.deps)).toBe(1);
    const v = getVerification(f.db, getRequest(f.db, queued.id)!.verification_id!)!;
    expect(v.policy_id).toBe(verifyPolicyId(verifyConfig(f.config, "web")!));
    await settled(f.db, [v.id]);
  });
});

/** A request admitted as the last daemon left it: running row, slot, worktree, no process. */
function leftRunning(f: Fixture, request: ReturnType<typeof insertRequest>): string {
  const config = verifyConfig(f.config, "web")!;
  const v = tx(f.db, () => admitRequest(f.db, request, config, CAPS, f.root, f.repo, Date.now()));
  mkdirSync(v.dir, { recursive: true });
  git(f.repo, ["worktree", "add", "--detach", v.worktree_path, f.head]);
  return v.id;
}

describe("a verification the daemon stopped runs again", () => {
  test("startup recovery records the error and requeues it at the front, once; an interrupted rerun is left as an error", async () => {
    const f = fixture();
    const first = f.request(1);
    const id = leftRunning(f, first);
    const waiting = f.request(2);
    const deps: VerifyDeps = f.deps;
    expect(await recoverVerifications(deps)).toBe(1);
    expect(getVerification(f.db, id)).toMatchObject({ state: "error", detail: "the daemon stopped mid-run" });
    const rerun = requeuedFrom(f.db, id)!;
    expect(rerun).toMatchObject({ source: "recovered", rank: RECOVERED_RANK, pr_url: PR(1), head_sha: f.head, pr_number: 1, head_ref: "b1", state: "queued" });
    expect(queuedRequests(f.db).map((r) => r.id)).toEqual([rerun.id, waiting.id]);
    expect(verificationView(getVerification(f.db, id)!, Date.now(), f.db).requeued).toBe(rerun.id);

    // The rerun is interrupted too: it stays an error, and an event says why it was not queued again.
    tx(f.db, () => cancelRequest(f.db, waiting, "out of the way", Date.now()));
    const again = leftRunning(f, getRequest(f.db, rerun.id)!);
    expect(await recoverVerifications(deps)).toBe(1);
    expect(requeuedFrom(f.db, again)).toBeNull();
    expect(queuedRequests(f.db)).toEqual([]);
    expect(events(f.db, "verify.not_requeued")).toEqual([{ verification: again, request: rerun.id, reason: `${again} was already a rerun of ${id}` }]);
  });

  test("a job stopped with the daemon records itself and is requeued", async () => {
    const f = fixture(["sleep 5"]);
    const request = f.request(1);
    expect(await drainVerifyQueue(f.deps)).toBe(1);
    const id = getRequest(f.db, request.id)!.verification_id!;
    const deadline = Date.now() + 5_000;
    while (getVerification(f.db, id)!.steps[0]!.state !== "running") {
      if (Date.now() > deadline) throw new Error("the step never started");
      await Bun.sleep(20);
    }
    stopVerifications();
    await settled(f.db, [id]);
    expect(getVerification(f.db, id)).toMatchObject({ state: "error", detail: "the daemon stopped mid-run" });
    expect(requeuedFrom(f.db, id)).toMatchObject({ source: "recovered", state: "queued" });
  }, 20_000);

  test("a verification from before the queue (no request) is recorded as an error and not requeued", async () => {
    const f = fixture();
    const v = tx(f.db, () => {
      const row = insertVerification(f.db, { project_id: "web", pr_url: PR(1), task_id: null, head_sha: f.head, steps: initialSteps(["true"]), policy_id: "vp1:x", dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "cli", now: Date.now() });
      grantJobLease(f.db, { kind: "verify", id: row.id, taskId: null }, "validation", CAPS, Date.now());
      return row;
    });
    expect(await recoverVerifications(f.deps)).toBe(1);
    expect(getVerification(f.db, v.id)!.state).toBe("error");
    expect(queuedRequests(f.db)).toEqual([]);
  });
});
