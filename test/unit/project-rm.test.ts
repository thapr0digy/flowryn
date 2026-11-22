import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { serverVerb } from "../../src/api/registry.ts";
import { parseConfig } from "../../src/config/config.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { recordIntent } from "../../src/journal/journal.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { openWorkOf } from "../../src/lifecycle/project-rm.ts";
import { getProject, listProjects, requireActiveProject } from "../../src/lifecycle/projects.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";
import { Upkeep } from "../../src/upkeep/upkeep.ts";
import { DEFAULT_UPKEEP } from "../../src/config/upkeep.ts";

/**
 * `flowryn project rm` (docs/notes/2026-11-22-flowryn-project-rm-74.md): it refuses,
 * naming the work, while the project has any open work; otherwise it marks the
 * project removed with an event, and upkeep, the scheduler and project list skip it.
 */

const HOME = "/tmp/fw-project-rm";
const NOW = 5_000_000;
let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-project-rm-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    for (const p of ["web", "api"]) {
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, autonomy) VALUES (?1, '', ?2, 'main', 'local-only', 'plan')").run(p, join(dir, p));
    }
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rmVerb = serverVerb("project rm")!;
const ctx = () => ({ db, now: () => NOW, caller: { role: "human" }, config: () => parseConfig("", HOME) }) as never;

function rm(id: string, reason?: string): Record<string, unknown> {
  return tx(db, () => rmVerb.apply!(ctx(), { id, ...(reason === undefined ? {} : { reason }) }, null)).data;
}

function refusal(id: string): FlowrynError {
  try {
    rm(id);
  } catch (error) {
    return error as FlowrynError;
  }
  throw new Error(`project rm ${id} was not refused`);
}

function backlog(tasks: Partial<BacklogTask>[]): void {
  const full = tasks.map((t) => ({ id: "x", title: "t", state: "queued", kind: "ship", repo: null, priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [], ...t }) as BacklogTask);
  tx(db, () => writeSnapshot(db, "backlog", "h", full, NOW));
}

function policy(task: string, project = "web", auto = 0): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, auto, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', ?3, 0)").run(task, project, auto);
}

