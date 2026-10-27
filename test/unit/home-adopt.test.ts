import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { intentArgs, pendingIntents } from "../../src/journal/journal.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { adoptedLine, adoptHome, readAdoptedMarker, type OldHome } from "../../src/lifecycle/home-adopt.ts";
import { hasLanded, phaseOfTask, type PhaseRow, type PlanRow } from "../../src/lifecycle/plans.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import { renderPlist } from "../../src/service/launchd.ts";
import { realTasksAxi } from "../helpers/harness.ts";

/** `flowryn home adopt` (docs/notes/2026-10-24-leader-scoping-and-vj.md, phase 2): the design's assumptions. */

const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-adopt-unit-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const WORK = join(root, "work");
const CLAUDE_WORK = join(root, "claude-work");
for (const dir of [join(WORK, "api"), CLAUDE_WORK]) mkdirSync(dir, { recursive: true });

const MAIN_CONFIG = `
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
`;

function task(id: string, state: BacklogTask["state"], deps: string[] = []): BacklogTask {
  return { id, title: id, state, kind: "ship", repo: "api", priority: null, body: "", created: null, closed: null, deps: deps.map((d) => `blocked-by:${d}`), hold: null, links: [] };
}

const project: ProjectRow = { id: "api", repo_url: "", path: join(WORK, "api"), default_branch: "main", delivery_mode: "local-only", yolo: 0, priority: 2, harness: "claude", workflow: "fix", autonomy: "plan" };

function oldHome(backlog: BacklogTask[], phases: PhaseRow[] = []): OldHome {
  const plans: PlanRow[] = phases.length > 0 ? [{ id: "p1", project_id: "api", title: "plan", state: "approved", source_task: null, gate_id: null, filed_by: "worker", created_at: 1, approved_at: 1, approved_via: "tty" }] : [];
  const policies = backlog.map((t) => ({ task_id: t.id, project_id: "api", kind: "ship", delivery_mode: "local-only", yolo: 0, sensitive: 0, workflow: "fix", auto: 1, reason: null, created_at: 1, import_source: null, mode_reason: null }));
  return {
    home: join(root, "old"),
    config: parseConfig(`[workers.claude]\nconfig_dir = ${JSON.stringify(CLAUDE_WORK)}\n`, join(root, "old")),
    projects: [project],
    policies,
    plans,
    phases,
    backlog,
    todos: [],
  };
}

function mainDb(): { db: Db; config: FlowrynConfig } {
  const db = openDb(":memory:");
  migrate(db);
  return { db, config: parseConfig(MAIN_CONFIG, join(root, "main")) };
}

