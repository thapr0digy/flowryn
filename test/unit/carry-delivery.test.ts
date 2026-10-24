import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { ChecksSummary, PullRequest } from "../../src/forge/types.ts";
import { deliveredOf, recordDelivery, type Carry } from "../../src/lifecycle/delivery.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { openGate, openMergeGate } from "../../src/lifecycle/stages.ts";
import { insertApproval } from "../../src/policy/approvals.ts";
import type { CleanMerge } from "../../src/policy/clean-merge.ts";
import { applyPrObservation, type Applied } from "../../src/reconcile/delivery.ts";
import { insertRequest } from "../../src/verify/queue.ts";

/**
 * Carrying a routine PR's delivery across a head that adds only clean merges
 * of main (docs/notes/2026-10-23-a-clean-merge-fm.md): what the reconciler
 * records once git's proof holds, and what still goes the old way. The proof
 * itself is test/unit/clean-merge.test.ts.
 */

const now = 9_000_000;
const PR_URL = "https://github.com/acme/web/pull/7";
const A = "aaaaaaaa11111111111111111111111111111111";
const B = "bbbbbbbb22222222222222222222222222222222";
const MAIN = "cccccccc33333333333333333333333333333333";
const TREE = "dddddddd44444444444444444444444444444444";
const POLICY = "vp1:policy";
const CLEAN: CleanMerge = { ok: true, steps: [{ commit: B, main: MAIN, tree: TREE }] };
const GREEN: ChecksSummary = { state: "green", checks: [{ name: "ci", state: "green" }] } as ChecksSummary;

let dir: string;
let db: Db;

function pr(headSha: string): PullRequest {
  return { number: 7, url: PR_URL, title: "t", state: "open", draft: false, headSha, headRef: "ship", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true };
}

function seed(policy: { yolo: number; sensitive: number }): void {
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', '/p', 'main', 'direct-PR')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES ('t1', 'web', 'ship', 'direct-PR', ?1, ?2, 'fix', ?3)").run(policy.yolo, policy.sensitive, now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'idle', 'fix', 'ship', 'done', '/w', 'ship', 's', 'r1', ?1, ?1)`,
    ).run(now);
    recordDelivery(db, getRunWithPolicy(db, "r1")!, { kind: "pr", pr: pr(A), checks: GREEN, url: PR_URL }, "socket", now);
    openMergeGate(db, getRunWithPolicy(db, "r1")!, now);
  });
}

function observe(proof: CleanMerge | undefined, verifyPolicy: string | null = POLICY, at = now + 60_000): Applied {
  const delivered = deliveredOf(db, "t1")!;
  return tx(db, () =>
    applyPrObservation(db, getRunWithPolicy(db, "r1")!, delivered, { pr: pr(B), checks: GREEN }, new Set(), at, {
      nudgeConflicts: false,
      history: "descends",
      ...(proof ? { carry: { proof, verifyPolicy } } : {}),
    }),
  );
}

function rows<T>(sql: string, ...params: string[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function divergences(): string[] {
  return rows<{ summary: string }>("SELECT summary FROM divergences ORDER BY opened_at").map((d) => d.summary);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-carry-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a routine PR whose head moved by a clean merge of main", () => {
  test("the delivery moves to the new head: no divergence, run ready, merge gate open, the ready line says why", () => {
    seed({ yolo: 1, sensitive: 0 });
    const applied = observe(CLEAN);
    expect(applied).toEqual({ landed: false, carried: true });
    expect(deliveredOf(db, "t1")).toMatchObject({ kind: "pr", ref: PR_URL, head: B, carriedFrom: A });
    expect(divergences()).toEqual([]);
    expect(getRunWithPolicy(db, "r1")!.state).toBe("ready");
    expect(openGate(db, "r1", "merge")).not.toBeNull();
    const ready = rows<{ line: string; state: string }>("SELECT line, state FROM items WHERE kind = 'pr_ready'");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.line).toContain("head bbbbbbbb is aaaaaaaa plus only a clean merge of main; verify queued (vq1)");
    const event = rows<{ payload: string }>("SELECT payload FROM events WHERE kind = 'run.head_carried'").map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(event).toEqual([{ pr: PR_URL, from: A, to: B, steps: [{ commit: B, main: MAIN, tree: TREE }], via: "watcher", verify: "vq1" }]);
  });

  test("re-verify is still required: a verify of the new head is queued under today's policy, with the PATH of the project's last request", () => {
    seed({ yolo: 1, sensitive: 0 });
    tx(db, () =>
      insertRequest(db, { project_id: "web", pr_url: PR_URL, task_id: "t1", head_sha: A, policy_id: POLICY, pr_number: 7, head_ref: "ship", worktree: null, source: "cli", path: "/opt/bun/bin:/usr/bin", now }),
    );
    observe(CLEAN);
    const queued = rows<{ head_sha: string; policy_id: string; source: string; path: string; pr_number: number; head_ref: string }>(
      "SELECT head_sha, policy_id, source, path, pr_number, head_ref FROM verify_queue WHERE head_sha = ?1",
      B,
    );
    expect(queued).toEqual([{ head_sha: B, policy_id: POLICY, source: "auto", path: "/opt/bun/bin:/usr/bin", pr_number: 7, head_ref: "ship" }]);
  });

  test("no second verify when one already passed or waits at the new head; none at all for a project with no verify steps", () => {
    seed({ yolo: 1, sensitive: 0 });
    tx(db, () =>
      insertRequest(db, { project_id: "web", pr_url: PR_URL, task_id: "t1", head_sha: B, policy_id: POLICY, pr_number: 7, head_ref: "ship", worktree: null, source: "cli", path: null, now }),
    );
    observe(CLEAN);
    expect(rows("SELECT id FROM verify_queue WHERE head_sha = ?1", B)).toHaveLength(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "fw-carry-"));
    db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    seed({ yolo: 1, sensitive: 0 });
    expect(observe(CLEAN, null)).toEqual({ landed: false, carried: true });
    expect(rows("SELECT id FROM verify_queue")).toHaveLength(0);
    expect(rows<{ line: string }>("SELECT line FROM items WHERE kind = 'pr_ready'")[0]!.line).toEndWith("plus only a clean merge of main");
  });

  test("a sign-off you gave stays bound to the head you saw: it is voided at the carried head", () => {
    seed({ yolo: 1, sensitive: 0 });
    tx(db, () => insertApproval(db, { task: "t1", ref: PR_URL, head: A, channel: "cli-tty", actor: "you", action: "merge", allowRed: "ci", now }));
    observe(CLEAN);
    expect(rows<{ consumed_at: number | null }>("SELECT consumed_at FROM approvals")[0]!.consumed_at).not.toBeNull();
  });
});