function run(id: string, task: string, state: string, ended: number | null): void {
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, ended_at)
     VALUES (?1, ?2, 'claude', '1', ?3, 'dead', 'fix', 'build', ?4, 'b', 's', ?1, 0, 0, ?5)`,
  ).run(id, task, state, join(dir, "wt", id), ended);
}

describe("project rm refuses while the project has open work, naming it", () => {
  test("a live run", () => {
    tx(db, () => {
      policy("t-live");
      run("r1", "t-live", "running", null);
    });
    const error = refusal("web");
    expect(error.code).toBe("project_busy");
    expect(error.message).toBe("project web still has open work: 1 live runs (t-live)");
    expect(getProject(db, "web")!.removed_at).toBeNull();
  });

  test("a queued or held task in the backlog, or one whose add is still pending", () => {
    backlog([{ id: "t-q", repo: "web" }, { id: "t-h", repo: "web", hold: { kind: "captain", reason: "wait", until: null } }, { id: "t-done", repo: "web", state: "done" }, { id: "t-other", repo: "api" }]);
    expect(refusal("web").message).toContain("2 queued or held tasks (t-q, t-h)");
    backlog([]);
    tx(db, () => recordIntent(db, { file: "backlog", verb: "add", taskId: "t-new", positional: ["t-new", "New"], flags: { repo: "web" }, now: NOW }));
    expect(refusal("web").message).toContain("1 queued or held tasks (t-new)");
    expect(openWorkOf(db, "api")).toEqual([]);
  });

  test("an open plan phase: a pending plan's, or an approved one not landed, done or dropped", () => {
    tx(db, () => {
      db.query("INSERT INTO plans (id, project_id, title, state, filed_by, created_at) VALUES ('pl1', 'web', 'P', 'approved', 'leader', 0), ('pl2', 'web', 'Q', 'discarded', 'leader', 0)").run();
      db.query(
        `INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES
           ('pl1', 1, 't-landed', 'A', 'b', 'fix', '[]'), ('pl1', 2, 't-done', 'B', 'b', 'fix', '[]'), ('pl1', 3, 't-open', 'C', 'b', 'fix', '[]'), ('pl2', 1, 't-gone', 'D', 'b', 'fix', '[]')`,
      ).run();
      policy("t-landed");
      run("r1", "t-landed", "landed", 1);
    });
    backlog([{ id: "t-done", repo: "web", state: "done" }]);
    expect(openWorkOf(db, "web")).toEqual(["1 open plan phases (t-open)"]);
  });

  test("an open decision: a run's, by its task's project, or a standalone one, by its backlog repo", () => {
    tx(db, () => {
      policy("t-run");
      db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state) VALUES ('q1', 't-run', '?', '[]', 1, 'open'), ('q2', 't-run', '?', '[]', 1, 'answered'), ('k1', 't-k1', '?', '[]', 1, 'open')").run();
    });
    backlog([{ id: "t-k1", repo: "web", kind: "decision", state: "done" }]);
    expect(openWorkOf(db, "web")).toEqual(["2 open decisions (k1, q1)"]);
  });

  test("a live landing batch, a landing queue entry, an open delivery watch, a verify or an ask", () => {
    tx(db, () => {
      db.query("INSERT INTO landing_batches (id, project_id, state, base_sha, head_sha, created_at, state_since, updated_at) VALUES ('b1', 'web', 'verifying', 's', 'h', 0, 0, 0), ('b2', 'web', 'landed', 's', 'h', 0, 0, 0)").run();
      db.query("INSERT INTO landing_queue (id, project_id, run_id, task_id, ref, entered_head, head_sha, state, enqueued_at, state_since, updated_at) VALUES ('l1', 'web', 'r9', 't-lq', 'b', 'h', 'h', 'waiting', 0, 0, 0)").run();
      db.query("INSERT INTO watches (id, task_id, waiter_task, project_id, kind, target, created_at) VALUES ('w1', 't-w', 't-waiter', 'web', 'pr', 'https://x/pull/1', 0)").run();
      db.query("INSERT INTO verify_queue (id, project_id, pr_url, head_sha, policy_id, source, state, requested_at) VALUES ('v1', 'web', 'u', 'h', 'p', 'cli', 'queued', 0)").run();
      db.query("INSERT INTO asks (id, project_id, title, question, harness, account, max_usd, created_by, created_at) VALUES ('a1', 'web', 'T', '?', 'claude', 'c', 1, 'leader', 0)").run();
    });
    expect(openWorkOf(db, "web")).toEqual([
      "1 landing batches (b1)",
      "1 landing queue entries (t-lq)",
      "1 delivery watches (t-w)",
      "1 verifies (v1)",
      "1 asks (a1)",
    ]);
  });
});

describe("project rm with no open work", () => {
  test("marks the project removed with an event, keeps its row and history, and refuses a second rm", () => {
    tx(db, () => {
      policy("t-old");
      run("r-old", "t-old", "landed", 1);
    });
    const data = rm("web", "repo retired");
    expect(data).toMatchObject({ project: "web", path: join(dir, "web"), reason: "repo retired" });
    expect(getProject(db, "web")).toMatchObject({ removed_at: NOW, removed_reason: "repo retired" });
    const event = db.query("SELECT payload FROM events WHERE kind = 'project.removed'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({ id: "web", path: join(dir, "web"), reason: "repo retired", by: "human" });
    expect(db.query("SELECT COUNT(*) AS n FROM runs WHERE task_id = 't-old'").get()).toEqual({ n: 1 });
    expect(refusal("web")).toMatchObject({ code: "not_found", message: "project web was removed" });
  });

  test("project list skips it unless --all; new work and project set refuse it", () => {
    rm("web");
    expect(listProjects(db).map((p) => p.id)).toEqual(["api"]);
    expect(listProjects(db, { removed: true }).map((p) => p.id)).toEqual(["api", "web"]);
    const list = serverVerb("project list")!;
    const read = (all: boolean) => (list.read!({ db, config: parseConfig("", HOME), now: NOW, caller: { role: "human" } } as never, all ? { all: true } : {}).data.projects as { id: string; removed?: string }[]);
    expect(read(false).map((p) => p.id)).toEqual(["api"]);
    expect(read(true)).toEqual([expect.objectContaining({ id: "api", removed: "-" }), expect.objectContaining({ id: "web", removed: new Date(NOW).toISOString() })]);
    expect(() => requireActiveProject(db, "web")).toThrow("project web was removed");
    expect(() => tx(db, () => serverVerb("project set")!.apply!(ctx(), { id: "web", priority: 1 }, null))).toThrow("project web was removed");
  });
});

describe("a removed project is skipped", () => {
  test("by upkeep's primary-checkout sync", async () => {
    const fetched: string[] = [];
    const upkeep = new Upkeep({
      db,
      config: () => ({ ...DEFAULT_UPKEEP, build_after_merge: false }),
      now: () => NOW,
      log: () => {},
      git: async (args, cwd) => {
        if (args[0] === "fetch") fetched.push(cwd);
        return { code: args[0] === "fetch" ? 1 : 0, stdout: "", stderr: "Permission denied (publickey)" };
      },
      projects: () => listProjects(db),
      builder: { pass: async () => ({ outcome: "skipped", reason: "off" }) },
      busy: () => null,
      sweep: async () => ({ outcome: "kept", reason: "-", task: "-" }),
    });
    for (const p of ["web", "api"]) mkdirSync(join(dir, p));
    await upkeep.pass();
    expect(fetched.toSorted()).toEqual([join(dir, "api"), join(dir, "web")]);
    rm("web");
    fetched.length = 0;
    await upkeep.pass();
    expect(fetched).toEqual([join(dir, "api")]);
  });

  test("by the scheduler's phase autostart", async () => {
    const reached: string[] = [];
    tx(db, () => {
      db.query("INSERT INTO harness_contracts (harness, version, revision, passed_at) VALUES ('claude', '1', ?1, 0)").run(contractRevision("claude"));
      db.query("INSERT INTO plans (id, project_id, title, state, filed_by, created_at) VALUES ('pl1', 'web', 'P', 'approved', 'leader', 0)").run();
      db.query("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES ('pl1', 1, 't-a', 'A', 'b', 'fix', '[]')").run();
      policy("t-a", "web", 1);
    });
    backlog([{ id: "t-a", repo: "web" }]);
    const config = parseConfig(`[tools]\nclaude = "/bin/true"\n`, HOME);
    const pass = async () => {
      const s = new Scheduler({
        db,
        config: () => config,
        now: () => NOW,
        log: () => {},
        launch: () => {},
        isLaunching: () => false,
        exitWorker: async () => ({ ok: true }),
        notify: () => {},
        // checkStart asks for the runtime first: a call here is a start attempted.
        startDeps: { db, config: () => config, runtime: () => (reached.push("t-a"), null), harnessVersion: async () => "1", git: async () => null, signIn: async () => null, now: () => NOW },
        kickJournal: () => {},
        host: async () => ({ ok: true, reason: "test" }) as HostVerdict,
        quota: async () => ({ state: "known", percent: 10, window: "five_hour", resets_at: null }),
      });
      await s.passNow();
      await s.stop();
    };
    await pass();
    expect(reached).toEqual(["t-a"]);
    // rm would refuse this open phase; mark it removed directly to prove the scheduler's own guard.
    tx(db, () => db.query("UPDATE projects SET removed_at = ?1 WHERE id = 'web'").run(NOW));
    reached.length = 0;
    await pass();
    expect(reached).toEqual([]);
  });
});
