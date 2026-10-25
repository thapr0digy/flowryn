import { afterEach, describe, expect, test } from "bun:test";
import type { FakePr } from "../helpers/fake-github.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * `dispatch --after` (docs/notes/2026-10-25-when-x-then-yv.md): a task filed
 * Queued until a PR merges or a scout's report lands, started by the
 * scheduler once the delivery watcher's pass fires its watch.
 */

const envs: ShipEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function shipEnv(extraConfig?: string): Promise<ShipEnv> {
  const env = await makeShipEnv(extraConfig ? { extraConfig } : {});
  envs.push(env);
  return env;
}

function query<T>(env: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = env.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function runsOf(env: ShipEnv, task: string): { id: string; state: string }[] {
  return query(env, "SELECT id, state FROM runs WHERE task_id = ?1", task);
}

function watchOf(env: ShipEnv, waiter: string): { id: string; task_id: string; state: string; detail: string | null } {
  return query<{ id: string; task_id: string; state: string; detail: string | null }>(env, "SELECT id, task_id, state, detail FROM watches WHERE waiter_task = ?1", waiter)[0]!;
}

function openPr(env: ShipEnv, number: number): FakePr {
  return env.github.addPr("acme/web", { number, headRef: `other-work-${number}`, headSha: "a".repeat(40) });
}

function merge(pr: FakePr): void {
  pr.state = "closed";
  pr.merged = true;
  pr.mergeSha = "b".repeat(40);
  pr.mergedAt = new Date().toISOString();
}

async function fileAfter(env: ShipEnv, after: string[], body = "After the API lands\nFAKE: sleep 60000"): Promise<{ code: number; data: Record<string, unknown>; hints: string[]; error: string }> {
  const flags = after.flatMap((a) => ["--after", a]);
  const filed = await env.fleet.json(["dispatch", "web", "--kind", "ship", ...flags, "--body-file", "-"], { stdin: body });
  return { code: filed.code, data: (filed.reply.data ?? {}) as Record<string, unknown>, hints: (filed.reply.hints ?? []) as string[], error: JSON.stringify(filed.reply) };
}

/** A few delivery-watcher passes ([github] poll_ms = 300) went by. */
async function passes(env: ShipEnv, n = 4): Promise<void> {
  await Bun.sleep(300 * n);
}

describe("dispatch --after pr:<n>", () => {
  test("files the task Queued behind a held watch task, and starts it by itself once the PR merges", async () => {
    const env = await shipEnv();
    const pr = openPr(env, 41);
    const filed = await fileAfter(env, ["pr:41"]);
    expect(filed.code).toBe(0);
    const task = filed.data.task as string;
    const watch = watchOf(env, task);
    expect(filed.data).toMatchObject({ state: "queued", auto: "on", waits_for: [`PR #41 to merge (${watch.task_id})`] });
    expect(watch.state).toBe("open");
    // The watch task's add and hold go out before the waiting task's add names it in --blocked-by.
    const intents = query<{ task_id: string; verb: string; args: string }>(env, "SELECT task_id, verb, args FROM intents WHERE task_id IN (?1, ?2) ORDER BY seq", watch.task_id, task);
    expect(intents.map((i) => `${i.task_id === task ? "waiter" : "watch"} ${i.verb}`)).toEqual(["watch add", "watch hold", "waiter add"]);
    expect(intents[2]!.args).toContain(watch.task_id);
    await waitUntil(() => query(env, "SELECT 1 FROM intents WHERE task_id = ?1 AND state = 'applied' AND verb = 'add'", task).length === 1, 15_000, "the waiting task in the backlog");

    await passes(env);
    expect(runsOf(env, task)).toEqual([]);
    const shown = await env.fleet.json(["show", task]);
    expect(shown.reply.data).toMatchObject({ state: "queued", status: "waiting", waits: [`PR #41 to merge (${watch.task_id})`] });
    const fleet = await env.fleet.cli(["fleet"]);
    expect(fleet.stdout).toContain("PR #41 to merge");
    expect(fleet.stdout).not.toContain(`${watch.task_id},`);

    merge(pr);
    await waitUntil(() => runsOf(env, task).length === 1, 20_000, "the waiting task started");
    expect(watchOf(env, task)).toMatchObject({ state: "fired", detail: "merged on GitHub" });
    expect(query(env, "SELECT kind FROM events WHERE kind IN ('watch.opened','watch.fired','phase.started') AND task_id IN (?1, ?2) ORDER BY seq", watch.task_id, task)).toEqual([
      { kind: "watch.opened" },
      { kind: "watch.fired" },
      { kind: "phase.started" },
    ]);
    const verbs = query<{ verb: string }>(env, "SELECT verb FROM intents WHERE task_id = ?1 ORDER BY seq", watch.task_id).map((r) => r.verb);
    expect(verbs).toEqual(["add", "hold", "unhold", "done"]);
    const shownWatch = await env.fleet.json(["show", watch.id]);
    expect(shownWatch.reply.data).toMatchObject({ watch: watch.id, task: watch.task_id, waits_for: "PR #41 to merge", waiter: task });
    expect(String((shownWatch.reply.data as { state: string }).state)).toStartWith("fired");
  }, 90_000);

  test("a PR already merged is accepted and fires on the next pass", async () => {
    const env = await shipEnv();
    merge(openPr(env, 42));
    const filed = await fileAfter(env, ["pr:42"]);
    expect(filed.code).toBe(0);
    await waitUntil(() => runsOf(env, filed.data.task as string).length === 1, 20_000, "the waiting task started");
  }, 90_000);

  test("a PR closed unmerged after dispatch: one P1, the task stays Queued; reopened, the P1 closes", async () => {
    const env = await shipEnv();
    const pr = openPr(env, 43);
    const filed = await fileAfter(env, ["pr:43"]);
    const task = filed.data.task as string;
    const watch = watchOf(env, task);
    pr.state = "closed";
    await waitUntil(() => query(env, "SELECT 1 FROM items WHERE kind = 'watch_stuck' AND state IN ('open','presented')").length === 1, 15_000, "the stuck P1");
    const line = query<{ line: string }>(env, "SELECT line FROM items WHERE kind = 'watch_stuck'")[0]!.line;
    expect(line).toContain(`${task} waits for PR #43 to merge, but it was closed without merging`);
    await passes(env);
    expect(query(env, "SELECT 1 FROM items WHERE kind = 'watch_stuck'")).toHaveLength(1);
    expect(runsOf(env, task)).toEqual([]);
    expect(watchOf(env, task).state).toBe("open");
    pr.state = "open";
    await waitUntil(() => query(env, "SELECT 1 FROM items WHERE kind = 'watch_stuck' AND state IN ('open','presented')").length === 0, 15_000, "the stuck P1 closed");
    expect(watchOf(env, task)).toMatchObject({ id: watch.id, state: "open", detail: null });
  }, 90_000);

  test("refusals: an unknown form, a PR GitHub does not know, a closed PR, a scout as task:, a ship as report:", async () => {
    const env = await shipEnv();
    const unknown = await fileAfter(env, ["merge:41"]);
    expect(unknown.code).toBe(3);
    expect(unknown.error).toContain("task:<id> (it lands), pr:<number> (it merges) or report:<scout task>");
    const missing = await fileAfter(env, ["pr:999"]);
    expect(missing.code).not.toBe(0);
    expect(missing.error).toContain("no PR #999 in acme/web");
    const closed = openPr(env, 44);
    closed.state = "closed";
    const refused = await fileAfter(env, ["pr:44"]);
    expect(refused.code).toBe(3);
    expect(refused.error).toContain("closed without merging");
    const scout = await env.fleet.dispatch("Scout it\nFAKE: sleep 60000", { kind: "scout" });
    const asTask = await fileAfter(env, [`task:${scout.task}`]);
    expect(asTask.code).toBe(3);
    expect(asTask.error).toContain(`--after report:${scout.task}`);
    const ship = await env.fleet.dispatch("Ship it\nFAKE: sleep 60000", { kind: "ship" });
    const asReport = await fileAfter(env, [`report:${ship.task}`]);
    expect(asReport.code).toBe(3);
    expect(asReport.error).toContain("not a scout");
    const scoutOnly = await env.fleet.json(["dispatch", "web", "--kind", "scout", "--after", "pr:41", "--body-file", "-"], { stdin: "Scout" });
    expect(scoutOnly.code).toBe(3);
    // Nothing was filed by any refusal.
    expect(query(env, "SELECT id FROM watches")).toEqual([]);
  }, 90_000);

  test("dropping the waiting task closes its watch and removes the watch task from the backlog", async () => {
    const env = await shipEnv();
    openPr(env, 45);
    const filed = await fileAfter(env, ["pr:45"]);
    const task = filed.data.task as string;
    const watch = watchOf(env, task);
    await waitUntil(() => query(env, "SELECT 1 FROM intents WHERE task_id IN (?1, ?2) AND state != 'applied'", task, watch.task_id).length === 0, 15_000, "the backlog writes applied");
    const dropped = await env.fleet.json(["drop", task, "--body-file", "-"], { stdin: "not needed after all" });
    expect(dropped.code).toBe(0);
    await waitUntil(() => watchOf(env, task).state === "closed", 15_000, "the watch closed");
    expect(watchOf(env, task).detail).toBe(`${task} was dropped`);
    await waitUntil(() => query(env, "SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'rm' AND state = 'applied'", watch.task_id).length === 1, 15_000, "the watch task removed");
  }, 90_000);

  test("dropping the watch task with --unblock skips the wait: the task starts", async () => {
    // A drop kicks no scheduler pass: the start comes with the next steady one.
    const env = await shipEnv("[sched]\npass_ms = 250");
    openPr(env, 46);
    const filed = await fileAfter(env, ["pr:46"]);
    const task = filed.data.task as string;
    const watch = watchOf(env, task);
    await waitUntil(() => query(env, "SELECT 1 FROM intents WHERE task_id IN (?1, ?2) AND state != 'applied'", task, watch.task_id).length === 0, 15_000, "the backlog writes applied");
    const dropped = await env.fleet.json(["drop", watch.task_id, "--unblock", "--body-file", "-"], { stdin: "start it now" });
    expect(dropped.code).toBe(0);
    await waitUntil(() => runsOf(env, task).length === 1, 20_000, "the waiting task started");
    await waitUntil(() => watchOf(env, task).state === "closed", 15_000, "the watch closed");
    expect(watchOf(env, task).detail).toBe("its task was dropped");
  }, 90_000);

  test("a project whose autonomy is manual: the watch fires but the task waits for dispatch --task", async () => {
    const env = await shipEnv();
    expect((await env.fleet.json(["project", "set", "web", "--autonomy", "manual"])).code).toBe(0);
    const pr = openPr(env, 47);
    const filed = await fileAfter(env, ["pr:47"]);
    const task = filed.data.task as string;
    expect(filed.hints.join(" ")).toContain("autonomy is manual");
    merge(pr);
    await waitUntil(() => watchOf(env, task).state === "fired", 15_000, "the watch fired");
    await passes(env);
    expect(runsOf(env, task)).toEqual([]);
    const started = await env.fleet.json(["dispatch", "web", "--task", task]);
    expect(started.code).toBe(0);
  }, 90_000);

  test("a fired watch survives a daemon restart, and the task starts once, not twice", async () => {
    const env = await shipEnv("[sched]\npass_ms = 250");
    expect((await env.fleet.json(["project", "set", "web", "--autonomy", "manual"])).code).toBe(0);
    const pr = openPr(env, 49);
    const filed = await fileAfter(env, ["pr:49"]);
    const task = filed.data.task as string;
    merge(pr);
    await waitUntil(() => watchOf(env, task).state === "fired", 15_000, "the watch fired");
    await env.fleet.restartDaemon();
    expect(watchOf(env, task).state).toBe("fired");
    expect((await env.fleet.json(["project", "set", "web", "--autonomy", "plan"])).code).toBe(0);
    await waitUntil(() => runsOf(env, task).length === 1, 20_000, "the waiting task started");
    await passes(env);
    expect(runsOf(env, task)).toHaveLength(1);
    expect(query(env, "SELECT 1 FROM events WHERE kind = 'watch.fired'")).toHaveLength(1);
  }, 90_000);
});

describe("dispatch --after report:<scout>", () => {
  test("starts the task once the scout's report lands", async () => {
    const env = await shipEnv();
    const scout = await env.fleet.dispatch("Scout the cache\nFAKE: wait-file go\nFAKE: deliver report.md # Findings\\n\\nUse SQLite.", { kind: "scout" });
    const filed = await fileAfter(env, [`report:${scout.task}`]);
    expect(filed.code).toBe(0);
    const task = filed.data.task as string;
    expect(filed.data).toMatchObject({ waits_for: [`the report of ${scout.task} (${watchOf(env, task).task_id})`] });
    await passes(env);
    expect(runsOf(env, task)).toEqual([]);
    const run = env.fleet.run(scout.run);
    await Bun.write(`${env.fleet.h.dataDir}/${scout.task}/go`, "");
    await env.fleet.waitRun(run.id, (r) => r.state === "landed" || r.state === "cleaned", "the scout landed", 30_000);
    await waitUntil(() => runsOf(env, task).length === 1, 20_000, "the waiting task started");
    expect(watchOf(env, task).detail).toStartWith("report landed");
  }, 90_000);

  test("with task: and pr: together, it waits for every event", async () => {
    const env = await shipEnv();
    const pr = openPr(env, 48);
    const first = await env.fleet.dispatch("First ship\nFAKE: sleep 60000", { kind: "ship" });
    const filed = await fileAfter(env, [`task:${first.task}`, "pr:48"]);
    expect(filed.code).toBe(0);
    const task = filed.data.task as string;
    expect(filed.data).toMatchObject({ blocked_by: [first.task] });
    merge(pr);
    await waitUntil(() => watchOf(env, task).state === "fired", 15_000, "the watch fired");
    await passes(env);
    expect(runsOf(env, task)).toEqual([]);
    const shown = await env.fleet.json(["show", task]);
    expect(shown.reply.data).toMatchObject({ status: "waiting", waits: [first.task] });
  }, 90_000);
});
