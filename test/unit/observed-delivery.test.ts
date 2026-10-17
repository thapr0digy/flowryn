import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import type { Envelope, Reply } from "../../src/api/envelope.ts";
import { Gateway } from "../../src/api/gateway.ts";
import type { DaemonServices } from "../../src/api/verbs.ts";
import { inertAttention } from "../../src/attention/services.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { inertRestart } from "../../src/daemon/restart.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { ChecksSummary, Forge, PullRequest } from "../../src/forge/types.ts";
import { Journal } from "../../src/journal/journal.ts";
import { BacklogWatcher } from "../../src/journal/watcher.ts";
import { inertLavish } from "../../src/lavish/services.ts";
import { deliveredOf, recordDelivery } from "../../src/lifecycle/delivery.ts";
import { inertFleet } from "../../src/lifecycle/fleet-services.ts";
import { deliveryBasis, deliveryTransition, staleBasis } from "../../src/lifecycle/observed.ts";
import { requestCancel } from "../../src/lifecycle/operations.ts";
import { cancelRun, getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { LANDED_BEFORE_CANCEL } from "../../src/lifecycle/landing.ts";
import { sendBack } from "../../src/lifecycle/send-back.ts";
import { WORKER_VERBS } from "../../src/lifecycle/worker.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { landRun } from "../../src/lifecycle/landing.ts";
import { getOperation } from "../../src/lifecycle/operations.ts";
import type { GitRunner } from "../../src/policy/landed.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { POLICY_VERBS } from "../../src/policy/verbs.ts";
import { inertSched } from "../../src/sched/services.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { DeliveryWatcher } from "../../src/watch/delivery.ts";

/**
 * Guarded delivery and stage-progression observations
 * (docs/notes/2026-10-13-next-steps-md-av.md): each race pauses an
 * observation (a GitHub read, a git read, a no-mistakes status read) on an
 * explicit barrier, lands a newer change (a redelivery, a cancel, a send-back,
 * a new validation slot), then releases it. The old result must write nothing
 * but a run.observation_stale event. Each race has a control: the same
 * observation with nothing newer still applies.
 */

const WEB = "https://github.com";
const PR_URL = `${WEB}/acme/web/pull/7`;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const MERGED = "c".repeat(40);
const MIN = 60_000;

let dir: string;
let db: Db;
let now: number;
let runToken: string;
let gateway: Gateway;
let cleaned: string[];
let services: DaemonServices;

/** A barrier an observation parks on: `reached` once it is held, `open()` lets it through. */
function barrier() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const held = new Promise<void>((resolve) => (reached = resolve));
  return {
    reached: held,
    open,
    hold<T>(value: () => T): Promise<T> {
      reached();
      return opened.then(value);
    },
  };
}
type Barrier = ReturnType<typeof barrier>;

function pr(head: string, extra: Partial<PullRequest> = {}): PullRequest {
  return { number: 7, url: PR_URL, title: "t", state: "open", draft: false, headSha: head, headRef: "b", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true, ...extra };
}

const GREEN: ChecksSummary = { state: "green", checks: [{ name: "ci", state: "green", detail: "success" }] } as ChecksSummary;
const NO_CHECKS: ChecksSummary = { state: "none", checks: [] } as unknown as ChecksSummary;

/** The fake forge: what GitHub says now, and an optional barrier the next pull or checks read parks on. */
const github = {
  pr: pr(HEAD_A),
  checks: GREEN as ChecksSummary,
  pullGate: null as Barrier | null,
  checksGate: null as Barrier | null,
  mergeGate: null as Barrier | null,
};
const forge = {
  pull: async (): Promise<PullRequest> => {
    const said = { ...github.pr };
    const gate = github.pullGate;
    github.pullGate = null;
    return gate ? gate.hold(() => said) : said;
  },
  checks: async (): Promise<ChecksSummary> => {
    const said = github.checks;
    const gate = github.checksGate;
    github.checksGate = null;
    return gate ? gate.hold(() => said) : said;
  },
  merge: async (): Promise<{ merged: boolean; message: string }> => {
    const merged = () => {
      github.pr = { ...github.pr, state: "merged", mergeSha: MERGED, mergeable: null };
      return { merged: true, message: "merged" };
    };
    const gate = github.mergeGate;
    github.mergeGate = null;
    return gate ? gate.hold(merged) : merged();
  },
} as unknown as Forge;

