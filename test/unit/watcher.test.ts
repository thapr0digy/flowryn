import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { findOpenItem } from "../../src/attention/items.ts";
import { hashToken } from "../../src/api/auth.ts";
import { tx } from "../../src/db/db.ts";
import { MAX_REAPPLY_DEPTH } from "../../src/journal/watcher.ts";
import { readSnapshot } from "../../src/journal/snapshot.ts";
import { countOccurrences } from "../helpers/harness.ts";
import { eventKinds, intents, makeJournalEnv, type JournalEnv } from "../helpers/journal-env.ts";

let env: JournalEnv;
afterEach(async () => {
  await env.cleanup();
});

function addTodo(id: string, title: string, body?: string) {
  return env.record({ file: "todos", verb: "add", taskId: id, positional: [id, title], flags: { kind: "todo", ...(body ? { body } : {}) } });
}

function lastEventPayload(kind: string): Record<string, unknown> {
  const row = env.db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq DESC LIMIT 1").get(kind) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

describe("backlog watcher (fake hand edits)", () => {
  test("the first read is a baseline; an unchanged hash is a no-op", async () => {
    env = makeJournalEnv();
    expect((await env.watcher.check("todos", "test")).outcome).toBe("baseline");
    expect((await env.watcher.check("todos", "test")).outcome).toBe("unchanged");
    addTodo("a-a1", "journal write");
    await env.journal.drain();
    // The journal's own write is not an edit: it stored the new hash.
    expect((await env.watcher.check("todos", "test")).outcome).toBe("unchanged");
    expect(eventKinds(env.db)).not.toContain("backlog.edited");
  });

  test("your edit wins: title, body and done state edited by hand are recorded, not reverted", async () => {
    env = makeJournalEnv({ eraseWindowMs: 0 });
    addTodo("a-a1", "old title", "due: 2026-09-20");
    addTodo("b-b1", "stays");
    await env.journal.drain();
    const edited = readFileSync(env.files.todos, "utf8")
      .replace("old title", "new title")
      .replace("due: 2026-09-20", "due: 2026-10-05")
      .replace("## Done", "- [ ] hand-c1 - added by hand (kind: todo) (since 2026-09-23)\n## Done");
    writeFileSync(env.files.todos, edited);
    const result = await env.watcher.check("todos", "test");
    expect(result.outcome).toBe("edited");
    expect(result.diff!.added).toEqual(["hand-c1"]);
    expect(result.diff!.changed).toEqual([{ id: "a-a1", fields: ["title", "body"] }]);
    expect(result.reapplied).toEqual([]);
    const snapshot = readSnapshot(env.db, "todos")!;
    expect(snapshot.tasks.find((t) => t.id === "a-a1")).toMatchObject({ title: "new title", body: "due: 2026-10-05" });
    expect(lastEventPayload("backlog.edited")).toMatchObject({ file: "todos", added: ["hand-c1"] });
  });

  test("a stale editor buffer that erased a CLI write gets the intent applied again", async () => {
    env = makeJournalEnv();
    addTodo("a-a1", "before the editor opened");
    await env.journal.drain();
    const staleBuffer = readFileSync(env.files.todos, "utf8");
    addTodo("b-b1", "added by the CLI while the editor was open");
    env.record({ file: "todos", verb: "done", taskId: "a-a1", positional: ["a-a1"] });
    await env.journal.drain();
    // The editor saves its stale copy over both CLI writes.
    writeFileSync(env.files.todos, staleBuffer);
    const result = await env.watcher.check("todos", "test");
    expect(result.reapplied!.length).toBe(2);
    await env.journal.drain();
    const tasks = readSnapshot(env.db, "todos")!.tasks;
    expect(tasks.find((t) => t.id === "b-b1")).toBeDefined();
    expect(tasks.find((t) => t.id === "a-a1")!.state).toBe("done");
    expect(countOccurrences(readFileSync(env.files.todos, "utf8"), "b-b1")).toBe(1);
    expect(eventKinds(env.db).filter((k) => k === "intent.reapplied").length).toBe(2);
  });

  test("a rewound task gets every later intent back, in order", async () => {
    env = makeJournalEnv();
    addTodo("a-a1", "task", "notes");
    await env.journal.drain();
    const staleBuffer = readFileSync(env.files.todos, "utf8");
    env.record({ file: "todos", verb: "update", taskId: "a-a1", positional: ["a-a1"], flags: { body: "due: 2026-10-01\nnotes" } });
    env.record({ file: "todos", verb: "update", taskId: "a-a1", positional: ["a-a1"], flags: { body: "due: 2026-10-05\nnotes" } });
    await env.journal.drain();
    writeFileSync(env.files.todos, staleBuffer);
    await env.watcher.check("todos", "test");
    await env.journal.drain();
    expect(readSnapshot(env.db, "todos")!.tasks[0]!.body).toBe("due: 2026-10-05\nnotes");
  });

  test("outside the erase window the file is taken as your edit", async () => {
    env = makeJournalEnv({ eraseWindowMs: 60_000 });
    addTodo("a-a1", "task");
    await env.journal.drain();
    env.clock.now += 120_000;
    writeFileSync(env.files.todos, "# Backlog\n\n## In flight\n## Queued\n## Done\n");
    const result = await env.watcher.check("todos", "test");
    expect(result.diff!.removed).toEqual(["a-a1"]);
    expect(result.reapplied).toEqual([]);
  });

  test("an editor that keeps winning is left alone after the re-apply cap", async () => {
    env = makeJournalEnv();
    const empty = "# Backlog\n\n## In flight\n## Queued\n## Done\n";
    writeFileSync(env.files.todos, empty);
    await env.watcher.check("todos", "baseline");
    addTodo("a-a1", "task");
    await env.journal.drain();
    let reapplies = 0;
    for (let round = 0; round < MAX_REAPPLY_DEPTH + 2; round++) {
      writeFileSync(env.files.todos, empty);
      const result = await env.watcher.check("todos", "test");
      reapplies += result.reapplied?.length ?? 0;
      await env.journal.drain();
    }
    expect(reapplies).toBe(MAX_REAPPLY_DEPTH);
  });

  test("a hand edit that contradicts a live run opens one divergence and leaves the run alone", async () => {
    env = makeJournalEnv();
    const now = env.clock.now;
    tx(env.db, () => {
      env.db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', '/w', 'main', 'no-mistakes')").run();
      env.db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('fix-a1', 'web', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
      env.db
        .query(
          `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
           VALUES ('r1', 'fix-a1', 'claude', 'v', 'running', 'busy', 'fix', 'build', '/wt', 'b', 's', ?1, ?2, ?2)`,
        )
        .run(hashToken("t"), now);
    });
    env.record({ file: "backlog", verb: "add", taskId: "fix-a1", positional: ["fix-a1", "fix the thing"], flags: { kind: "ship", start: true } });
    await env.journal.drain();
    env.clock.now += 2 * 60 * 60 * 1000; // past the erase window: this is your edit
    // You move the in-flight task back to Queued by hand, with tasks-axi itself.
    await env.runner.real.run(["reopen", "fix-a1", "--file", env.files.backlog, "--json"]);
    const result = await env.watcher.check("backlog", "test");
    expect(result.divergences).toEqual(["d1"]);
    const divergence = env.db.query("SELECT * FROM divergences WHERE id = 'd1'").get() as Record<string, unknown>;
    expect(divergence).toMatchObject({ run_id: "r1", task_id: "fix-a1", higher: "run", lower: "backlog", resolved_at: null });
    expect(findOpenItem(env.db, "divergence", "fix-a1")!.lane).toBe("P1");
    expect((env.db.query("SELECT state FROM runs WHERE id = 'r1'").get() as { state: string }).state).toBe("running");
    // A further edit does not open a second divergence for the same run.
    await env.runner.real.run(["hold", "fix-a1", "--reason", "later", "--file", env.files.backlog, "--json"]);
    expect((await env.watcher.check("backlog", "test")).divergences).toEqual([]);
    expect(intents(env.db).length).toBe(1);
  });

  test("the file watch notices an edit without waiting for the periodic check", async () => {
    env = makeJournalEnv({ eraseWindowMs: 0 });
    await env.watcher.start();
    addTodo("a-a1", "task");
    await env.journal.drain();
    writeFileSync(env.files.todos, readFileSync(env.files.todos, "utf8").replace("task", "renamed"));
    const deadline = Date.now() + 5_000;
    while (!eventKinds(env.db).includes("backlog.edited") && Date.now() < deadline) await Bun.sleep(25);
    expect(eventKinds(env.db)).toContain("backlog.edited");
  });
});
