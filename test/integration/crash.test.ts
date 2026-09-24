/**
 * M1 exit test (design section 17): kill -9 of the daemon mid-journal loses
 * nothing. Every intent the daemon committed reaches tasks-axi exactly once,
 * in order, after a restart; nothing the CLI was told succeeded goes missing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentRow } from "../../src/journal/journal.ts";
import { listTasks, processRunner, type BacklogTask } from "../../src/journal/tasks-axi.ts";
import { cliJson, makeHome, makePausingTasksAxi, realTasksAxi, seedLeader, startDaemon, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
const orphans: number[] = [];
afterEach(async () => {
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, 9);
    } catch {
      // already gone
    }
  }
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

async function todos(h: TestHome): Promise<BacklogTask[]> {
  return listTasks(processRunner(realTasksAxi(), Bun.which("node")), h.todos);
}

function journalRows(h: TestHome): IntentRow[] {
  const db = h.db();
  const rows = db.query("SELECT * FROM intents ORDER BY seq").all() as IntentRow[];
  db.close();
  return rows;
}

async function boot(h: TestHome): Promise<DaemonProc> {
  const d = await startDaemon(h);
  daemons.push(d);
  return d;
}

/** Kill the daemon with SIGKILL, and the paused tasks-axi wrapper too when `withChild` (a machine crash). */
async function crash(d: DaemonProc, ctl: string, withChild: boolean): Promise<void> {
  await d.kill9();
  daemons.splice(daemons.indexOf(d), 1);
  const pidFile = join(ctl, "wrapper.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (withChild) {
      try {
        process.kill(pid, 9);
      } catch {
        // already gone
      }
    } else orphans.push(pid);
  }
}

function disarm(ctl: string): void {
  for (const f of ["pause-before", "pause-after", "pause-at", "in-before", "in-after", "wrapper.pid"]) rmSync(join(ctl, f), { force: true });
  writeFileSync(join(ctl, "release"), "");
}

function setupPausing(): { h: TestHome; ctl: string; env: Record<string, string> } {
  const probe = makeHome();
  const wrapper = makePausingTasksAxi(probe.home);
  const h = makeHome({ tasksAxi: wrapper.path });
  homes.push(probe, h);
  return { h, ctl: wrapper.ctl, env: { FLOWRYN_TOKEN: seedLeader(h) } };
}