/** The fake git: the worktree's HEAD and the remote's head of the run branch, as a delivery reads them; a barrier for the next call. */
const repo = { head: HEAD_A, remote: HEAD_A, onDefault: true, gate: null as Barrier | null };
const git: GitRunner = async (args) => {
  const answer = () => {
    if (args[0] === "ls-remote") return { code: 0, stdout: `${repo.remote}\trefs/heads/b\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${repo.head}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${MERGED}\n`, stderr: "" };
    if (args[0] === "merge-base") return { code: repo.onDefault ? 0 : 1, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "not faked" };
  };
  const gate = repo.gate;
  repo.gate = null;
  return gate ? gate.hold(answer) : answer();
};

/** What the next no-mistakes status read prints, and a barrier it parks on. */
const nm = { text: "run: null\n", gate: null as Barrier | null };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-observed-delivery-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  now = Date.now();
  cleaned = [];
  github.pr = pr(HEAD_A);
  github.checks = GREEN;
  github.pullGate = github.checksGate = github.mergeGate = null;
  Object.assign(repo, { head: HEAD_A, remote: HEAD_A, onDefault: true, gate: null });
  Object.assign(nm, { text: "run: null\n", gate: null });
  runToken = mintToken("run");
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web', ?1, 'main', 'no-mistakes')").run(dir);
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'ship', 'no-mistakes', 1, 'fix', ?1)").run(now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'ship', 'active', ?1, 'b', 's', ?2, ?3, ?3)`,
    ).run(dir, hashToken(runToken), now);
  });
  const config = defaultConfig(dir);
  const files = () => ({ backlog: join(dir, "b.md"), todos: join(dir, "t.md") });
  const journal = new Journal({ db, files, runner: () => null });
  const info = () => ({ pid: 1, version: "t", proto: PROTO, instance: "i", startedAt: 0, execPath: "/bin/flowryn", socket: "/s", stateDir: dir });
  services = {
    db,
    config: () => config,
    journal,
    watcher: new BacklogWatcher({ db, journal, files, runner: () => null }),
    now: () => now,
    log: () => {},
    info,
    requestShutdown: () => {},
    runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fleet: inertFleet(),
    attention: inertAttention(),
    delivery: inertDelivery({ forge: () => forge, git, cleanup: (runId) => {
        cleaned.push(runId);
        return Promise.reject(new Error("no cleanup runner in this test"));
      },
    }),
    sched: inertSched(),
    restart: inertRestart(db, info),
    lavish: inertLavish(),
  };
  const verbs = new Map([...WORKER_VERBS, ...POLICY_VERBS, ...LEADER_RUN_VERBS].map((v) => [v.name, v]));
  gateway = new Gateway({ services, lookup: (v) => verbs.get(v) });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(verb: string, args: Record<string, unknown>, who: "worker" | "human"): Promise<Reply> {
  const env: Envelope = { proto: PROTO, ulid: ulid(), verb, args, ...(who === "worker" ? { token: runToken } : { token: null, channel: "tty" }) };
  return gateway.handle(env);
}

function watcher(opts: { nudgeConflicts?: boolean; ciWaitAlertMin?: number; git?: GitRunner; headFetchGit?: GitRunner } = {}): DeliveryWatcher {
  return new DeliveryWatcher({
    db,
    forge: () => forge,
    webUrl: () => WEB,
    git: opts.git ?? git,
    headFetchGit: opts.headFetchGit,
    noMistakes: () => "no-mistakes",
    readNmStatus: async () => {
      const text = nm.text;
      const gate = nm.gate;
      nm.gate = null;
      return gate ? gate.hold(() => ({ code: 0, text })) : { code: 0, text };
    },
    nmTimeoutMs: () => 5_000,
    validationStuckMs: () => 30 * MIN,
    pollMs: () => 60_000,
    ciWaitAlertMin: () => opts.ciWaitAlertMin ?? 0,
    inFlight: new Set(),
    cleanup: (runId) => cleaned.push(runId),
    nudgeConflicts: () => opts.nudgeConflicts ?? false,
    kickScheduler: () => {},
    log: () => {},
    now: () => now,
  });
}

