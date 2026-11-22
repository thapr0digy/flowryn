import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { answerDecision } from "../../src/lifecycle/decision-verbs.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import { insertApproval } from "../../src/policy/approvals.ts";
import { countersignOf } from "../../src/policy/countersign.ts";
import { verifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { finishVerification, insertVerification, type Verification } from "../../src/verify/store.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { prepareDaemonMerge, type MergeServices } from "../../src/policy/merge-path.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { GIT_ENV, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * The merge gate's countersign for a fix that loosens a gate (docs/notes/2026-11-22-phase-countersign-gate-7e.md),
 * with real git on a local-only project: the gate the daemon's auto-merge and the landing line run
 * (prepareDaemonMerge). The project has verify steps unless a test says otherwise; a passed verify at
 * the head is the verifier's proof. test/unit/landing-batch.test.ts covers a batch's fix-forward.
 */

const VERIFY = '[projects.web]\nverify = ["true"]\n';

const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

let dir: string;
let db: Db;
let primary: string;
let now: number;
let configText: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-countersign-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  primary = scratchRepos(dir).primary;
  now = 1_000_000;
  configText = VERIFY;
  mkdirSync(join(primary, "ui"), { recursive: true });
  writeFileSync(join(primary, "ui", "budget.json"), '{ "brief": 228 }\n');
  sh(primary, ["add", "."]);
  sh(primary, ["commit", "-q", "-m", "budget"]);
  tx(db, () => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', '', ?1, 'main', 'local-only', 1)").run(primary));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A delivered local-only ship on `workflow`, one commit of `files` on a branch from main. */
function ship(n: number, files: Record<string, string>, opts: { workflow?: string; sensitive?: boolean } = {}): { task: string; head: string } {
  const task = `t${n}`;
  const wt = join(dir, `wt-${task}`);
  const workflow = opts.workflow ?? "fix";
  sh(primary, ["worktree", "add", "-q", "-b", `flowryn/${task}`, wt, "main"]);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(wt, file), text);
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-q", "-m", "fix"]);
  const head = sh(wt, ["rev-parse", "HEAD"]);
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 1, ?2, ?3, 0)").run(task, opts.sensitive ? 1 : 0, workflow);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'ready', 'idle', ?3, 'ship', 'done', ?4, ?5, 'abc', ?1, 1, 1)`,
    ).run(`r${n}`, task, workflow, wt, `flowryn/${task}`);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'local', ?3, ?4, 1)").run(`a${n}`, task, `flowryn/${task}`, head);
    appendEvent(db, { source: "cli", kind: "run.delivered", runId: `r${n}`, taskId: task, payload: {}, ts: 1 });
  });
  return { task, head };
}

/** The task's worktree moves on with one more commit of `files`, delivered as its new head. */
function redeliver(n: number, files: Record<string, string>): string {
  const task = `t${n}`;
  const wt = join(dir, `wt-${task}`);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(wt, file), text);
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-q", "-m", "fix again"]);
  const head = sh(wt, ["rev-parse", "HEAD"]);
  tx(db, () => {
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'local', ?3, ?4, 2)").run(`a${n}b`, task, `flowryn/${task}`, head);
    appendEvent(db, { source: "cli", kind: "run.delivered", runId: `r${n}`, taskId: task, payload: {}, ts: 2 });
  });
  return head;
}

/** A verify of the task's head that passed under today's verify steps: the verifier's proof. */
function verified(task: string, head: string): Verification {
  const policy = verifyPolicyId(verifyConfig(parseConfig(configText, dir), "web")!);
  return tx(db, () => {
    const v = insertVerification(db, { project_id: "web", pr_url: `local:flowryn/${task}`, task_id: task, head_sha: head, steps: [], policy_id: policy, dir: (id) => join(dir, "v", id), worktree: (id) => join(dir, `vwt-${id}`), project_path: primary, source: "daemon", now });
    finishVerification(db, v, { state: "passed", steps: [], tests: null, detail: null, binary: null }, now + 1);
    return v;
  });
}

const services: () => MergeServices = () => ({ db, config: () => parseConfig(configText, dir), delivery: inertDelivery({ git }), now: () => now, log: () => {} });

