import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMutation, listTasks, parseListOutput, processRunner, taskFromJson, tasksAxiVersion } from "../../src/journal/tasks-axi.ts";
import { diffTasks, intentErased, normalizedTitle } from "../../src/journal/diff.ts";
import type { AppliedPayload } from "../../src/journal/journal.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { realTasksAxi } from "../helpers/harness.ts";

const LIST_OUTPUT = `count: 3
tasks[3]{id,state,kind,repo,title,body,priority,created,closed,deps,held,hold_kind,hold_reason,hold_until,links}:
  dep-a,in_flight,task,"-",dep a,"","-",2026-09-23,"-",none,no,"-","-","-",none
  main-c,queued,ship,web,"main, c","l1\\nl2",1,2026-09-23,"-","blocked-by:dep-a,blocked-by:dep-b",yes,captain,wait for x,2026-12-01,none
  dep-b,done,task,"-","dep b https://github.com/o/r/pull/7","","-",2026-09-23,2026-09-23,none,no,"-","-","-","pr:https://github.com/o/r/pull/7"
help[1]:
  - Run \`tasks-axi show <id>\` for full notes on a task
`;

describe("reading tasks-axi", () => {
  test("parses list TOON, including quoted commas, escaped newlines, dashes and lists", () => {
    const tasks = parseListOutput(LIST_OUTPUT);
    expect(tasks.map((t) => t.id)).toEqual(["dep-a", "main-c", "dep-b"]);
    const main = tasks[1]!;
    expect(main).toMatchObject({ title: "main, c", body: "l1\nl2", priority: 1, repo: "web", state: "queued" });
    expect(main.deps).toEqual(["blocked-by:dep-a", "blocked-by:dep-b"]);
    expect(main.hold).toEqual({ kind: "captain", reason: "wait for x", until: "2026-12-01" });
    expect(tasks[0]!.hold).toBeNull();
    expect(tasks[0]!.repo).toBeNull();
    expect(tasks[2]!.links).toEqual(["pr:https://github.com/o/r/pull/7"]);
  });

  test("an empty backlog reads as no tasks", () => {
    expect(parseListOutput("count: 0\ntasks: 0 tasks in this backlog\n")).toEqual([]);
  });

  test("the title read back after done --pr is not a hand edit (M0 finding 7)", () => {
    const [done] = parseListOutput(LIST_OUTPUT).slice(2);
    expect(normalizedTitle(done!)).toBe("dep b");
    const before = { ...done!, title: "dep b", links: [] };
    expect(diffTasks([before], [done!]).changed).toEqual([{ id: "dep-b", fields: ["links"] }]);
  });

  test("mutation JSON normalizes to the same shape as list rows", () => {
    const task = taskFromJson({
      id: "main-c",
      title: "main c",
      state: "queued",
      kind: "ship",
      repo: "web",
      priority: 1,
      created: "2026-09-23",
      closed: null,
      deps: [{ type: "blocked-by", id: "dep-a" }],
      hold: { reason: "wait", kind: "captain", until: null },
      links: [{ kind: "pr", url: "https://x/pull/1" }],
      body: null,
    });
    expect(task).toMatchObject({ body: "", deps: ["blocked-by:dep-a"], links: ["pr:https://x/pull/1"], hold: { kind: "captain", reason: "wait", until: null } });
  });
});

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("classifying tasks-axi results", () => {
  test("success needs exit 0 and an ok JSON result", () => {
    expect(classifyMutation(ok('{"ok":true,"task":{}}')).ok).toBe(true);
    expect(classifyMutation(ok("not json"))).toMatchObject({ ok: false, kind: "transient", code: "BAD_OUTPUT" });
  });
  test("a lock timeout, a timeout and a spawn failure are transient", () => {
    expect(classifyMutation({ exitCode: 1, stdout: "error: backlog is locked\ncode: LOCKED\n", stderr: "", timedOut: false })).toMatchObject({ kind: "transient", code: "LOCKED" });
    expect(classifyMutation({ exitCode: null, stdout: "", stderr: "", timedOut: true })).toMatchObject({ kind: "transient", code: "TIMEOUT" });
    expect(classifyMutation({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" })).toMatchObject({ kind: "transient", code: "SPAWN_FAILED" });
  });
  test("validation errors and missing tasks are permanent", () => {
    expect(classifyMutation({ exitCode: 1, stdout: 'error: "Task \\"x\\" not found"\ncode: NOT_FOUND\n', stderr: "", timedOut: false })).toMatchObject({ kind: "permanent", code: "NOT_FOUND" });
    expect(classifyMutation({ exitCode: 2, stdout: 'error: "--priority must be 0-4"\ncode: VALIDATION_ERROR\n', stderr: "", timedOut: false })).toMatchObject({
      kind: "permanent",
      message: "--priority must be 0-4",
    });
  });
});

function applied(verb: AppliedPayload["verb"], pre: BacklogTask | null, post: BacklogTask | null, flags: Record<string, string> = {}): AppliedPayload {
  return { intent: "I", file: "todos", verb, args: { positional: ["t"], flags }, already: false, pre, post, preHash: null };
}

describe("erased-intent detection", () => {
  const base: BacklogTask = { id: "t", title: "t", state: "queued", kind: "todo", repo: null, priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [] };

  test("an add is erased when the task is gone", () => {
    expect(intentErased(applied("add", null, base), undefined)).toBe(true);
    expect(intentErased(applied("add", null, base), base)).toBe(false);
  });

  test("a done is erased when the task reads exactly as before it", () => {
    const done: BacklogTask = { ...base, state: "done" };
    expect(intentErased(applied("done", base, done), base)).toBe(true);
    expect(intentErased(applied("done", base, done), done)).toBe(false);
    // Your own different edit wins: in flight is neither before nor after.
    expect(intentErased(applied("done", base, done), { ...base, state: "in_flight" })).toBe(false);
    // A no-op (already done) is never re-applied.
    expect(intentErased(applied("done", done, done), base)).toBe(false);
  });

  test("an update is erased only on the fields it set", () => {
    const post = { ...base, body: "due: 2026-10-01" };
    const erased = applied("update", base, post, { body: "due: 2026-10-01" });
    expect(intentErased(erased, { ...base, title: "renamed by hand" })).toBe(true);
    expect(intentErased(erased, { ...base, body: "due: 2026-12-01" })).toBe(false);
  });
});

describe("against the real tasks-axi", () => {
  test("reports its version and reads a missing file as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-tx-"));
    try {
      const runner = processRunner(realTasksAxi(), Bun.which("node"));
      expect(await tasksAxiVersion(runner)).toMatch(/^\d+\.\d+\.\d+$/);
      expect(await listTasks(runner, join(dir, "missing.md"))).toEqual([]);
      const add = classifyMutation(await runner.run(["add", "x-a1", "call (bank)", "--kind", "todo", "--body", "due: 2026-09-20\nnotes", "--file", join(dir, "t.md"), "--json"]));
      expect(add.ok).toBe(true);
      const [task] = await listTasks(runner, join(dir, "t.md"));
      expect(task).toMatchObject({ id: "x-a1", title: "call (bank)", body: "due: 2026-09-20\nnotes", kind: "todo", state: "queued" });
      const again = classifyMutation(await runner.run(["add", "x-a1", "call (bank)", "--kind", "todo", "--file", join(dir, "t.md"), "--json"]));
      expect(again.ok && again.json.already).toBe(true);
      const bad = classifyMutation(await runner.run(["add", "x-b2", "since (since 2026-01-01)", "--file", join(dir, "t.md"), "--json"]));
      expect(bad).toMatchObject({ ok: false, kind: "permanent", code: "VALIDATION_ERROR" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