/** What the deliver verb records for a verified PR at `head` (the worker's newer delivery). */
function deliverAt(head: string): void {
  tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r1")!, { kind: "pr", pr: pr(head), checks: GREEN, url: PR_URL }, "socket", now));
  db.query("UPDATE runs SET stage_state = 'done' WHERE id = 'r1'").run();
}

/** A run delivered at HEAD_A: ready, its last stage done. */
function readyAtA(): void {
  deliverAt(HEAD_A);
}

function cancelOperation(): { phase: string; detail: string | null } | null {
  return db.query("SELECT phase, detail FROM operations WHERE run_id = 'r1' AND kind = 'cancel'").get() as { phase: string; detail: string | null } | null;
}

function cancelRequested(): void {
  tx(db, () => requestCancel(db, { id: "r1", task_id: "t1" }, { id: ulid(), by: "human", reason: "you cancelled it", source: "cli", now }));
}

/** A validation slot granted `ago` ms before now, the older one (if any) released. */
function newValidationSlot(ago = 0): void {
  tx(db, () => {
    db.query("UPDATE pool_leases SET released_at = ?2 WHERE run_id = ?1 AND pool = 'validation' AND released_at IS NULL").run("r1", now);
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r1', 'ship', ?1)").run(now - ago);
  });
}

function state(): string {
  return (db.query("SELECT state FROM runs WHERE id = 'r1'").get() as { state: string }).state;
}

function staleEvents(): { transition: string; changed: Record<string, unknown> }[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'run.observation_stale' AND run_id = 'r1' ORDER BY seq").all() as { payload: string }[]).map(
    (row) => JSON.parse(row.payload) as { transition: string; changed: Record<string, unknown> },
  );
}

function count(kind: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE run_id = 'r1' AND kind = ?1").get(kind) as { n: number }).n;
}

function openItemKinds(): string[] {
  return (db.query("SELECT kind FROM items WHERE run_id = 'r1' AND state IN ('open','presented') ORDER BY kind").all() as { kind: string }[]).map((r) => r.kind);
}

/** `axi status` with one active step quiet for `quiet`, in the v1.53.0 shape. */
function stalled(quiet: string): string {
  return ["run:", '  id: "01NMOLD"', "  branch: b", "  status: running", "  head: abc", "  active_steps[1]{step,status,active_for,last_activity,agent_pid,round}:", `    review,running,3h,"${quiet} ago: agent: reading",81234,1`, ""].join("\n");
}

const CI_WAIT = `run:
  id: "01NMCIWAIT"
  branch: b
  status: running
  head: abc
  pr: "${PR_URL}"
  active_steps[1]{step,status,active_for,last_activity,agent_pid,round}:
    ci,running,2h,"1m ago: log: waiting for checks to register","",starting
`;

function ciWaits(): number {
  return (db.query("SELECT COUNT(*) AS n FROM decisions WHERE origin = 'ci-wait'").get() as { n: number }).n;
}

/** A local-only run merging at HEAD_A under a yolo approval, its merge requested and not in flight. */
function merging(): void {
  tx(db, () => {
    db.query("UPDATE projects SET delivery_mode = 'local-only' WHERE id = 'web'").run();
    db.query("UPDATE task_policy SET delivery_mode = 'local-only' WHERE task_id = 't1'").run();
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 't1', 'local', 'b', ?1, ?2)").run(HEAD_A, now);
    db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at) VALUES ('ap1', 't1', 'local:b', ?1, 'yolo', 'yolo', 'merge', ?2, ?3)").run(HEAD_A, now, now + MIN);
    db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state) VALUES ('mg1', 't1', 'local:b', ?1, 'ap1', ?2, 'requested')").run(HEAD_A, now);
    db.query("UPDATE runs SET state = 'merging', stage_state = 'done' WHERE id = 'r1'").run();
  });
}

function mergeState(): string {
  return (db.query("SELECT state FROM merges WHERE id = 'mg1'").get() as { state: string }).state;
}

