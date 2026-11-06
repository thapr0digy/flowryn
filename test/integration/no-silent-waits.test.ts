import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * No silent waits, end to end (docs/notes/2026-11-06-no-silent-waits-vj.md): a
 * real daemon, the fake GitHub and fake workers on an auto_merge project with
 * one validation slot. Ship A's verify holds the slot (its step waits on a
 * flag file), so ship B's verify request queues behind it. B's request is then
 * lost (cancelled, or dropped while the daemon was down): the auto-merge
 * queues a verify again at once, and both PRs land once the flag is set.
 */

let env: ShipEnv | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await env?.cleanup();
  env = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30_000);

function flagFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-waits-"));
  dirs.push(dir);
  return join(dir, "go");
}

function config(flag: string): string {
  const step = `while [ ! -f ${flag} ]; do sleep 0.1; done; printf ' 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [1.00ms]\\n'`;
  return [
    "[projects.web]",
    `verify = ${JSON.stringify([step])}`,
    "auto_merge = true",
    "[capacity]",
    "validation = 1",
    "[sched]",
    "pass_ms = 300",
    // The ship stage takes no validation slot here, so B delivers while A's verify holds the only one.
    "[workflows.plain]",
    'stages = [ { id = "build" }, { id = "ship", gate = "merge" } ]',
  ].join("\n");
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
  request_id: string | null;
}

function autoRow(e: ShipEnv, run: string): AutoRow | null {
  return query<AutoRow>(e, "SELECT id, state, request_id FROM auto_merges WHERE run_id = ?1 ORDER BY created_at DESC, CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1", run)[0] ?? null;
}

async function ship(e: ShipEnv, title: string, file: string): Promise<{ task: string; run: string }> {
  const body = [title, `FAKE: commit ${file} change`, "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", "FAKE: sleep 120000"].join("\n");
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { stdin: body });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  return dispatched.reply.data as { task: string; run: string };
}

/** A verifying (holding the one slot), B queued behind it. */
async function aVerifyingBQueued(e: ShipEnv): Promise<{ a: { task: string; run: string }; b: { task: string; run: string }; queued: string }> {
  expect((await e.fleet.json(["project", "set", "web", "--workflow", "plain"])).code).toBe(0);
  const a = await ship(e, "Ship A", "a.txt");
  await waitUntil(() => autoRow(e, a.run)?.state === "verifying", 30_000, "A's verify running");
  const b = await ship(e, "Ship B", "b.txt");
  await waitUntil(() => autoRow(e, b.run)?.state === "queued", 30_000, "B's verify queued behind A's");
  const queued = autoRow(e, b.run)!.request_id!;
  expect(query<{ state: string }>(e, "SELECT state FROM verify_queue WHERE id = ?1", queued)).toEqual([{ state: "queued" }]);
  return { a, b, queued };
}

async function bothLand(e: ShipEnv, flag: string, a: string, b: string): Promise<void> {
  writeFileSync(flag, "go\n");
  await e.fleet.waitRun(a, (r) => r.state === "landed" || r.state === "cleaned", "A to land", 60_000);
  await e.fleet.waitRun(b, (r) => r.state === "landed" || r.state === "cleaned", "B to land", 60_000);
  expect(e.github.pr("acme/web", 1).merged).toBe(true);
  expect(e.github.pr("acme/web", 2).merged).toBe(true);
}

test(
  "a verify cancelled mid-auto-merge is queued again at once, with one event saying why, and the merge completes; fleet shows the wait's age and deadline",
  async () => {
    const flag = flagFile();
    env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: config(flag) });
    const e = env;
    const { a, b, queued } = await aVerifyingBQueued(e);

    // (e) fleet: B's queued verify is a wait with its age and deadline.
    const fleet = await e.fleet.json(["fleet"]);
    const waiting = (fleet.reply.data as { waiting?: { task: string; wait: string; age: string; deadline: string }[] }).waiting ?? [];
    const wait = waiting.find((w) => w.wait === "verify_queue");
    expect(wait, JSON.stringify(fleet.reply.data)).toMatchObject({ task: b.task });
    expect(wait!.age).toMatch(/^\d+s$/);
    expect(wait!.deadline).toMatch(/^in \d+m$/);

    // The cancel the 2026-11-06 stall saw: GitHub read the older head as the drain checked it.
    const head = query<{ head_sha: string }>(e, "SELECT head_sha FROM verify_queue WHERE id = ?1", queued)[0]!.head_sha;
    exec(e, "INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) SELECT 'a-older', task_id, kind, ref, '0123abcd' || substr(head_sha, 9), 0 FROM artifacts WHERE task_id = ?1 AND head_sha = ?2 LIMIT 1", b.task, head);
    exec(e, "UPDATE verify_queue SET state = 'cancelled', detail = ?2, ended_at = ?3 WHERE id = ?1", queued, `the PR head moved from ${head.slice(0, 8)} to 0123abcd; verify the new head`, String(Date.now()));
    await waitUntil(() => query(e, "SELECT 1 FROM events WHERE kind = 'auto_merge.verify_requeued' AND task_id = ?1", b.task).length === 1, 15_000, "B's verify queued again");
    const row = autoRow(e, b.run)!;
    expect(row.state).toBe("queued");
    expect(row.request_id).not.toBe(queued);
    // A still holds the slot: the requeue did not wait for anything to finish.
    expect(autoRow(e, a.run)?.state).toBe("verifying");

    await bothLand(e, flag, a.run, b.run);
    expect(query(e, "SELECT 1 FROM events WHERE kind = 'auto_merge.verify_requeued' AND task_id = ?1", b.task)).toHaveLength(1);
    expect(query(e, "SELECT id FROM items WHERE kind = 'auto_merge_held'")).toEqual([]);
  },
  { timeout: 120_000 },
);

test(
  "a restart that drops a queued verify: the next daemon queues it again and the merge completes",
  async () => {
    const flag = flagFile();
    env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: config(flag) });
    const e = env;
    const { a, b, queued } = await aVerifyingBQueued(e);

    await e.fleet.daemon.stop();
    exec(e, "DELETE FROM verify_queue WHERE id = ?1", queued);
    await e.fleet.restartDaemon();

    await waitUntil(() => query(e, "SELECT 1 FROM events WHERE kind = 'auto_merge.verify_requeued' AND task_id = ?1", b.task).length === 1, 30_000, "B's lost verify queued again");
    const payload = JSON.parse(query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'auto_merge.verify_requeued' AND task_id = ?1", b.task)[0]!.payload) as { why: string };
    expect(payload.why).toContain(`its verify request ${queued} is gone`);
    await bothLand(e, flag, a.run, b.run);
  },
  { timeout: 150_000 },
);
