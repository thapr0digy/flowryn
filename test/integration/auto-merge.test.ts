import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import type { FakeCheck } from "../helpers/fake-github.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * Yolo auto-merge end to end (docs/notes/2026-10-22-daemon-run-verify-y3.md,
 * phase 2): a real daemon, the fake GitHub backed by the project's bare
 * origin, a yolo direct-PR project with shell-line verify steps and
 * `auto_merge = true`, and fake workers. No leader session is ever opened:
 * whatever lands, lands with no leader call. Nothing reaches GitHub.
 */

let env: ShipEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
}, 30_000);

const PASSING = ["printf ' 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [1.00ms]\\n'"];
/** A step that fails until the worktree has fixed.txt: a fix the worker commits after a send-back passes it. */
const FAILING_UNTIL_FIXED = ["test -f fixed.txt || { echo 'boom: fixed.txt is missing'; exit 3; }"];

function autoConfig(steps: string[]): string {
  return `[projects.web]\nverify = ${JSON.stringify(steps)}\nauto_merge = true\n`;
}

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function exec(e: ShipEnv, sql: string, ...params: string[]): void {
  const db = e.fleet.h.db();
  try {
    db.query(sql).run(...params);
  } finally {
    db.close();
  }
}

interface AutoRow {
  id: string;
  state: string;
  head_sha: string;
  reason: string | null;
  detail: string | null;
  merge_id: string | null;
  verification_id: string | null;
}

function autoRows(e: ShipEnv, run: string): AutoRow[] {
  return query<AutoRow>(e, "SELECT * FROM auto_merges WHERE run_id = ?1 ORDER BY created_at, CAST(substr(id, 3) AS INTEGER)", run);
}

async function waitAuto(e: ShipEnv, run: string, predicate: (rows: AutoRow[]) => boolean, what: string, timeoutMs = 30_000): Promise<AutoRow[]> {
  try {
    await waitUntil(() => predicate(autoRows(e, run)), timeoutMs, what);
  } catch (error) {
    throw new Error(`${(error as Error).message}; auto_merges: ${JSON.stringify(autoRows(e, run))}; events: ${e.fleet.events(run).join(",")}`, { cause: error });
  }
  return autoRows(e, run);
}

function openItems(e: ShipEnv, kind: string, run: string): { line: string }[] {
  return query<{ line: string }>(e, "SELECT line FROM items WHERE kind = ?1 AND run_id = ?2 AND state IN ('open','presented')", kind, run);
}

async function ship(e: ShipEnv, title: string, steps: string[], opts: { sensitive?: boolean } = {}): Promise<{ task: string; run: string }> {
  const body = [title, ...steps, "FAKE: sleep 120000"].join("\n");
  const args = ["dispatch", "web", "--kind", "ship", "--harness", "claude", ...(opts.sensitive ? ["--sensitive"] : []), "--body-file", "-"];
  const dispatched = await e.fleet.json(args, { stdin: body });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  return dispatched.reply.data as { task: string; run: string };
}

const prSteps = (e: ShipEnv, file = "a.txt") => [`FAKE: commit ${file} change`, "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr"];