describe("the delivery basis", () => {
  test("assumption: a part not named by the transition never makes it stale", () => {
    readyAtA();
    const seen = deliveryBasis(db, "r1");
    newValidationSlot();
    expect(staleBasis(seen, deliveryBasis(db, "r1"), ["state", "delivered"])).toEqual({});
    expect(Object.keys(staleBasis(seen, deliveryBasis(db, "r1"), ["validation"]))).toEqual(["validation"]);
  });

  test("assumption: a terminal run is stale even when its state was not named", () => {
    readyAtA();
    const seen = deliveryBasis(db, "r1");
    db.query("UPDATE runs SET state = 'cancelled' WHERE id = 'r1'").run();
    expect(staleBasis(seen, deliveryBasis(db, "r1"), ["delivered"])).toEqual({ state: { seen: "ready", current: "cancelled" } });
  });

  test("assumption: a hook on a delivered run (liveness, busy lease) is not part of the basis", () => {
    readyAtA();
    const seen = deliveryBasis(db, "r1");
    db.query("UPDATE runs SET liveness = 'idle', last_hook_at = ?1, busy_until = NULL, idle_since = ?1 WHERE id = 'r1'").run(now + 1);
    const applied = deliveryTransition(db, seen, ["state", "stage", "stage_state", "delivered", "merge", "operation", "validation"], "test", "daemon", now, () => "ok");
    expect(applied).toEqual({ applied: true, value: "ok" });
  });

  test("a stale transition writes only its event, naming each changed part", () => {
    readyAtA();
    const seen = deliveryBasis(db, "r1");
    deliverAt(HEAD_B);
    let ran = false;
    const result = deliveryTransition(db, seen, ["delivered"], "test", "daemon", now, () => (ran = true));
    expect(ran).toBe(false);
    expect(result.applied).toBe(false);
    expect(staleEvents()).toEqual([{ transition: "test", changed: { delivered: { seen: `pr ${PR_URL} ${HEAD_A}`, current: `pr ${PR_URL} ${HEAD_B}` } } }]);
  });
});

