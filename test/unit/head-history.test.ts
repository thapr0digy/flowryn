import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { PullRequest } from "../../src/forge/types.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { headHistory } from "../../src/policy/head-history.ts";
import { closeDivergence, getDivergence } from "../../src/reconcile/divergence.ts";
import { applyPrObservation } from "../../src/reconcile/delivery.ts";
import { GIT_ENV, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * A delivered PR head that moved: did it move by new commits on top, or was
 * history rewritten (no-mistakes' CI conflict repair rebases and
 * force-pushes)? One bounded ancestry check against scratch repositories,
 * and the divergence it tags, once per head move.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-head-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  sh(cwd, ["add", "."]);
  sh(cwd, ["commit", "-q", "-m", file]);
  return sh(cwd, ["rev-parse", "HEAD"]);
}

describe("how a delivered head moved", () => {
  const git = () => gitRunner("git", 10_000, GIT_ENV);

  test("new commits on top descend; a rebase onto main, fetched from the PR's ref, is a rewrite", async () => {
    const { primary, other } = scratchRepos(dir);
    sh(primary, ["switch", "-q", "-c", "ship"]);
    const delivered = commit(primary, "fix.txt", "fixed\n");
    const onTop = commit(primary, "more.txt", "more\n");
    expect(await headHistory(git(), primary, delivered, onTop, 7)).toBe("descends");

    // Elsewhere: main moves, and the branch is rebased onto it and force-pushed (only GitHub's refs/pull/7/head has it).
    commit(other, "main.txt", "main moved\n");
    const rebased = commit(other, "fix.txt", "fixed\n");
    sh(other, ["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    expect(await headHistory(git(), primary, delivered, rebased, 7)).toBe("rewritten");
  });

  test("unknown when git cannot say: a head it cannot fetch, a missing delivered head, a failing call", async () => {
    const { primary } = scratchRepos(dir);
    const head = sh(primary, ["rev-parse", "HEAD"]);
    const absent = "0123456789abcdef0123456789abcdef01234567";
    expect(await headHistory(git(), primary, head, absent, 7)).toBe("unknown");
    expect(await headHistory(git(), primary, head, absent, null)).toBe("unknown");
    expect(await headHistory(git(), primary, absent, head, 7)).toBe("unknown");
    const cutOff = async (args: string[]) => (args[0] === "merge-base" ? { code: 124, stdout: "", stderr: "timed out" } : { code: 0, stdout: "", stderr: "" });
    expect(await headHistory(cutOff, primary, head, head, 7)).toBe("unknown");
  });
});

describe("the divergence for a moved head", () => {
  let db: Db;
  const now = 7_000_000;
  const DELIVERED = "aaaaaaaa11111111111111111111111111111111";
  const MOVED = "bbbbbbbb22222222222222222222222222222222";
  const delivered = { kind: "pr" as const, ref: "https://github.com/acme/web/pull/7", head: DELIVERED, at: now - 60_000 };

  function pr(headSha: string): PullRequest {
    return { number: 7, url: delivered.ref, title: "t", state: "open", draft: false, headSha, headRef: "ship", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true };
  }

  function observe(history: "descends" | "rewritten" | "unknown" | undefined, at = now): void {
    tx(db, () => applyPrObservation(db, getRunWithPolicy(db, "r1")!, delivered, { pr: pr(MOVED), checks: null }, new Set(), at, { nudgeConflicts: false, history }));
  }

  function divergences(): { id: string; summary: string }[] {
    return db.query("SELECT id, summary FROM divergences ORDER BY opened_at, id").all() as { id: string; summary: string }[];
  }

  beforeEach(() => {
    db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    tx(db, () => {
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r1', 't1', 'claude', 'v', 'ready', 'idle', 'fix', 'ship', '/w', 'ship', 's', 'r1', ?1, ?1)`,
      ).run(now);
    });
  });

  afterEach(() => db.close());

  test("a rewrite is tagged in the summary and the event", () => {
    observe("rewritten");
    expect(divergences().map((d) => d.summary)).toEqual(["the PR head moved from aaaaaaaa (delivered) to bbbbbbbb, history rewritten: bbbbbbbb does not descend from aaaaaaaa; merges wait for a new delivery"]);
    const opened = db.query("SELECT payload FROM events WHERE kind = 'divergence.opened'").get() as { payload: string };
    expect(JSON.parse(opened.payload)).toMatchObject({ history: "rewritten" });
  });

  test("new commits on top keep the plain summary; git that could not say is unknown", () => {
    observe("descends");
    expect(divergences().map((d) => d.summary)).toEqual(["the PR head moved from aaaaaaaa (delivered) to bbbbbbbb; merges wait for a new delivery"]);
    db.query("DELETE FROM divergences").run();
    observe(undefined);
    expect(divergences().map((d) => d.summary)).toEqual(["the PR head moved from aaaaaaaa (delivered) to bbbbbbbb, ancestry unknown; merges wait for a new delivery"]);
  });

  test("one divergence per head move, whatever a later read's tag; keep-run keeps it closed", () => {
    observe("unknown");
    observe("rewritten", now + 1_000);
    expect(divergences()).toHaveLength(1);
    const [d] = divergences();
    tx(db, () => closeDivergence(db, getDivergence(db, d!.id)!, "keep-run", "test", "cli", now + 2_000));
    observe("rewritten", now + 3_000);
    expect(divergences()).toHaveLength(1);
  });
});