describe("kill -9 mid-journal loses nothing", () => {
  test("killed after tasks-axi wrote but before the intent was marked applied", async () => {
    const { h, ctl, env } = setupPausing();
    writeFileSync(join(ctl, "pause-after"), "");
    const d = await boot(h);
    const call = cliJson(h, ["todo", "add", "pay rent"], { env });
    await waitUntil(() => existsSync(join(ctl, "in-after")), 10_000, "tasks-axi to finish its write");
    await crash(d, ctl, false);
    await call;

    // The file has the to-do; the journal still says pending.
    expect((await todos(h)).map((t) => t.title)).toEqual(["pay rent"]);
    expect(journalRows(h).map((i) => i.state)).toEqual(["pending"]);

    disarm(ctl);
    await boot(h);
    const rows = journalRows(h);
    expect(rows.map((i) => i.state)).toEqual(["applied"]);
    expect((await todos(h)).map((t) => t.title)).toEqual(["pay rent"]);
    const db = h.db();
    const applied = JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'intent.applied'").get() as { payload: string }).payload);
    db.close();
    expect(applied.already).toBe(true);
  }, 60_000);

  test("killed while tasks-axi had not run yet (the child dies too)", async () => {
    const { h, ctl, env } = setupPausing();
    writeFileSync(join(ctl, "pause-before"), "");
    const d = await boot(h);
    const call = cliJson(h, ["todo", "add", "water plants"], { env });
    await waitUntil(() => existsSync(join(ctl, "in-before")), 10_000, "the journal to start tasks-axi");
    await crash(d, ctl, true);
    await call;

    expect(await todos(h)).toEqual([]);
    expect(journalRows(h).map((i) => i.state)).toEqual(["pending"]);

    disarm(ctl);
    await boot(h);
    expect(journalRows(h).map((i) => i.state)).toEqual(["applied"]);
    expect((await todos(h)).map((t) => t.title)).toEqual(["water plants"]);
  }, 60_000);

  test("a queue killed in the middle replays in order, each intent exactly once", async () => {
    const { h, ctl, env } = setupPausing();
    const d = await boot(h);
    const first = await cliJson(h, ["todo", "add", "one"], { env });
    const id = (first.reply.data as { todo: string }).todo;
    // Hold the journal on the third mutation, then queue more behind it.
    writeFileSync(join(ctl, "pause-at"), "3");
    writeFileSync(join(ctl, "pause-before"), "");
    await cliJson(h, ["todo", "add", "two"], { env });
    const pending = [
      cliJson(h, ["todo", "add", "three"], { env }),
      (async () => {
        await waitUntil(() => existsSync(join(ctl, "in-before")), 10_000, "the third mutation");
        return Promise.all([cliJson(h, ["todo", "done", id], { env }), cliJson(h, ["todo", "due", id, "2026-12-24"], { env }), cliJson(h, ["todo", "add", "four"], { env })]);
      })(),
    ];
    // tasks-axi runs under a 10 s timeout, so the crash must land well inside it.
    await waitUntil(() => journalRows(h).length === 6, 8_000, "six committed intents");
    await crash(d, ctl, true);
    await Promise.allSettled(pending);

    const before = journalRows(h);
    expect(before.filter((i) => i.state === "applied").length).toBe(2);
    expect(before.filter((i) => i.state === "pending").length).toBe(4);

    disarm(ctl);
    await boot(h);
    await waitUntil(() => journalRows(h).every((i) => i.state === "applied"), 15_000, "the replay");
    const after = await todos(h);
    expect(after.map((t) => t.title).toSorted()).toEqual(["four", "one", "three", "two"]);
    const one = after.find((t) => t.id === id)!;
    expect(one.state).toBe("done");
    expect(one.body).toBe("due: 2026-12-24");
    // Replay kept seq order: the done and the due update ran after the add they depend on.
    const calls = readFileSync(join(ctl, "calls.log"), "utf8").trim().split("\n");
    const firstAdd = calls.findIndex((c) => c.startsWith(`add ${id} `));
    expect(calls.findIndex((c) => c.startsWith(`done ${id} `))).toBeGreaterThan(firstAdd);
  }, 90_000);

  test("repeated random kills while adding: every committed and every acknowledged to-do lands once", async () => {
    const h = makeHome();
    homes.push(h);
    const env = { FLOWRYN_TOKEN: seedLeader(h) };
    const acknowledged: string[] = [];
    for (let round = 0; round < 4; round++) {
      const d = await boot(h);
      const calls = [0, 1, 2].map((n) => cliJson(h, ["todo", "add", `round ${round} item ${n}`], { env }));
      await Bun.sleep(40 + Math.floor(Math.random() * 250));
      await d.kill9();
      daemons.splice(daemons.indexOf(d), 1);
      for (const result of await Promise.allSettled(calls)) {
        if (result.status === "fulfilled" && result.value.code === 0) acknowledged.push((result.value.reply.data as { todo: string }).todo);
      }
    }
    await boot(h);
    await waitUntil(() => journalRows(h).every((i) => i.state === "applied"), 20_000, "every committed intent to apply");
    const committed = journalRows(h).map((i) => i.task_id!);
    const landed = (await todos(h)).map((t) => t.id);
    expect(new Set(landed).size).toBe(landed.length);
    expect(landed.toSorted()).toEqual(committed.toSorted());
    for (const id of acknowledged) expect(landed).toContain(id);
  }, 120_000);
});