describe("pr_observation: the PR watcher", () => {
  test("control: a conflicting PR at the delivered head sends the ship back", async () => {
    readyAtA();
    github.pr = pr(HEAD_A, { mergeable: false });
    await watcher({ nudgeConflicts: true }).pass();
    expect(count("run.conflict_nudged")).toBe(1);
    expect(state()).toBe("running");
  });

  test("a redelivery at a new head during a conflicting read: no nudge, the new delivery stands", async () => {
    readyAtA();
    github.pr = pr(HEAD_A, { mergeable: false });
    github.pullGate = barrier();
    const gate = github.pullGate;
    const pass = watcher({ nudgeConflicts: true }).pass();
    await gate.reached;
    deliverAt(HEAD_B);
    gate.open();
    await pass;
    expect(count("run.conflict_nudged")).toBe(0);
    expect(state()).toBe("ready");
    expect(deliveredOf(db, "t1")!.head).toBe(HEAD_B);
    expect(openItemKinds()).not.toContain("conflict_nudged");
    expect(db.query("SELECT COUNT(*) AS n FROM divergences WHERE run_id = 'r1'").get()).toEqual({ n: 0 });
    expect(staleEvents()).toEqual([{ transition: "pr_observation", changed: { delivered: { seen: `pr ${PR_URL} ${HEAD_A}`, current: `pr ${PR_URL} ${HEAD_B}` } } }]);
  });

  test("a moved head's PR-ref fetch goes through the short-deadline runner; its cut-off is ancestry unknown", async () => {
    readyAtA();
    github.pr = pr(HEAD_B);
    const calls: { runner: string; verb: string }[] = [];
    // This copy has the delivered head but not the moved one, so the check must fetch it.
    const local: GitRunner = async (args, cwd) => {
      calls.push({ runner: "git", verb: args[0]! });
      if (args[0] === "cat-file") return { code: args[2] === `${HEAD_A}^{commit}` ? 0 : 1, stdout: "", stderr: "" };
      return git(args, cwd);
    };
    const shortFetch: GitRunner = async (args) => {
      calls.push({ runner: "fetch", verb: args[0]! });
      return { code: 124, stdout: "", stderr: "timed out" };
    };
    await watcher({ git: local, headFetchGit: shortFetch }).pass();
    expect(calls.filter((c) => c.verb === "fetch")).toEqual([{ runner: "fetch", verb: "fetch" }]);
    expect(calls.filter((c) => c.runner === "fetch").map((c) => c.verb)).toEqual(["fetch"]);
    const summaries = (db.query("SELECT summary FROM divergences WHERE run_id = 'r1'").all() as { summary: string }[]).map((r) => r.summary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("ancestry unknown");
  });

  test("control: a PR read merged lands the ready run", async () => {
    readyAtA();
    github.pr = pr(HEAD_A, { state: "merged", mergeSha: MERGED, mergeable: null });
    await watcher().pass();
    expect(state()).toBe("landed");
    // The landing asks for its cleanup; the same pass's resumeCleanups asks again (the fake never records one).
    expect(cleaned).toContain("r1");
  });

  test("assumption: a proven merge wins over a cancel requested during the read: the run lands, the cancel ends as a no-op", async () => {
    readyAtA();
    github.pr = pr(HEAD_A, { state: "merged", mergeSha: MERGED, mergeable: null });
    github.pullGate = barrier();
    const gate = github.pullGate;
    const pass = watcher().pass();
    await gate.reached;
    cancelRequested();
    gate.open();
    await pass;
    expect(state()).toBe("landed");
    expect(cleaned).toContain("r1");
    expect(cancelOperation()).toEqual({ phase: "failed", detail: `${LANDED_BEFORE_CANCEL} (merge ${MERGED.slice(0, 8)})` });
    expect(staleEvents()).toEqual([]);
  });

  test("a merged read whose run was cancelled meanwhile: the run is not revived, the merge is kept as a divergence", async () => {
    readyAtA();
    github.pr = pr(HEAD_A, { state: "merged", mergeSha: MERGED, mergeable: null });
    github.pullGate = barrier();
    const gate = github.pullGate;
    const pass = watcher().pass();
    await gate.reached;
    tx(db, () => cancelRun(db, getRunWithPolicy(db, "r1")!, "you cancelled it", "cli", now));
    gate.open();
    await pass;
    expect(state()).toBe("cancelled");
    expect(cleaned).toEqual([]);
    expect(count("run.merged_after_end")).toBe(1);
    expect(db.query("SELECT higher, lower FROM divergences WHERE run_id = 'r1' AND resolved_at IS NULL").all()).toEqual([{ higher: "github", lower: "run" }]);
  });
});

describe("a cancel a landing overtook", () => {
  test("flowryn cancel says the run landed and nothing was cancelled", async () => {
    readyAtA();
    // The worker's stop takes a moment; the merge is proven and the run lands meanwhile (as the watcher or merge verb would).
    services.fleet = {
      ...services.fleet,
      driveCancel: async (id) => {
        tx(db, () => landRun(db, getRunWithPolicy(db, "r1")!, { mergeSha: MERGED, how: "merged_elsewhere", by: "other" }, now));
        const op = getOperation(db, id)!;
        return { ok: false, phase: op.phase, evidence: "process", detail: op.detail ?? op.phase };
      },
    };
    const reply = await call("cancel", { target: "t1" }, "human");
    expect(reply.error).toMatchObject({ code: "run_not_active", message: `t1: ${LANDED_BEFORE_CANCEL} (merge ${MERGED.slice(0, 8)}); nothing was cancelled` });
    expect(state()).toBe("landed");
  });

  test("a cancel of a run that already landed is refused: the run stays landed and no cancel is recorded", async () => {
    readyAtA();
    tx(db, () => landRun(db, getRunWithPolicy(db, "r1")!, { mergeSha: MERGED, how: "merged_elsewhere", by: "other" }, now));
    const reply = await call("cancel", { target: "t1" }, "human");
    expect(reply.error).toMatchObject({ code: "run_not_active", message: "t1 landed: its merge is proven and stands; nothing was cancelled" });
    expect(state()).toBe("landed");
    expect(db.query("SELECT COUNT(*) AS n FROM operations WHERE run_id = 'r1' AND kind = 'cancel'").get()).toEqual({ n: 0 });
  });
});

describe("merge: the merge verb's gate reads", () => {
  test("control: a yolo merge with green checks is requested at the delivered head", async () => {
    readyAtA();
    // No GitHub merge in this test: the request is what is checked.
    const reply = await call("merge", { task: "t1" }, "human");
    expect(db.query("SELECT head_sha FROM merges WHERE task_id = 't1'").all()).toEqual([{ head_sha: HEAD_A }]);
    expect(reply.ok || reply.error?.code === "not_landed").toBe(true);
  });

  test("a redelivery while the gate reads GitHub: nothing is requested, the caller is told to merge again", async () => {
    readyAtA();
    github.pullGate = barrier();
    const gate = github.pullGate;
    const replying = call("merge", { task: "t1" }, "human");
    await gate.reached;
    deliverAt(HEAD_B);
    gate.open();
    const reply = await replying;
    expect(reply.error).toMatchObject({ code: "observation_stale", help: "flowryn merge t1 again" });
    expect(db.query("SELECT COUNT(*) AS n FROM merges").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM approvals WHERE consumed_at IS NOT NULL").get()).toEqual({ n: 0 });
    expect(state()).toBe("ready");
    expect(staleEvents().map((e) => [e.transition, Object.keys(e.changed)])).toEqual([["merge", ["delivered"]]]);
  });
});

describe("merge: a proven merge after the run ended", () => {
  test("a PR GitHub already reads merged, the run cancelled during the gate's read: not revived, the merge is kept as a divergence", async () => {
    readyAtA();
    github.pr = pr(HEAD_A, { state: "merged", mergeSha: MERGED, mergeable: null });
    github.pullGate = barrier();
    const gate = github.pullGate;
    const replying = call("merge", { task: "t1" }, "human");
    await gate.reached;
    tx(db, () => cancelRun(db, getRunWithPolicy(db, "r1")!, "you cancelled it", "cli", now));
    gate.open();
    const reply = await replying;
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ merged: "after_end", run_state: "cancelled", sha: MERGED });
    expect(reply.data).not.toHaveProperty("state");
    expect(state()).toBe("cancelled");
    expect(cleaned).toEqual([]);
    expect(staleEvents()).toEqual([]);
    expect(count("run.merged_after_end")).toBe(1);
    expect(db.query("SELECT higher, lower FROM divergences WHERE run_id = 'r1' AND resolved_at IS NULL").all()).toEqual([{ higher: "github", lower: "run" }]);
  });

  test("the run cancelled while GitHub merges: the merge is proven, the run not revived, a divergence asks", async () => {
    readyAtA();
    github.mergeGate = barrier();
    const gate = github.mergeGate;
    const replying = call("merge", { task: "t1" }, "human");
    await gate.reached;
    tx(db, () => cancelRun(db, getRunWithPolicy(db, "r1")!, "you cancelled it", "cli", now));
    gate.open();
    const reply = await replying;
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ merged: "after_end", run_state: "cancelled", state: "merged", sha: MERGED });
    expect(db.query("SELECT state, merge_sha FROM merges WHERE task_id = 't1'").all()).toEqual([{ state: "merged", merge_sha: MERGED }]);
    expect(state()).toBe("cancelled");
    expect(cleaned).toEqual([]);
    expect(count("run.landed")).toBe(0);
    expect(count("run.merged_after_end")).toBe(1);
    expect(db.query("SELECT higher, lower FROM divergences WHERE run_id = 'r1' AND resolved_at IS NULL").all()).toEqual([{ higher: "github", lower: "run" }]);
  });
});