describe("yolo auto-merge", () => {
  test(
    "an opted-in yolo PR is verified and lands with channel yolo, by: auto, and no leader call",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: autoConfig(PASSING) });
      const e = env;
      const { task, run } = await ship(e, "Lands by itself", prSteps(e));
      await e.fleet.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "the auto-merge to land it", 60_000);

      const [row] = await waitAuto(e, run, (rows) => rows[0]?.state === "merged", "the row merged");
      expect(row).toMatchObject({ state: "merged", head_sha: e.github.pr("acme/web", 1).headSha });
      expect(e.github.pr("acme/web", 1).merged).toBe(true);
      const merge = query<{ id: string; channel: string; local_green: string | null }>(e, "SELECT m.id, a.channel, m.local_green FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1", task);
      expect(merge).toEqual([{ id: row!.merge_id!, channel: "yolo", local_green: row!.verification_id }]);
      const requested = query<{ source: string; payload: string }>(e, "SELECT source, payload FROM events WHERE kind = 'merge.requested' AND task_id = ?1", task);
      expect(requested).toHaveLength(1);
      expect(requested[0]!.source).toBe("daemon");
      expect(JSON.parse(requested[0]!.payload)).toMatchObject({ channel: "yolo", by: "auto" });
      // The daemon queued the verify itself; nobody ran flowryn verify or flowryn merge.
      expect(query(e, "SELECT id FROM verify_queue WHERE task_id = ?1 AND source <> 'auto'", task)).toEqual([]);
      expect(query(e, "SELECT session_id FROM leader_sessions")).toEqual([]);
      // Recorded as a yolo merge, with no landed wake for a leader.
      expect(query(e, "SELECT id FROM items WHERE kind = 'landed' AND task_id = ?1", task)).toEqual([]);
      expect(query(e, "SELECT id FROM items WHERE kind = 'yolo_merged' AND task_id = ?1", task)).toHaveLength(1);
      const landed = query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'run.landed' AND run_id = ?1", run);
      expect(JSON.parse(landed[0]!.payload)).toMatchObject({ by: "auto", how: "merge" });
    },
    { timeout: 90_000 },
  );

  test(
    "a sensitive delivery gets no auto-merge, and a run made sensitive before the merge is held by the gate",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: autoConfig(PASSING) });
      const e = env;
      const sensitive = await ship(e, "Sensitive", prSteps(e), { sensitive: true });
      await e.fleet.waitRun(sensitive.run, (r) => r.state === "ready", "the sensitive delivery");
      expect(autoRows(e, sensitive.run)).toEqual([]);
      expect(openItems(e, "sensitive_action_waiting", sensitive.run)).toHaveLength(1);

      // The second PR's checks stay pending, so its passed verify waits while it turns sensitive.
      e.github.repo("acme/web").defaultChecks = [{ name: "ci/test", state: "pending" }];
      const later = await ship(e, "Turns sensitive", prSteps(e, "b.txt"));
      await waitAuto(e, later.run, (rows) => rows[0]?.state === "waiting_checks", "the verify passed, waiting on checks");
      exec(e, "UPDATE task_policy SET sensitive = 1 WHERE task_id = ?1", later.task);
      e.github.repo("acme/web").defaultChecks = [{ name: "ci/test", state: "green" }];
      const [row] = await waitAuto(e, later.run, (rows) => rows[0]?.state === "held", "the gate to hold it");
      expect(row).toMatchObject({ reason: "approval_required" });
      expect(row!.detail).toContain("sensitive work needs a human approval");
      expect(e.fleet.run(later.run).state).toBe("ready");
      expect(e.github.pr("acme/web", 2).merged).toBe(false);
      const held = openItems(e, "auto_merge_held", later.run);
      expect(held).toHaveLength(1);
      expect(held[0]!.line).toContain(`(${later.task}): merge refused: sensitive work needs a human approval`);
      expect(openItems(e, "pr_ready", later.run)[0]!.line).toContain("auto-merge: held (approval_required)");
    },
    { timeout: 120_000 },
  );

  test(
    "a red check holds it at the gate with red_checks",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: autoConfig(PASSING) });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [{ name: "ci/test", state: "red" }];
      const { task, run } = await ship(e, "Red", prSteps(e));
      const [row] = await waitAuto(e, run, (rows) => rows[0]?.state === "held", "red checks to hold it", 60_000);
      expect(row).toMatchObject({ reason: "red_checks" });
      expect(row!.verification_id).toMatch(/^v\d+$/);
      expect(e.github.pr("acme/web", 1).merged).toBe(false);
      expect(openItems(e, "auto_merge_held", run)[0]!.line).toContain(`flowryn merge ${task} --allow-red`);
    },
    { timeout: 90_000 },
  );

  test(
    "a failed verify sends the ship back once with the step and its tail; failing again at the same head holds it",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: autoConfig(FAILING_UNTIL_FIXED) });
      const e = env;
      const { task, run } = await ship(e, "Fails twice", [...prSteps(e), "FAKE: wait-file again", "FAKE: deliver-pr"]);
      const [first] = await waitAuto(e, run, (rows) => rows[0]?.state === "sent_back", "the send-back", 60_000);
      expect(first).toMatchObject({ reason: "verify_failed" });
      await e.fleet.waitRun(run, (r) => r.state === "running" && r.stage === "ship" && r.stage_state === "active", "the ship stage to start again");
      const steer = query<{ body: string }>(e, "SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at DESC LIMIT 1", run)[0]!.body;
      expect(steer).toContain(`flowryn verify ${first!.verification_id} of your delivery at ${first!.head_sha.slice(0, 8)} failed`);
      expect(steer).toContain("exited 3");
      expect(steer).toContain("boom: fixed.txt is missing");

      // The worker delivers the same head again without fixing it: the second failure is the leader's.
      writeFileSync(join(e.fleet.h.dataDir, task, "again"), "");
      const rows = await waitAuto(e, run, (r) => r[1]?.state === "held", "the second failure to hold it", 60_000);
      expect(rows[1]).toMatchObject({ reason: "verify_failed", head_sha: first!.head_sha });
      expect(rows[1]!.detail).toContain("failed again");
      expect(e.fleet.run(run).state).toBe("ready");
      expect(openItems(e, "auto_merge_held", run)[0]!.line).toContain(`flowryn verify show ${rows[1]!.verification_id}`);
      expect(e.github.pr("acme/web", 1).merged).toBe(false);
    },
    { timeout: 150_000 },
  );

  test(
    "a redelivery at a new head supersedes the earlier auto-merge, and the new one lands",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: autoConfig(PASSING) });
      const e = env;
      const pending: FakeCheck[] = [{ name: "ci/test", state: "pending" }];
      e.github.repo("acme/web").defaultChecks = pending;
      const { task, run } = await ship(e, "Twice", [...prSteps(e), "FAKE: wait-file again", "FAKE: commit b.txt second", "FAKE: push", "FAKE: deliver-pr"]);
      const [first] = await waitAuto(e, run, (rows) => rows[0]?.state === "waiting_checks", "the first head waiting on checks", 60_000);
      writeFileSync(join(e.fleet.h.dataDir, task, "again"), "");
      await waitAuto(e, run, (rows) => rows.length === 2, "the redelivery");
      e.github.repo("acme/web").defaultChecks = [{ name: "ci/test", state: "green" }];
      await e.fleet.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "the new head to land", 60_000);
      const rows = await waitAuto(e, run, (r) => r[1]?.state === "merged", "the second row merged");
      expect(rows[0]).toMatchObject({ id: first!.id, state: "superseded", reason: "redelivered" });
      expect(rows[1]!.head_sha).not.toBe(first!.head_sha);
      expect(rows[1]!.head_sha).toBe(e.github.pr("acme/web", 1).headSha);
    },
    { timeout: 120_000 },
  );
});