async function refusal(task: string): Promise<FlowrynError> {
  try {
    await prepareDaemonMerge(services(), task);
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error(`${task} passed the gate`);
}

async function gate(task: string): Promise<string> {
  try {
    await prepareDaemonMerge(services(), task);
    return "passed";
  } catch (error) {
    if (error instanceof FlowrynError) return error.code;
    throw error;
  }
}

const RAISED = { "ui/budget.json": '{ "brief": 229 }\n' };

describe("the merge gate's countersign", () => {
  test("a fix that raises a budget is refused loosened_gate with one decision for the leader; countersigned at that head, it passes", async () => {
    const s = ship(1, RAISED);
    const v = verified(s.task, s.head);
    expect(await gate(s.task)).toBe("loosened_gate");
    const d = countersignOf(db, s.task, s.head)!;
    expect(d).toMatchObject({ state: "open", run_id: null, reserved_reason: null });
    expect(d.context).toContain("ui/budget.json: raised 228 → 229");
    expect(d.context).toContain(`Proof: verify ${v.id} passed at this head`);
    // Asked once: a second pass refuses again without a second decision.
    expect(await gate(s.task)).toBe("loosened_gate");
    expect(db.query("SELECT COUNT(*) AS n FROM decisions").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'merge.loosened_gate'").get()).toEqual({ n: 1 });

    tx(db, () => answerDecision({ db, now: () => now }, d, { choice: "countersign", words: "measured", by: "leader", via: "cli" }));
    expect(await gate(s.task)).toBe("passed");
  });

  test("with no verify steps nothing proves the new number: it keeps refusing and opens no decision", async () => {
    configText = "";
    const s = ship(1, RAISED);
    const refused = await refusal(s.task);
    expect(refused.code).toBe("loosened_gate");
    expect(refused.message).toContain("no verifier proved the new number");
    expect(await gate(s.task)).toBe("loosened_gate");
    expect(db.query("SELECT COUNT(*) AS n FROM decisions").get()).toEqual({ n: 0 });
  });

  test("a refused countersign keeps refusing, naming the send-back", async () => {
    const s = ship(1, RAISED);
    verified(s.task, s.head);
    await gate(s.task);
    tx(db, () => answerDecision({ db, now: () => now }, countersignOf(db, s.task, s.head)!, { choice: "refuse", words: null, by: "leader", via: "cli" }));
    await expect(prepareDaemonMerge(services(), s.task)).rejects.toThrow(/answered refuse/);
  });

  test("a new head dismisses the countersign asked at the old one, with an event, and asks afresh", async () => {
    const s = ship(1, RAISED);
    verified(s.task, s.head);
    await gate(s.task);
    const first = countersignOf(db, s.task, s.head)!;
    const head = redeliver(1, { "ui/budget.json": '{ "brief": 230 }\n' });
    verified(s.task, head);
    expect(await gate(s.task)).toBe("loosened_gate");
    const second = countersignOf(db, s.task, head)!;
    expect(second.id).not.toBe(first.id);
    expect(countersignOf(db, s.task, s.head)).toMatchObject({ state: "dismissed" });
    expect(second.state).toBe("open");
    const dismissed = db.query("SELECT payload FROM events WHERE kind = 'decision.dismissed'").all() as { payload: string }[];
    expect(dismissed.map((e) => JSON.parse(e.payload).decision)).toEqual([first.id]);
  });

  test("sensitive work's countersign (asked once the user approved the merge) is reserved for the user, and only the user's counts", async () => {
    const s = ship(1, RAISED, { sensitive: true });
    verified(s.task, s.head);
    tx(db, () => insertApproval(db, { task: s.task, ref: `local:flowryn/${s.task}`, head: s.head, channel: "cli-tty", actor: "you", action: "merge", now }));
    expect(await gate(s.task)).toBe("loosened_gate");
    const d = countersignOf(db, s.task, s.head)!;
    expect(d.reserved_reason).toContain("sensitive");
    tx(db, () => answerDecision({ db, now: () => now }, d, { choice: "countersign", words: "fine", by: "leader", via: "cli" }));
    expect((await refusal(s.task)).message).toContain("needs the user's countersign");
  });

  test("sensitive work passes on the user's countersign", async () => {
    const s = ship(1, RAISED, { sensitive: true });
    verified(s.task, s.head);
    tx(db, () => insertApproval(db, { task: s.task, ref: `local:flowryn/${s.task}`, head: s.head, channel: "cli-tty", actor: "you", action: "merge", now }));
    await gate(s.task);
    tx(db, () => answerDecision({ db, now: () => now }, countersignOf(db, s.task, s.head)!, { choice: "countersign", words: "yes", by: "captain", via: "cli-tty" }));
    expect(await gate(s.task)).toBe("passed");
  });

  test("a fix that loosens nothing, and a feature that raises a budget, pass with no decision", async () => {
    const clean = ship(1, { "pkg.go": "package x\n" });
    verified(clean.task, clean.head);
    expect(await gate(clean.task)).toBe("passed");
    const feature = ship(2, RAISED, { workflow: "feature" });
    verified(feature.task, feature.head);
    expect(await gate(feature.task)).toBe("passed");
    expect(db.query("SELECT COUNT(*) AS n FROM decisions").get()).toEqual({ n: 0 });
  });
});