describe("deliver: the named-head gate's reads", () => {
  test("control: a delivery verified at its head is recorded", async () => {
    const reply = await call("deliver", { pr: PR_URL }, "worker");
    expect(reply.ok).toBe(true);
    expect(deliveredOf(db, "t1")!.head).toBe(HEAD_A);
  });

  test("a newer delivery commits while an older one is verified: the newer stands", async () => {
    github.checksGate = barrier();
    const gate = github.checksGate;
    const older = call("deliver", { pr: PR_URL }, "worker");
    await gate.reached;
    github.pr = pr(HEAD_B);
    repo.head = repo.remote = HEAD_B;
    const newer = await call("deliver", { pr: PR_URL }, "worker");
    expect(newer.ok).toBe(true);
    gate.open();
    const reply = await older;
    expect(reply.error).toMatchObject({ code: "observation_stale" });
    expect(deliveredOf(db, "t1")!.head).toBe(HEAD_B);
    expect(count("run.delivered")).toBe(1);
    expect(staleEvents().map((e) => [e.transition, Object.keys(e.changed).toSorted()])).toEqual([["deliver", ["delivered", "stage_state", "state"]]]);
  });

  test("a send-back while a redelivery is verified: the run stays sent back", async () => {
    readyAtA();
    github.pr = pr(HEAD_B);
    repo.head = repo.remote = HEAD_B;
    github.checksGate = barrier();
    const gate = github.checksGate;
    const replying = call("deliver", { pr: PR_URL }, "worker");
    await gate.reached;
    tx(db, () =>
      sendBack(db, getRunWithPolicy(db, "r1")!, { text: "change it", feedback: "declined", why: "the delivery was declined", event: { source: "cli", kind: "run.declined", payload: {} } }, now),
    );
    gate.open();
    const reply = await replying;
    expect(reply.error).toMatchObject({ code: "observation_stale" });
    expect(state()).toBe("running");
    expect(deliveredOf(db, "t1")!.head).toBe(HEAD_A);
    expect(staleEvents()[0]!.transition).toBe("deliver");
  });
});

