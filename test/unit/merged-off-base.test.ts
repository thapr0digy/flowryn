import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { PullRequest } from "../../src/forge/types.ts";
import { getRun, getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { closeDivergence, getDivergence } from "../../src/reconcile/divergence.ts";
import { applyPrObservation } from "../../src/reconcile/delivery.ts";

/**
 * A based run's PR read merged on GitHub (docs/notes/2026-10-27-stack-a-plan-4y.md):
 * merged into its base, it lands; merged into another branch (retargeted by
 * hand, then merged), it is a divergence until you keep the run.
 */

describe("a PR merged into a branch other than the run's base", () => {
  let dir: string;
  let db: Db;
  const now = 7_000_000;
  const HEAD = "aaaaaaaa11111111111111111111111111111111";
  const delivered = { kind: "pr" as const, ref: "https://github.com/acme/web/pull/7", head: HEAD, at: now - 60_000 };

  function merged(baseRef: string): PullRequest {
    return { number: 7, url: delivered.ref, title: "t", state: "merged", draft: false, headSha: HEAD, headRef: "ship", headRepo: "acme/web", baseRef, mergeSha: "c".repeat(40), mergedAt: "2026-10-29T00:00:00Z", mergeable: null };
  }

  function observe(baseRef: string, at = now): boolean {
    return tx(db, () => applyPrObservation(db, getRunWithPolicy(db, "r1")!, delivered, { pr: merged(baseRef), checks: null }, new Set(), at, { nudgeConflicts: false })).landed;
  }

  function divergences(): { id: string; summary: string }[] {
    return db.query("SELECT id, summary FROM divergences ORDER BY opened_at, id").all() as { id: string; summary: string }[];
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fw-merged-off-base-"));
    db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    tx(db, () => {
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'direct-PR')").run();
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at, base_branch) VALUES ('t1', 'p', 'ship', 'direct-PR', 0, 'fix', ?1, 'release/2')").run(now);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, base_branch, token_hash, started_at, updated_at)
         VALUES ('r1', 't1', 'claude', 'v', 'ready', 'idle', 'fix', 'ship', '/w', 'ship', 's', 'release/2', 'r1', ?1, ?1)`,
      ).run(now);
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("merged into main is a divergence, not a landing, and is opened once", () => {
    expect(observe("main")).toBe(false);
    expect(observe("main", now + 1_000)).toBe(false);
    expect(divergences().map((d) => d.summary)).toEqual([`the delivered PR ${delivered.ref} was merged into main, not its base release/2`]);
    expect(getRun(db, "r1")!.state).toBe("ready");
  });

  test("keep-run lands it as merged", () => {
    observe("main");
    const [d] = divergences();
    tx(db, () => closeDivergence(db, getDivergence(db, d!.id)!, "keep-run", "test", "cli", now + 1_000));
    expect(observe("main", now + 2_000)).toBe(true);
    expect(getRun(db, "r1")!.state).toBe("landed");
  });

  test("a merge in flight read merged into main is refused and diverges, not landed", () => {
    tx(db, () => {
      db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, created_at, expires_at) VALUES ('a1', 't1', ?1, ?2, 'cli-tty', 'me', ?3, ?4)").run(delivered.ref, HEAD, now, now + 60_000);
      db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state) VALUES ('mg1', 't1', ?1, ?2, 'a1', ?3, 'requested')").run(delivered.ref, HEAD, now);
      db.query("UPDATE runs SET state = 'merging' WHERE id = 'r1'").run();
    });
    expect(observe("main")).toBe(false);
    expect(db.query("SELECT state FROM merges WHERE id = 'mg1'").get()).toEqual({ state: "refused" });
    expect(getRun(db, "r1")!.state).toBe("ready");
    expect(divergences().map((d) => d.summary)).toEqual([`the delivered PR ${delivered.ref} was merged into main, not its base release/2`]);
  });

  test("merged into its own base lands with no divergence", () => {
    expect(observe("release/2")).toBe(true);
    expect(divergences()).toHaveLength(0);
  });

  describe("a stacked run", () => {
    beforeEach(() => {
      tx(db, () => {
        db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t0', 'p', 'ship', 'direct-PR', 0, 'fix', ?1)").run(now);
        db.query(
          `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
           VALUES ('r0', 't0', 'claude', 'v', 'ready', 'idle', 'fix', 'ship', '/w0', 'phase1', 's', 'r0', ?1, ?1)`,
        ).run(now - 1_000);
        db.query("UPDATE runs SET base_branch = 'phase1', stacked_on = 't0' WHERE id = 'r1'").run();
      });
    });

    test("merged into the branch beneath before that task landed is a divergence", () => {
      expect(observe("phase1")).toBe(false);
      expect(divergences().map((d) => d.summary)).toEqual([`the delivered PR ${delivered.ref} was merged into phase1, the branch of t0, before t0 landed`]);
    });

    test("merged into the landed task's base before the retarget is a landing", () => {
      tx(db, () => db.query("UPDATE runs SET state = 'landed' WHERE id = 'r0'").run());
      expect(observe("main")).toBe(true);
      expect(divergences()).toHaveLength(0);
      expect(getRun(db, "r1")!.state).toBe("landed");
    });

    test("merged into another branch after the task beneath landed is a divergence against the landed base", () => {
      tx(db, () => db.query("UPDATE runs SET state = 'landed' WHERE id = 'r0'").run());
      expect(observe("release/2")).toBe(false);
      expect(divergences().map((d) => d.summary)).toEqual([`the delivered PR ${delivered.ref} was merged into release/2, not its base main`]);
    });

    test("merged into the branch beneath after that task landed is a divergence against the landed base", () => {
      tx(db, () => db.query("UPDATE runs SET state = 'landed' WHERE id = 'r0'").run());
      expect(observe("phase1")).toBe(false);
      expect(divergences().map((d) => d.summary)).toEqual([`the delivered PR ${delivered.ref} was merged into phase1, not its base main`]);
    });
  });
});