describe("what still goes the old way", () => {
  test("sensitive work never carries, even with git's proof", () => {
    seed({ yolo: 1, sensitive: 1 });
    expect(observe(CLEAN)).toEqual({ landed: false });
    expect(deliveredOf(db, "t1")!.head).toBe(A);
    expect(divergences()).toEqual(["the PR head moved from aaaaaaaa (delivered) to bbbbbbbb, not carried: only routine work (yolo, not sensitive) carries a clean merge of main; merges wait for a new delivery"]);
    expect(rows("SELECT id FROM verify_queue")).toHaveLength(0);
  });

  test("work that needs your word (not yolo) never carries", () => {
    seed({ yolo: 0, sensitive: 0 });
    observe(CLEAN);
    expect(deliveredOf(db, "t1")!.head).toBe(A);
    expect(divergences()[0]).toContain("not carried: only routine work");
  });

  test("a head git could not prove clean keeps today's divergence, naming why", () => {
    seed({ yolo: 1, sensitive: 0 });
    observe({ ok: false, why: "bbbbbbbb: merging main has conflicts, so its resolution is new code" });
    expect(deliveredOf(db, "t1")!.head).toBe(A);
    expect(divergences()).toEqual([
      "the PR head moved from aaaaaaaa (delivered) to bbbbbbbb, not carried: not only a clean merge of main (bbbbbbbb: merging main has conflicts, so its resolution is new code); merges wait for a new delivery",
    ]);
    expect(rows("SELECT 1 FROM events WHERE kind = 'run.head_carried'")).toHaveLength(0);
  });

  test("no proof asked (history rewritten or unknown): today's summary, unchanged", () => {
    seed({ yolo: 1, sensitive: 0 });
    observe(undefined);
    expect(divergences()).toEqual(["the PR head moved from aaaaaaaa (delivered) to bbbbbbbb; merges wait for a new delivery"]);
  });
});

describe("a worker that redelivers a clean merge of main itself", () => {
  const carry: Carry = { from: A, steps: CLEAN.ok ? CLEAN.steps : [], verifyPolicy: POLICY };

  test("routine work: the artifact names the head it carries from and the verify is queued", () => {
    seed({ yolo: 1, sensitive: 0 });
    const data = tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r1")!, { kind: "pr", pr: pr(B), checks: GREEN, url: PR_URL }, "socket", now + 1, carry));
    expect(data).toMatchObject({ head: B, carried_from: A, verify_queued: "vq1" });
    expect(deliveredOf(db, "t1")).toMatchObject({ head: B, carriedFrom: A });
    const event = rows<{ payload: string }>("SELECT payload FROM events WHERE kind = 'run.head_carried'").map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(event[0]).toMatchObject({ from: A, to: B, via: "deliver", verify: "vq1" });
  });

  test("sensitive work, or a proof from another head: a plain delivery", () => {
    seed({ yolo: 1, sensitive: 1 });
    const data = tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r1")!, { kind: "pr", pr: pr(B), checks: GREEN, url: PR_URL }, "socket", now + 1, carry));
    expect(data).not.toHaveProperty("carried_from");
    expect(deliveredOf(db, "t1")).toEqual({ kind: "pr", ref: PR_URL, head: B, at: now + 1 });
    const other = tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r1")!, { kind: "pr", pr: pr(MAIN), checks: GREEN, url: PR_URL }, "socket", now + 2, carry));
    expect(other).not.toHaveProperty("carried_from");
    expect(rows("SELECT 1 FROM events WHERE kind = 'run.head_carried'")).toHaveLength(0);
  });
});
