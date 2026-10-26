import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tx, type Db } from "../../src/db/db.ts";
import { hashFile } from "../../src/journal/snapshot.ts";
import { parseListOutput, type BacklogTask } from "../../src/journal/tasks-axi.ts";
import { loadConfig } from "../../src/config/config.ts";
import { projectScopeById, taskScope } from "../../src/leader/scope.ts";
import { stateFiles } from "../../src/config/paths.ts";
import { tryExclusiveLock } from "../../src/util/flock.ts";
import { cliJson, daemonCall, makeHome, realTasksAxi, REPO_ROOT, startDaemon, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/**
 * `flowryn home adopt` (docs/notes/2026-10-24-leader-scoping-and-vj.md, phase 2)
 * through the real daemon and the real tasks-axi: a fixture work home's
 * projects, queued tasks, to-dos, plans and edges move into a main home with
 * two scopes, under the work scope, and every refusal leaves the main home as
 * it was.
 */

const MAIN = join(REPO_ROOT, "src/main.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-adopt-")));
const WORK = join(root, "work");
const ELSEWHERE = join(root, "elsewhere");
const CLAUDE_WORK = join(root, "claude-work");
const CLAUDE_PERSONAL = join(root, "claude-personal");
for (const dir of [WORK, ELSEWHERE, CLAUDE_WORK, CLAUDE_PERSONAL]) mkdirSync(dir, { recursive: true });

const SCOPES = `
[scopes]
default = "personal"

[scopes.work]
paths = [${JSON.stringify(WORK)}]

[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = ${JSON.stringify(CLAUDE_WORK)}

[accounts.claude-personal]
harness = "claude"
scope = "personal"
config_dir = ${JSON.stringify(CLAUDE_PERSONAL)}
`;

const MAIN_TASK = "main-task-x1";
let main: TestHome;
let daemon: DaemonProc;
const homes: TestHome[] = [];

function axi(file: string, args: string[]): void {
  const done = Bun.spawnSync([realTasksAxi(), ...args, "--file", file, "--json"], { stdin: "ignore", env: process.env });
  if (done.exitCode !== 0) throw new Error(`tasks-axi ${args.join(" ")} failed: ${done.stdout.toString()}${done.stderr.toString()}`);
}

function list(file: string): BacklogTask[] {
  if (!existsSync(file)) return [];
  const out = Bun.spawnSync([realTasksAxi(), "list", "--file", file, "--fields", "body,priority,deps,held,hold_kind,hold_reason,hold_until,links"], { stdin: "ignore", env: process.env });
  return parseListOutput(out.stdout.toString());
}