describe("nm_observation: the no-mistakes status read", () => {
  test("control: a step quiet past the threshold opens validation_stuck and the run is validating", async () => {
    newValidationSlot(60 * MIN);
    nm.text = stalled("2h");
    await watcher().pass();
    expect(state()).toBe("validating");
    expect(openItemKinds()).toContain("validation_stuck");
  });

  test("a new validation slot during a stalled read: no stuck episode for the new slot", async () => {
    newValidationSlot(60 * MIN);
    nm.text = stalled("2h");
    nm.gate = barrier();
    const gate = nm.gate;
    const pass = watcher().pass();
    await gate.reached;
    newValidationSlot();
    gate.open();
    await pass;
    expect(state()).toBe("running");
    expect(openItemKinds()).not.toContain("validation_stuck");
    expect(count("run.validation_stuck")).toBe(0);
    expect(staleEvents().map((e) => [e.transition, Object.keys(e.changed)])).toEqual([["nm_observation", ["validation"]]]);
  });
});

describe("ci_wait: the CI-wait watchdog's reads", () => {
  test("control: a pipeline waiting on CI with no checks asks the user", async () => {
    newValidationSlot(5 * MIN);
    nm.text = CI_WAIT;
    github.checks = NO_CHECKS;
    await watcher({ ciWaitAlertMin: 1 }).pass();
    expect(ciWaits()).toBe(1);
  });

  test("a stage restarted with a new slot while the check count is read: no question", async () => {
    newValidationSlot(5 * MIN);
    nm.text = CI_WAIT;
    github.checks = NO_CHECKS;
    github.pullGate = barrier();
    const gate = github.pullGate;
    const pass = watcher({ ciWaitAlertMin: 1 }).pass();
    await gate.reached;
    db.query("UPDATE runs SET state = 'running', stage_state = 'waiting' WHERE id = 'r1'").run();
    newValidationSlot();
    gate.open();
    await pass;
    expect(ciWaits()).toBe(0);
    expect(staleEvents().map((e) => e.transition)).toEqual(["ci_wait"]);
  });
});

describe("local_merge_proof: a local-only merge's proof", () => {
  test("control: the head on the local default branch proves the merge and lands the run", async () => {
    merging();
    await watcher().pass();
    expect(mergeState()).toBe("merged");
    expect(state()).toBe("landed");
    // The landing asks for its cleanup; the same pass's resumeCleanups asks again (the fake never records one).
    expect(cleaned).toContain("r1");
  });

  test("assumption: a proven local merge wins over a cancel requested while the proof is read", async () => {
    merging();
    repo.gate = barrier();
    const gate = repo.gate;
    const pass = watcher().pass();
    await gate.reached;
    cancelRequested();
    gate.open();
    await pass;
    expect(mergeState()).toBe("merged");
    expect(state()).toBe("landed");
    expect(cleaned).toContain("r1");
    expect(cancelOperation()!.phase).toBe("failed");
    expect(staleEvents()).toEqual([]);
  });

  test("an unproven local merge read while a cancel is requested is still dropped", async () => {
    merging();
    repo.onDefault = false;
    repo.gate = barrier();
    const gate = repo.gate;
    const pass = watcher().pass();
    await gate.reached;
    cancelRequested();
    gate.open();
    await pass;
    expect(mergeState()).toBe("requested");
    expect(openItemKinds()).not.toContain("unproven_merge");
    expect(staleEvents().map((e) => [e.transition, Object.keys(e.changed)])).toEqual([["local_merge_proof", ["operation"]]]);
  });
});
