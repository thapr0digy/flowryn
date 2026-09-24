import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findOpenItem, openItems } from "../../src/attention/items.ts";
import { tx } from "../../src/db/db.ts";
import { BACKOFF_MS, FAILURES_BEFORE_ITEM, getIntent, recordIntent } from "../../src/journal/journal.ts";
import { hashFile, readSnapshot } from "../../src/journal/snapshot.ts";
import { countOccurrences } from "../helpers/harness.ts";
import { eventKinds, intents, LOCKED, makeJournalEnv, type JournalEnv } from "../helpers/journal-env.ts";

let env: JournalEnv;
afterEach(async () => {
  await env.cleanup();
});

function addTodo(id: string, title: string, body?: string) {
  return env.record({ file: "todos", verb: "add", taskId: id, positional: [id, title], flags: { kind: "todo", ...(body ? { body } : {}) } });
}

describe("intent journal", () => {
  test("records an intent with its event, then applies it and stores the file hash and parsed snapshot", async () => {
    env = makeJournalEnv();
    const intent = addTodo("milk-a1", "buy milk");
    expect(intent.state).toBe("pending");
    expect(eventKinds(env.db)).toEqual(["intent.recorded"]);
    await env.journal.drain();
    const row = getIntent(env.db, intent.id)!;
    expect(row.state).toBe("applied");
    expect(row.attempts).toBe(1);
    const snapshot = readSnapshot(env.db, "todos")!;
    expect(snapshot.contentHash).toBe(hashFile(env.files.todos));
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["milk-a1"]);
    expect(eventKinds(env.db)).toEqual(["intent.recorded", "intent.applied"]);
    expect(env.runner.mutations()[0]).toEqual(["add", "milk-a1", "buy milk", "--kind", "todo", "--file", env.files.todos, "--json"]);
  });

  test("never issues mv, which is not replay-safe (M0 spike t01)", () => {
    env = makeJournalEnv();
    expect(() => tx(env.db, () => recordIntent(env.db, { file: "todos", verb: "mv" as never, taskId: "x" }))).toThrow("never issues");
  });

  test("applies intents in order per file", async () => {
    env = makeJournalEnv();
    addTodo("a-a1", "first");
    env.record({ file: "todos", verb: "done", taskId: "a-a1", positional: ["a-a1"] });
    env.record({ file: "backlog", verb: "add", taskId: "b-b1", positional: ["b-b1", "task"], flags: { start: true } });
    await env.journal.drain();
    expect(intents(env.db).map((i) => i.state)).toEqual(["applied", "applied", "applied"]);
    expect(readSnapshot(env.db, "todos")!.tasks[0]!.state).toBe("done");
    expect(readSnapshot(env.db, "backlog")!.tasks[0]!.state).toBe("in_flight");
  });

  test("a locked file blocks later intents for that file only, with the backoff schedule", async () => {
    env = makeJournalEnv();
    env.runner.intercept = (args) => (args.includes(env.files.todos) && args[0] !== "list" ? LOCKED : null);
    addTodo("a-a1", "first");
    addTodo("b-b1", "second");
    env.record({ file: "backlog", verb: "add", taskId: "c-c1", positional: ["c-c1", "other file"] });
    await env.journal.drain();
    expect(intents(env.db).map((i) => [i.task_id, i.state, i.attempts])).toEqual([
      ["a-a1", "pending", 1],
      ["b-b1", "pending", 0],
      ["c-c1", "applied", 1],
    ]);
    // Not due yet: nothing runs.
    env.clock.now += BACKOFF_MS[0] - 1;
    await env.journal.drain();
    expect(getIntent(env.db, intents(env.db)[0]!.id)!.attempts).toBe(1);
    env.clock.now += 1;
    await env.journal.drain();
    expect(getIntent(env.db, intents(env.db)[0]!.id)!.attempts).toBe(2);
    expect(eventKinds(env.db).filter((k) => k === "intent.retry").length).toBe(2);
  });

  test("opens one P1 'backlog out of sync' item after five failures and resolves it on success", async () => {
    env = makeJournalEnv();
    env.runner.intercept = (args) => (args[0] === "add" ? LOCKED : null);
    const intent = addTodo("a-a1", "first");
    for (let attempt = 1; attempt <= FAILURES_BEFORE_ITEM + 1; attempt++) {
      await env.journal.drain();
      env.clock.now += 11 * 60_000;
    }
    const item = findOpenItem(env.db, "backlog_out_of_sync", "a-a1")!;
    expect(item).toMatchObject({ lane: "P1", class: "actionable" });
    expect(item.line).toContain(`${env.files.todos}.lock`);
    expect(openItems(env.db).length).toBe(1);
    env.runner.intercept = null;
    await env.journal.drain();
    expect(getIntent(env.db, intent.id)!.state).toBe("applied");
    expect(findOpenItem(env.db, "backlog_out_of_sync", "a-a1")).toBeNull();
  });

  test("a permanent failure marks the intent failed, opens an item and lets the next intent run", async () => {
    env = makeJournalEnv();
    const bad = addTodo("bad-a1", "since (since 2026-01-01)");
    const good = addTodo("good-b1", "fine title");
    await env.journal.drain();
    expect(getIntent(env.db, bad.id)).toMatchObject({ state: "failed" });
    expect(getIntent(env.db, bad.id)!.last_error).toContain("VALIDATION_ERROR");
    expect(getIntent(env.db, good.id)!.state).toBe("applied");
    expect(findOpenItem(env.db, "backlog_out_of_sync", "bad-a1")).not.toBeNull();
  });

  test("a replayed add whose first run already landed is applied, not duplicated", async () => {
    env = makeJournalEnv();
    const intent = addTodo("milk-a1", "buy milk");
    // The crash case: tasks-axi ran, the daemon died before marking the intent applied.
    await env.runner.real.run(["add", "milk-a1", "buy milk", "--kind", "todo", "--file", env.files.todos, "--json"]);
    await env.journal.drain();
    expect(getIntent(env.db, intent.id)!.state).toBe("applied");
    expect(countOccurrences(readFileSync(env.files.todos, "utf8"), "milk-a1")).toBe(1);
    const applied = env.db.query("SELECT payload FROM events WHERE kind = 'intent.applied'").get() as { payload: string };
    expect(JSON.parse(applied.payload).already).toBe(true);
  });

  test("an add that fails permanently but whose task exists counts as applied", async () => {
    env = makeJournalEnv();
    await env.runner.real.run(["add", "x-a1", "exists", "--file", env.files.todos, "--json"]);
    env.runner.intercept = (args) => (args[0] === "add" ? { exitCode: 1, stdout: 'error: "duplicate id"\ncode: NOT_FOUND\n', stderr: "", timedOut: false } : null);
    const intent = addTodo("x-a1", "exists");
    await env.journal.drain();
    expect(getIntent(env.db, intent.id)!.state).toBe("applied");
  });

  test("keeps intents pending while tasks-axi is missing", async () => {
    env = makeJournalEnv({ runnerMissing: true });
    const intent = addTodo("a-a1", "first");
    await env.journal.drain();
    expect(getIntent(env.db, intent.id)).toMatchObject({ state: "pending", attempts: 1 });
    expect(getIntent(env.db, intent.id)!.last_error).toContain("TOOL_MISSING");
  });

  test("awaitSettled resolves on application, or returns the pending row at the timeout", async () => {
    env = makeJournalEnv();
    const intent = addTodo("a-a1", "first");
    const waiting = env.journal.awaitSettled(intent.id, 5_000);
    env.journal.kick();
    expect((await waiting)!.state).toBe("applied");
    env.runner.intercept = () => LOCKED;
    const stuck = addTodo("b-b1", "second");
    env.journal.kick();
    const row = await env.journal.awaitSettled(stuck.id, 200);
    expect(row!.state).toBe("pending");
  });
});
