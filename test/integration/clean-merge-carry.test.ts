import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { sh } from "../helpers/scratch-git.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * A routine PR's head moves on GitHub by a merge of main (docs/notes/2026-10-23-a-clean-merge-fm.md),
 * end to end: a real daemon, the fake GitHub backed by the project's bare origin, the delivery
 * watcher, git's proof in the run's worktree, the verify queue and the merge gate. A clean merge
 * carries the delivery with no worker turn and still needs a passing verify of the new head; a merge
 * that slips in an edit keeps today's "head moved" divergence.
 */

let env: ShipEnv | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await env?.cleanup();
  env = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30_000);

const STEPS = ["printf ' 1 pass\\n 0 fail\\n 1 expect() calls\\nRan 1 tests across 1 file. [1.00ms]\\n'"];
const VERIFY_CONFIG = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\n`;

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** A routine ship delivered as PR 1 with no checks: its task, run and delivered head. */
async function delivered(e: ShipEnv): Promise<{ task: string; run: string; head: string; branch: string }> {
  e.github.repo("acme/web").defaultChecks = [];
  const steps = "FAKE: commit carry.txt carry\nFAKE: push\nFAKE: pr " + e.github.apiUrl + " acme/web\nFAKE: deliver-pr\n";
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `carry\n${steps}FAKE: sleep 120000` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const { task, run } = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(run, (r) => r.state === "ready", "carry delivered");
  const pr = e.github.pr("acme/web", 1);
  return { task, run, head: pr.headSha, branch: pr.headRef };
}

/**
 * What someone else does on GitHub: main moves (another PR landed), then main is merged into the
 * PR branch and pushed, as the worker or GitHub's update button would. `edit` slips a change into
 * the merge commit. Returns the new head.
 */
function pushMergeOfMain(e: ShipEnv, branch: string, edit?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-carry-it-"));
  dirs.push(dir);
  const clone = join(dir, "clone");
  sh(dir, ["clone", "-q", e.fleet.origin!, clone]);
  writeFileSync(join(clone, "landed.txt"), "another PR landed\n");
  sh(clone, ["add", "."]);
  sh(clone, ["commit", "-q", "-m", "another PR"]);
  sh(clone, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  sh(clone, ["switch", "-q", branch]);
  sh(clone, ["merge", "-q", "--no-ff", "--no-commit", "origin/main"]);
  if (edit) {
    writeFileSync(join(clone, "carry.txt"), edit);
    sh(clone, ["add", "."]);
  }
  sh(clone, ["commit", "-q", "--no-edit"]);
  sh(clone, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`, "HEAD:refs/pull/1/head"]);
  return sh(clone, ["rev-parse", "HEAD"]);
}

describe("a clean merge of main into a delivered routine PR", () => {
  test(
    "the watcher carries the delivery to the new head, queues its verify, and the merge waits for that verify, then lands under yolo",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: VERIFY_CONFIG });
      const e = env;
      const { task, head: approved, branch } = await delivered(e);
      const head = pushMergeOfMain(e, branch);

      await waitUntil(() => query(e, "SELECT 1 FROM events WHERE kind = 'run.head_carried'").length > 0, 30_000, "the delivery to carry to the new head");
      const carried = JSON.parse(query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'run.head_carried'")[0]!.payload) as Record<string, unknown>;
      expect(carried).toMatchObject({ from: approved, to: head, via: "watcher" });
      expect(query(e, "SELECT id FROM divergences WHERE summary LIKE 'the PR head moved%'")).toHaveLength(0);
      expect(query<{ state: string }>(e, "SELECT state FROM gates WHERE kind = 'merge'").map((g) => g.state)).toEqual(["open"]);
      const shown = JSON.stringify((await e.fleet.json(["show", task])).reply.data);
      expect(shown).toContain(`${head.slice(0, 12)}`);
      expect(shown).toContain(`${approved.slice(0, 12)} (the new head adds only a clean merge of main)`);

      // Re-verify is still required: the queued verify of the new head runs, and only its pass lets the merge through.
      await waitUntil(() => query(e, "SELECT 1 FROM verifications WHERE head_sha = ?1 AND state = 'passed'", head).length > 0, 60_000, "the carried head's verify to pass");
      const verify = query<{ source: string }>(e, "SELECT source FROM verify_queue WHERE head_sha = ?1", head);
      expect(verify.map((v) => v.source)).toEqual(["auto"]);

      const merged = await e.call("merge", { task });
      expect(merged.ok).toBe(true);
      expect(merged.data).toMatchObject({ state: "merged" });
      const approval = query<{ channel: string; head_sha: string }>(e, "SELECT channel, head_sha FROM approvals WHERE action = 'merge'");
      expect(approval).toEqual([{ channel: "yolo", head_sha: head }]);
    },
    { timeout: 150_000 },
  );

  test(
    "a merge of main that slips in an edit is not carried: today's divergence, naming why, and no verify",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: VERIFY_CONFIG });
      const e = env;
      const { task, head: approved, branch } = await delivered(e);
      const head = pushMergeOfMain(e, branch, "quietly changed\n");

      await waitUntil(() => query(e, "SELECT 1 FROM divergences WHERE summary LIKE 'the PR head moved%'").length > 0, 30_000, "the head-moved divergence");
      const [summary] = query<{ summary: string }>(e, "SELECT summary FROM divergences WHERE summary LIKE 'the PR head moved%'").map((d) => d.summary);
      expect(summary).toContain(`not carried: not only a clean merge of main (${head.slice(0, 8)} holds changes beyond the clean merge of main)`);
      expect(query(e, "SELECT 1 FROM events WHERE kind = 'run.head_carried'")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM verify_queue")).toHaveLength(0);
      const merge = await e.call("merge", { task });
      expect(merge.ok).toBe(false);
      expect(merge.error).toMatchObject({ code: "head_moved" });
      expect(merge.error!.message).toContain(`from ${approved.slice(0, 8)} (delivered)`);
    },
    { timeout: 150_000 },
  );
});