function withDb<T>(h: TestHome, fn: (db: Db) => T): T {
  const db = h.db();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface OldOptions {
  /** [workers.claude] config_dir; null leaves it out. */
  configDir?: string | null;
  /** The api project's checkout. */
  apiPath?: string;
  /** Change the fixture before the test adopts it. */
  extra?: (old: TestHome, db: Db) => void;
}

/**
 * The work home: projects api and svc; plan p1 (approved) whose phase 1
 * landed and phases 2 and 3 are queued; a held task, a task with no project,
 * a done task; one open and one done to-do.
 */
function makeOldHome(options: OldOptions = {}): TestHome {
  const configDir = options.configDir === undefined ? CLAUDE_WORK : options.configDir;
  const old = makeHome({ extraConfig: configDir === null ? "" : `[workers.claude]\nconfig_dir = ${JSON.stringify(configDir)}\n` });
  homes.push(old);
  const apiPath = options.apiPath ?? join(WORK, "api");
  mkdirSync(apiPath, { recursive: true });
  mkdirSync(join(WORK, "svc"), { recursive: true });
  axi(old.backlog, ["add", "api-phase-one-a1", "Phase one", "--kind", "ship", "--repo", "api"]);
  axi(old.backlog, ["done", "api-phase-one-a1"]);
  axi(old.backlog, ["add", "api-phase-two-a2", "Phase two", "--kind", "ship", "--repo", "api", "--body", "the second phase", "--blocked-by", "api-phase-one-a1"]);
  axi(old.backlog, ["add", "api-phase-three-a3", "Phase three", "--kind", "ship", "--repo", "api", "--blocked-by", "api-phase-two-a2"]);
  axi(old.backlog, ["add", "svc-held-b1", "Held svc work", "--kind", "ship", "--repo", "svc", "--priority", "1"]);
  axi(old.backlog, ["hold", "svc-held-b1", "--reason", "waits for the vendor", "--kind", "external"]);
  axi(old.backlog, ["add", "loose-note-c1", "A note with no project"]);
  axi(old.backlog, ["add", "svc-shipped-d1", "Shipped svc work", "--kind", "ship", "--repo", "svc"]);
  axi(old.backlog, ["done", "svc-shipped-d1"]);
  axi(old.todos, ["add", "call-vendor-t1", "Call the vendor", "--kind", "todo", "--body", "due: 2026-11-01"]);
  axi(old.todos, ["add", "old-chore-t2", "An old chore", "--kind", "todo"]);
  axi(old.todos, ["done", "old-chore-t2"]);
  withDb(old, (db) =>
    tx(db, () => {
      const now = Date.now();
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, autonomy) VALUES ('api', '', ?1, 'main', 'local-only', 'manual')").run(apiPath);
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, autonomy) VALUES ('svc', '', ?1, 'main', 'local-only', 'manual')").run(join(WORK, "svc"));
      for (const [task, project] of [["api-phase-one-a1", "api"], ["api-phase-two-a2", "api"], ["api-phase-three-a3", "api"], ["svc-held-b1", "svc"], ["svc-shipped-d1", "svc"]] as const) {
        db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, auto, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', 1, ?3)").run(task, project, now);
      }
      db.query("INSERT INTO plans (id, project_id, title, state, source_task, filed_by, created_at, approved_at, approved_via, gate_id) VALUES ('p1', 'api', 'The api plan', 'approved', 'api-design-z9', 'worker', ?1, ?1, 'tty', 'g7')").run(now);
      const phases = [
        [1, "api-phase-one-a1", "Phase one", '["api-design-z9"]'],
        [2, "api-phase-two-a2", "Phase two", '["api-phase-one-a1"]'],
        [3, "api-phase-three-a3", "Phase three", '["api-phase-two-a2"]'],
      ] as const;
      for (const [no, task, title, deps] of phases) {
        db.query("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES ('p1', ?1, ?2, ?3, ?3, 'fix', ?4)").run(no, task, title, deps);
      }
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, ended_at)
         VALUES ('r01OLD1', 'api-phase-one-a1', 'claude', '2.1.0', 'cleaned', 'dead', 'fix', 'ship', '/tmp/wt-old', 'flowryn/x', 'abc', 'h', ?1, ?1, ?1)`,
      ).run(now);
      options.extra?.(old, db);
    }),
  );
  return old;
}

async function adopt(old: TestHome | string, scope?: string) {
  return daemonCall(main.home, "home adopt", { home: typeof old === "string" ? old : old.home, ...(scope ? { scope } : {}) });
}

function mainProjects(): string[] {
  return withDb(main, (db) => (db.query("SELECT id FROM projects ORDER BY id").all() as { id: string }[]).map((r) => r.id));
}

beforeAll(async () => {
  main = makeHome({ extraConfig: SCOPES });
  mkdirSync(join(WORK, "shared-main"), { recursive: true });
  axi(main.backlog, ["add", MAIN_TASK, "Main home work"]);
  withDb(main, (db) =>
    tx(db, () => {
      // svc is already registered here at the same path: adoption skips it.
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('svc', '', ?1, 'main', 'local-only')").run(join(WORK, "svc"));
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('shared', '', ?1, 'main', 'local-only')").run(join(WORK, "shared-main"));
      // Plans p1 and p2 exist here already: the adopted plan gets the next free id.
      db.query("INSERT INTO meta (key, value) VALUES ('next_plan_no', '3')").run();
    }),
  );
  mkdirSync(join(WORK, "svc"), { recursive: true });
  daemon = await startDaemon(main);
}, 30_000);

afterAll(async () => {
  await daemon?.stop();
  main?.cleanup();
  for (const h of homes) h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("home adopt", () => {
  test("moves the old home's projects, queued tasks, to-dos, plans and edges in under the work scope", async () => {
    const old = makeOldHome();
    const oldBacklogHash = hashFile(old.backlog);
    const reply = await adopt(old);
    expect(reply.ok).toBe(true);
    const data = reply.data as Record<string, unknown>;
    expect(data.already_adopted).toBe(false);
    expect(data.scope).toBe("work");
    expect(data.projects_added).toEqual(["api"]);
    expect(data.projects_skipped).toEqual(["svc"]);
    expect((data.tasks as string[]).toSorted()).toEqual(["api-phase-three-a3", "api-phase-two-a2", "loose-note-c1", "svc-held-b1"]);
    expect(data.todos).toEqual(["call-vendor-t1"]);
    expect(data.plans).toEqual(["p1 → p3"]);
    expect(data.dropped_edges).toEqual(["api-phase-two-a2 blocked-by api-phase-one-a1 (landed)"]);

    // The journal applies the adds through tasks-axi.
    await waitUntil(() => list(main.backlog).length === 5 && list(main.todos).length === 1, 15_000, "the adopted adds to apply");
    const backlog = new Map(list(main.backlog).map((t) => [t.id, t]));
    expect(backlog.get("api-phase-two-a2")!.deps).toEqual([]);
    expect(backlog.get("api-phase-two-a2")!.body).toBe("the second phase");
    expect(backlog.get("api-phase-three-a3")!.deps).toEqual(["blocked-by:api-phase-two-a2"]);
    expect(backlog.get("svc-held-b1")!.hold).toEqual({ kind: "external", reason: "waits for the vendor", until: null });
    expect(backlog.get("svc-held-b1")!.priority).toBe(1);
    expect(backlog.has("svc-shipped-d1")).toBe(false);
    expect(backlog.has("api-phase-one-a1")).toBe(false);
    const todos = list(main.todos);
    expect(todos.map((t) => [t.id, t.body])).toEqual([["call-vendor-t1", "due: 2026-11-01"]]);

    const config = loadConfig(main.home).config;
    withDb(main, (db) => {
      expect(mainProjects()).toEqual(["api", "shared", "svc"]);
      expect(projectScopeById(db, config, "api")).toBe("work");
      const plan = db.query("SELECT * FROM plans WHERE id = 'p3'").get() as Record<string, unknown>;
      expect(plan).toMatchObject({ project_id: "api", title: "The api plan", state: "approved", source_task: "api-design-z9", gate_id: null });
      const phases = db.query("SELECT phase_no, task_id, blocked_by FROM plan_phases WHERE plan_id = 'p3' ORDER BY phase_no").all();
      expect(phases).toEqual([
        { phase_no: 2, task_id: "api-phase-two-a2", blocked_by: "[]" },
        { phase_no: 3, task_id: "api-phase-three-a3", blocked_by: '["api-phase-two-a2"]' },
      ]);
      const policies = (db.query("SELECT task_id FROM task_policy ORDER BY task_id").all() as { task_id: string }[]).map((r) => r.task_id);
      expect(policies).toEqual(["api-phase-three-a3", "api-phase-two-a2", "svc-held-b1"]);
      // Tasks with no project of their own keep the work scope, not this home's default.
      for (const task of ["loose-note-c1", "call-vendor-t1", "api-phase-two-a2", "svc-held-b1"]) expect(taskScope(db, config, task)).toBe("work");
      expect(taskScope(db, config, MAIN_TASK)).toBe("personal");
      const events = db.query("SELECT payload FROM events WHERE kind = 'home.adopted'").all() as { payload: string }[];
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        old_home: realpathSync(old.home),
        scope: "work",
        plans: { p1: "p3" },
        dropped_edges: [{ task: "api-phase-two-a2", blocked_by: "api-phase-one-a1", why: "landed" }],
      });
    });

    const marker = JSON.parse(readFileSync(join(old.home, "adopted.json"), "utf8")) as Record<string, unknown>;
    expect(marker).toMatchObject({ adopted_into: main.home, scope: "work", plans: { p1: "p3" }, todos: ["call-vendor-t1"] });
    // The old files are otherwise untouched.
    expect(hashFile(old.backlog)).toBe(oldBacklogHash);

    // A rerun finds the event and only rewrites the marker.
    rmSync(join(old.home, "adopted.json"));
    const again = await adopt(old);
    expect(again.ok).toBe(true);
    expect((again.data as Record<string, unknown>).already_adopted).toBe(true);
    expect(existsSync(join(old.home, "adopted.json"))).toBe(true);
    withDb(main, (db) => {
      expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'home.adopted'").get() as { n: number }).n).toBe(1);
      expect((db.query("SELECT COUNT(*) AS n FROM intents WHERE verb = 'add' AND task_id = 'loose-note-c1'").get() as { n: number }).n).toBe(1);
    });

    // The old daemon refuses to start, with a clean exit so launchd leaves it stopped.
    const proc = Bun.spawn(["bun", MAIN, "daemon", "run"], { cwd: REPO_ROOT, env: { ...old.env, FLOWRYN_LOG_STDERR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("home_adopted");
    expect(stderr).toContain(main.home);
    expect(existsSync(join(old.home, "run", "flowrynd.sock"))).toBe(false);

    const started = Date.now();
    const start = await cliJson(old, ["daemon", "start"]);
    expect(start.code).toBe(0);
    expect(start.reply).toMatchObject({ ok: true, data: { daemon: "not started" } });
    expect(String((start.reply.data as Record<string, unknown>).reason)).toContain("home_adopted");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(join(old.home, "run", "flowrynd.sock"))).toBe(false);
  }, 60_000);

  test("refuses while the old daemon answers on its socket", async () => {
    const old = makeOldHome();
    const oldDaemon = await startDaemon(old);
    try {
      const reply = await adopt(old);
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatchObject({ code: "adopt_refused" });
      expect(reply.error!.message).toContain("daemon answers");
    } finally {
      await oldDaemon.stop();
    }
  }, 30_000);

  test("refuses while a process holds the old home's lock", async () => {
    const old = makeOldHome();
    const lock = tryExclusiveLock(stateFiles(old.stateDir).lock)!;
    try {
      const reply = await adopt(old);
      expect(reply.error).toMatchObject({ code: "adopt_refused" });
      expect(reply.error!.message).toContain("holds the old home's lock");
    } finally {
      lock.release();
    }
  });

  const refusals: [string, OldOptions, string][] = [
    [
      "a run that has not ended",
      { extra: (_old, db) => db.query("UPDATE runs SET state = 'running', ended_at = NULL WHERE id = 'r01OLD1'").run() },
      "runs that have not ended: r01OLD1",
    ],
    [
      "an open decision",
      { extra: (_old, db) => db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state) VALUES ('q4', 'svc-held-b1', 'which?', '[]', 1, 'open')").run() },
      "open decisions: q4",
    ],
    [
      "an open review gate",
      { extra: (_old, db) => db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at) VALUES ('g9', 'r01OLD1', 'design', 'review', 'open', 1)").run() },
      "open gates: g9 (review)",
    ],
    [
      "a backlog write still pending",
      { extra: (_old, db) => db.query("INSERT INTO intents (id, seq, file, verb, args, task_id, state, attempts, created_at) VALUES ('i1', 1, 'backlog', 'done', '{\"positional\":[\"svc-held-b1\"],\"flags\":{}}', 'svc-held-b1', 'pending', 0, 1)").run() },
      "1 backlog write(s) still pending",
    ],
    ["a database at an older schema", { extra: (_old, db) => db.query("UPDATE meta SET value = '30' WHERE key = 'schema_version'").run() }, "older than this build's"],
    ["a task In flight", { extra: (old) => axi(old.backlog, ["start", "loose-note-c1"]) }, "tasks In flight: loose-note-c1"],
    ["a project outside the work scope's rules", { apiPath: join(ELSEWHERE, "api") }, "is in scope personal under this home's config, not work"],
    ["no account to take the scope from", { configDir: null }, "sets no [workers.claude] config_dir"],
    ["an old login that is no declared account", { configDir: join(root, "claude-unknown") }, "no declared Claude account"],
    [
      "a project id registered here at another path",
      { extra: (_old, db) => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('shared', '', ?1, 'main', 'local-only')").run(join(WORK, "shared-old")) },
      "project shared is already registered here",
    ],
    [
      "a task id already in this home",
      { extra: (old) => axi(old.backlog, ["add", MAIN_TASK, "Same id, old home"]) },
      // The phases the first test moved in clash too; the main home's own task is what this case adds.
      MAIN_TASK,
    ],
  ];

  for (const [what, options, message] of refusals) {
    test(`refuses ${what}, and moves nothing`, async () => {
      const before = mainProjects();
      const old = makeOldHome(options);
      const reply = await adopt(old);
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatchObject({ code: "adopt_refused" });
      expect(reply.error!.message).toContain(message);
      expect(mainProjects()).toEqual(before);
      expect(existsSync(join(old.home, "adopted.json"))).toBe(false);
      withDb(main, (db) => expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'home.adopted' AND payload LIKE ?1").get(`%${realpathSync(old.home)}%`) as { n: number }).n).toBe(0));
    }, 30_000);
  }

  test("--scope names the scope when the old home has no account to match", async () => {
    const old = makeHome();
    homes.push(old);
    withDb(old, () => {});
    axi(old.todos, ["add", "scoped-todo-s1", "A work to-do", "--kind", "todo"]);
    const unknown = await adopt(old, "nowhere");
    expect(unknown.error).toMatchObject({ code: "adopt_refused" });
    expect(unknown.error!.message).toContain("no scope nowhere");
    const reply = await adopt(old, "work");
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ scope: "work", todos: ["scoped-todo-s1"] });
    withDb(main, (db) => expect(taskScope(db, loadConfig(main.home).config, "scoped-todo-s1")).toBe("work"));
  });

  test("refuses this home itself and a folder that is no Flowryn home", async () => {
    expect((await adopt(main)).error).toMatchObject({ code: "adopt_refused" });
    const empty = mkdtempSync(join(root, "empty-"));
    const reply = await adopt(empty);
    expect(reply.error).toMatchObject({ code: "adopt_refused" });
    expect(reply.error!.message).toContain("not a Flowryn home");
    expect((await adopt("relative/home")).error).toMatchObject({ code: "bad_args" });
  });

  test("is human only: an agent's CLI call is refused", async () => {
    const old = makeOldHome();
    const result = await cliJson(main, ["home", "adopt", old.home]);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(old.home, "adopted.json"))).toBe(false);
  });
});