describe("home adopt assumptions", () => {
  test("assumption: tasks-axi add --blocked-by refuses a blocker that is not in the file yet, so blockers are added first", () => {
    const file = join(root, "order.md");
    const added = Bun.spawnSync([realTasksAxi(), "add", "later-x2", "Later", "--blocked-by", "first-x1", "--file", file, "--json"], { stdin: "ignore", env: process.env });
    expect(added.exitCode).not.toBe(0);

    const { db, config } = mainDb();
    // The dependent comes first in the old backlog's order.
    const old = oldHome([task("later-x2", "queued", ["first-x1"]), task("first-x1", "queued")]);
    tx(db, () => adoptHome(db, config, old, undefined, 1));
    expect(pendingIntents(db, "backlog").map((i) => [i.task_id, intentArgs(i).flags["blocked-by"] ?? null])).toEqual([
      ["first-x1", null],
      ["later-x2", ["first-x1"]],
    ]);
  });

  test("assumption: a blocker that landed in the old home never lands here, so an edge kept to it would hold its task forever", () => {
    const { db, config } = mainDb();
    // The main home has never heard of the landed task: it would count as not landed.
    expect(hasLanded(db, "done-x0", [])).toBe(false);
    const phases: PhaseRow[] = [
      { plan_id: "p1", phase_no: 1, task_id: "done-x0", title: "one", body: "one", workflow: "fix", harness: null, account: null, model: null, effort: null, blocked_by: "[]" },
      { plan_id: "p1", phase_no: 2, task_id: "next-x1", title: "two", body: "two", workflow: "fix", harness: null, account: null, model: null, effort: null, blocked_by: '["done-x0"]' },
    ];
    const old = oldHome([task("done-x0", "done"), task("next-x1", "queued", ["done-x0"])], phases);
    const payload = tx(db, () => adoptHome(db, config, old, undefined, 1));
    expect(payload.dropped_edges).toEqual([{ task: "next-x1", blocked_by: "done-x0", why: "landed" }]);
    expect(db.query("SELECT task_id, blocked_by FROM plan_phases").all()).toEqual([{ task_id: "next-x1", blocked_by: "[]" }]);
    expect(phaseOfTask(db, "next-x1")).toMatchObject({ phase_no: 2, phases: 2 });
    expect(intentArgs(pendingIntents(db, "backlog")[0]!).flags["blocked-by"]).toBeUndefined();
  });

  test("assumption: the scope is the account's on the old home's [workers.claude] config_dir, matched by real path", () => {
    const { db, config } = mainDb();
    const old = oldHome([task("one-x1", "queued")]);
    old.config = parseConfig(`[workers.claude]\nconfig_dir = ${JSON.stringify(join(CLAUDE_WORK, "..", "claude-work"))}\n`, old.home);
    expect(tx(db, () => adoptHome(db, config, old, undefined, 1)).scope).toBe("work");
  });

  test("assumption: launchd leaves the adopted daemon's clean exit stopped (KeepAlive on SuccessfulExit false)", () => {
    const plist = renderPlist({ label: "dev.flowryn.flowrynd.test", program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" });
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  test("a to-do's hold moves with it and its blocked-by edges are listed as dropped", () => {
    const { db, config } = mainDb();
    const old = oldHome([]);
    old.todos = [{ ...task("held-t1", "queued", ["other-t2"]), kind: "todo", repo: null, hold: { kind: "external", reason: "waits", until: null } }];
    const payload = tx(db, () => adoptHome(db, config, old, undefined, 1));
    expect(payload.dropped_edges).toEqual([{ task: "held-t1", blocked_by: "other-t2", why: "to-do" }]);
    expect(pendingIntents(db, "todos").map((i) => [i.verb, i.task_id, intentArgs(i).flags["blocked-by"] ?? null])).toEqual([
      ["add", "held-t1", null],
      ["hold", "held-t1", null],
    ]);
    expect(intentArgs(pendingIntents(db, "todos")[1]!).flags).toEqual({ reason: "waits", kind: "external" });
  });

  test("an adopted plan phase keeps every column, its model and effort among them, under its new plan id", () => {
    const { db, config } = mainDb();
    const phase: PhaseRow = { plan_id: "p1", phase_no: 1, task_id: "pinned-x1", title: "one", body: "one", workflow: "fix", harness: "claude", account: "claude-work", model: "sonnet", effort: "high", blocked_by: "[]" };
    const payload = tx(db, () => adoptHome(db, config, oldHome([task("pinned-x1", "queued")], [phase]), undefined, 1));
    // SELECT * returns any column a later migration adds, so this fails until the copy carries it too.
    expect(db.query("SELECT * FROM plan_phases").all()).toEqual([{ ...phase, plan_id: payload.plans.p1! }]);
  });

  test("an adopted task's policy row keeps every column", () => {
    const { db, config } = mainDb();
    const old = oldHome([task("policy-x1", "queued")]);
    old.policies = [{ ...old.policies[0]!, sensitive: 1, auto: 0, reason: "why", import_source: "legacy:7", mode_reason: "mode" }];
    tx(db, () => adoptHome(db, config, old, undefined, 1));
    expect(db.query("SELECT * FROM task_policy").all()).toEqual(old.policies);
  });

  test("a marker that cannot be read still marks the home adopted", () => {
    const home = join(root, "torn");
    mkdirSync(home, { recursive: true });
    expect(readAdoptedMarker(home)).toBeNull();
    writeFileSync(join(home, "adopted.json"), "{not json");
    const marker = readAdoptedMarker(home);
    expect(marker).not.toBeNull();
    expect(adoptedLine(home, marker!)).toStartWith("home_adopted:");
  });
});
