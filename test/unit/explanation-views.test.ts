import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Args, ReadCtx } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { explain, pruneExplanations, type NewExplanation, type Unblock } from "../../src/attention/explanations.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_UPKEEP } from "../../src/config/upkeep.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { DIAG_VERBS } from "../../src/lifecycle/diag.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { SCHED_VERBS } from "../../src/sched/verbs.ts";
import { Upkeep } from "../../src/upkeep/upkeep.ts";

/**
 * Wait explanations in the fleet, the briefing and capacity, their
 * retention, and the diagnostic export's redaction
 * (docs/notes/2026-10-13-next-steps-md-wq.md).
 */

const HOME = "/tmp/fw-explain-views";
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-xviews-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only')").run(dir);
    for (const [task, run, state] of [["t1", "r1", "running"], ["t2", "r2", "running"], ["t3", "r3", "cancelled"]] as const) {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 0, 'fix', 0)").run(task);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES (?1, ?2, 'claude', '1', ?3, 'busy', 'fix', 'build', ?4, 'b', 'abc', 'secret-hash', ?5, ?5)`,
      ).run(run, task, state, dir, NOW - DAY);
    }
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(runId: string, kind: NewExplanation["kind"], reason: string, opened: number, unblock: Unblock[] = [{ by: "captain", action: "flowryn capacity resume --harness claude" }]): number {
  const task = `t${runId.slice(1)}`;
  return tx(db, () => explain(db, { run: { id: runId, task_id: task, stage: "build" }, kind, rule: `${kind}.test`, reason, facts: [{ name: "f", value: reason, at: opened }], unblock, source: "daemon", now: opened }))!;
}

function closeRow(id: number, at: number): void {
  db.query("UPDATE explanations SET closed_at = ?2, closed_by = 'test' WHERE id = ?1").run(id, at);
}

function ctx(config = ""): ReadCtx {
  return { db, config: parseConfig(config, HOME), now: NOW, caller: { role: "human", runId: null, taskId: null } };
}

function read(verbs: { name: string; read?: (c: ReadCtx, a: Args) => { data: Record<string, unknown> } }[], name: string, args: Args = {}, config = ""): Record<string, unknown> {
  return verbs.find((v) => v.name === name)!.read!(ctx(config), args).data;
}

const briefing = () => composeBriefing(db, { session: null, now: NOW, morningHour: 99, ageMs: 3_600_000, markMorning: false }).text;
const count = () => (db.query("SELECT COUNT(*) AS n FROM explanations").get() as { n: number }).n;

describe("fleet and briefing pointer", () => {
  test("no line and no section when nothing waits, nor for a run whose rows are all closed", () => {
    expect(read(LEADER_RUN_VERBS, "fleet").waiting).toBeUndefined();
    expect(briefing()).not.toContain("Waiting (");
    closeRow(open("r1", "capacity", "pools full: gpu 1/1", NOW - 60_000), NOW - 1_000);
    expect(read(LEADER_RUN_VERBS, "fleet").waiting).toBeUndefined();
    expect(briefing()).not.toContain("Waiting (");
  });

  test("each waiting run gets one line: its reason, the next action and who takes it, longest waiting first", () => {
    open("r2", "dialog", "permission dialog in pane w:2", NOW - 60_000, [{ by: "captain", action: "answer the dialog in pane w:2" }]);
    open("r1", "capacity", "pools full: gpu 1/1", NOW - 600_000);
    expect(read(LEADER_RUN_VERBS, "fleet").waiting).toEqual([
      { task: "t1", waiting: "pools full: gpu 1/1", next: "flowryn capacity resume --harness claude (captain)" },
      { task: "t2", waiting: "permission dialog in pane w:2", next: "answer the dialog in pane w:2 (captain)" },
    ]);
    const text = briefing();
    expect(text).toContain("Waiting (2):\n- [t1] waiting: pools full: gpu 1/1 · next: flowryn capacity resume --harness claude (captain)\n- [t2] waiting: permission dialog in pane w:2 · next: answer the dialog in pane w:2 (captain)");
  });

  test("a run with more open rows shows its newest and counts the rest; one naming no unblock shows next -", () => {
    open("r1", "capacity", "pools full: gpu 1/1", NOW - 600_000);
    open("r1", "dialog", "suspected dialog", NOW - 60_000, []);
    expect(read(LEADER_RUN_VERBS, "fleet").waiting).toEqual([{ task: "t1", waiting: "suspected dialog (+1)", next: "-" }]);
    expect(briefing()).toContain("- [t1] waiting: suspected dialog (+1) · next: -");
  });

  test("an ended run's stray open row is not listed (the sweep closes it later)", () => {
    open("r3", "capacity", "pools full: gpu 1/1", NOW - 600_000);
    expect(read(LEADER_RUN_VERBS, "fleet").waiting).toBeUndefined();
    expect(briefing()).not.toContain("Waiting (");
  });

  test("a long reason and action are cut, so the line stays short", () => {
    open("r1", "capacity", "x".repeat(150), NOW - 600_000, [{ by: "flowryn", action: "y".repeat(150) }]);
    const [row] = read(LEADER_RUN_VERBS, "fleet").waiting as { waiting: string; next: string }[];
    expect(row!.waiting.length).toBeLessThanOrEqual(80);
    expect(row!.next.length).toBeLessThanOrEqual(60 + " (flowryn)".length);
  });
});

describe("capacity: unresolved waiting time per kind", () => {
  test("- with nothing open; per kind its count, longest and total with rows open", () => {
    expect(read(SCHED_VERBS, "capacity").unresolved).toBe("-");
    open("r1", "capacity", "pools full", NOW - 10 * 60_000);
    open("r2", "capacity", "pools full too", NOW - 5 * 60_000);
    open("r2", "dialog", "dialog", NOW - 60_000);
    closeRow(open("r1", "dialog", "old dialog", NOW - 3_600_000), NOW - 1_800_000);
    expect(read(SCHED_VERBS, "capacity").unresolved).toBe("capacity 2 (longest 10m, total 15m) · dialog 1 (longest 60s, total 60s)");
  });
});

describe("retention", () => {
  test("by age: an old closed row goes, an old open row and a recent closed row stay, with one event", () => {
    const oldClosed = open("r1", "capacity", "a", NOW - 40 * DAY);
    closeRow(oldClosed, NOW - 31 * DAY);
    const oldOpen = open("r2", "capacity", "b", NOW - 40 * DAY);
    const recent = open("r1", "dialog", "c", NOW - 2 * DAY);
    closeRow(recent, NOW - DAY);
    expect(pruneExplanations(db, { keepDays: 30, keepPerRun: 0 }, NOW)).toEqual({ deleted: 1, byAge: 1, byCount: 0 });
    expect((db.query("SELECT id FROM explanations ORDER BY id").all() as { id: number }[]).map((r) => r.id)).toEqual([oldOpen, recent]);
    const events = db.query("SELECT payload FROM events WHERE kind = 'explanations.pruned'").all() as { payload: string }[];
    expect(events.map((e) => JSON.parse(e.payload))).toEqual([{ deleted: 1, by_age: 1, by_count: 0, keep_days: 30, keep_per_run: 0 }]);
  });

  test("by count per run: the newest N closed rows of each run stay, open rows are never counted out", () => {
    const r1 = Array.from({ length: 5 }, (_, i) => open("r1", "capacity", `r1 #${i}`, NOW - 1000 + i));
    for (const id of r1) closeRow(id, NOW);
    const r1Open = open("r1", "dialog", "still open", NOW);
    const r2 = open("r2", "capacity", "other run", NOW);
    closeRow(r2, NOW);
    expect(pruneExplanations(db, { keepDays: 0, keepPerRun: 2 }, NOW)).toEqual({ deleted: 3, byAge: 0, byCount: 3 });
    expect((db.query("SELECT id FROM explanations ORDER BY id").all() as { id: number }[]).map((r) => r.id)).toEqual([r1[3]!, r1[4]!, r1Open, r2]);
  });

  test("0 turns each bound off, and nothing deleted appends no event", () => {
    closeRow(open("r1", "capacity", "a", NOW - 400 * DAY), NOW - 400 * DAY);
    expect(pruneExplanations(db, { keepDays: 0, keepPerRun: 0 }, NOW)).toEqual({ deleted: 0, byAge: 0, byCount: 0 });
    expect(count()).toBe(1);
    expect(db.query("SELECT 1 FROM events WHERE kind = 'explanations.pruned'").get()).toBeNull();
  });

  test("the upkeep pass prunes with its configured bounds, even while the rest of the pass waits", async () => {
    closeRow(open("r1", "capacity", "a", NOW - 40 * DAY), NOW - 40 * DAY);
    const logs: string[] = [];
    const upkeep = new Upkeep({
      db,
      config: () => ({ ...DEFAULT_UPKEEP, build_after_merge: false, sync_primary: false, clean_ended_hours: 0 }),
      now: () => NOW,
      log: (m) => logs.push(m),
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      projects: () => [],
      builder: { pass: async () => ({ outcome: "skipped", reason: "off" }) as never },
      busy: () => "a restart is asked for or under way",
      sweep: async () => ({ outcome: "kept", reason: "-", task: "-" }),
    });
    const report = await upkeep.pass();
    expect(report.waited).toBe("a restart is asked for or under way");
    expect(report.pruned).toEqual({ deleted: 1, byAge: 1, byCount: 0 });
    expect(count()).toBe(0);
    expect(logs).toEqual(["upkeep: pruned 1 closed wait explanations (1 by age, 0 over the per-run cap)"]);
  });
});

function addEvent(kind: string, payload: unknown): void {
  db.query("INSERT INTO events (ulid, ts, source, run_id, task_id, kind, payload) VALUES (?1, ?2, 'cli', 'r1', 't1', ?3, ?4)").run(`u-${kind}-${Math.random()}`, NOW, kind, JSON.stringify(payload));
}

function cancelReasons(includeText: boolean): string[] {
  return (read(DIAG_VERBS, "diag.export", { target: "t1", "include-text": includeText }).events as { kind: string; payload: { reason: string } }[])
    .filter((e) => e.kind === "run.cancelled")
    .map((e) => e.payload.reason);
}

describe("diagnostic export (diag.export)", () => {
  const QUESTION = "Should the cache key include the tenant id?";
  const ANSWER = "yes-include-tenant";
  const RATIONALE = "tenants must never share cached pages";
  const TOKEN = "ghp_abcdefghijklmnopqrstuvwx";
  const SECRET_CONFIG = '[workers.pi]\nenv = { PI_API_KEY = "very-secret-value" }\nextra_args = ["--api-key", "another-secret"]\n[workers.claude]\nextra_args = ["--note", "ghp_zyxwvutsrqponmlkjihgfedc"]\n';

  function seedDecisionAndEvents(): void {
    tx(db, () => {
      db.query(
        `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, answer, answered_at, rationale, created_at)
         VALUES ('q1', 't1', 'r1', ?1, ?2, 1, 'answered', ?3, ?4, ?5, ?4)`,
      ).run(QUESTION, JSON.stringify([ANSWER, "no-keep-it-shared"]), ANSWER, NOW, RATIONALE);
      db.query("INSERT INTO gates (id, run_id, stage, kind, state, feedback, comment, opened_at) VALUES ('g1', 'r1', 'design', 'review', 'changes', 'please split the page', NULL, ?1)").run(NOW);
      db.query("UPDATE runs SET stage_note = 'worker note with a private plan' WHERE id = 'r1'").run();
    });
    const event = (kind: string, payload: unknown) =>
      db.query("INSERT INTO events (ulid, ts, source, run_id, task_id, kind, payload) VALUES (?1, ?2, 'cli', 'r1', 't1', ?3, ?4)").run(`u-${kind}-${Math.random()}`, NOW, kind, JSON.stringify(payload));
    event("decision.answered", { decision: "q1", choice: ANSWER, by: "captain" });
    event("worker.report", { status: "progress", body: `found the bug; ${TOKEN} was in the log`, summary: "found the bug" });
    event("item.opened", { item: "i1", detail: `Worker question q1: "${QUESTION}"` });
    event("stage.started", { stage: "build", token: TOKEN });
    open("r1", "dialog", "permission dialog", NOW - 60_000);
  }

  const exportOf = (includeText = false) => read(DIAG_VERBS, "diag.export", { target: "t1", "include-text": includeText }, SECRET_CONFIG);

  test("redacted by default: no decision or gate text, no token, no config secret; their presence and size stay", () => {
    seedDecisionAndEvents();
    const data = exportOf();
    const text = JSON.stringify(data);
    for (const secret of [QUESTION, ANSWER, RATIONALE, "please split the page", "private plan", TOKEN, "very-secret-value", "another-secret", "ghp_zyxwvutsrqponmlkjihgfedc", "secret-hash"]) {
      expect(text).not.toContain(secret);
    }
    expect(data).toMatchObject({ format: "flowryn-diag/1", text: "redacted", task: "t1", flowryn: "read-only fallback (daemon down)" });
    const [decision] = data.decisions as Record<string, unknown>[];
    expect(decision).toMatchObject({ id: "q1", state: "answered", question: `<redacted: ${QUESTION.length} chars>`, answer: `<redacted: ${ANSWER.length} chars>`, context: null });
    expect((data.run as Record<string, unknown>).token_hash).toBeUndefined();
    expect((data.explanations as { rule: string; facts: unknown[] }[])[0]).toMatchObject({ rule: "dialog.test", facts: [{ name: "f", value: "permission dialog" }] });
    expect((data.events as { kind: string }[]).map((e) => e.kind)).toEqual(["decision.answered", "worker.report", "item.opened", "stage.started", "run.explained"]);
    expect((data.stages as { workflow: string; current: string }).current).toBe("build");
    expect(((data.config as Record<string, Record<string, unknown>>).workers as Record<string, Record<string, unknown>>).pi).toMatchObject({ env: { PI_API_KEY: "<redacted>" } });
  });

  test("--include-text keeps the decision, gate and event text, but never a token or a config secret", () => {
    seedDecisionAndEvents();
    const text = JSON.stringify(exportOf(true));
    for (const kept of [QUESTION, ANSWER, RATIONALE, "please split the page", "private plan", "found the bug"]) expect(text).toContain(kept);
    for (const secret of [TOKEN, "very-secret-value", "another-secret", "ghp_zyxwvutsrqponmlkjihgfedc", "secret-hash"]) expect(text).not.toContain(secret);
  });

  test("URL credentials never appear, in the config, an event payload or tool and stderr text, with or without --include-text", () => {
    const config = '[github]\napi_url = "https://user:pass@ghe.example.com/api/v3"\n[workers.claude]\nextra_args = ["--mcp", "https://bot@mcp.example.com/?access_token=qwerty12345"]\n';
    tx(db, () => {
      db.query("UPDATE runs SET cleanup_detail = 'git push https://deploy:hunter2@git.example.com/repo.git failed' WHERE id = 'r1'").run();
      db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at, open_detail, channel_reason) VALUES ('g1', 'r1', 'design', 'review', 'open', ?1, 'GET https://x:y-secret@lavish.example.com?sig=abc123 refused', 'fetch https://lavish.example.com/?token=tok-998877 timed out')").run(NOW);
    });
    addEvent("run.failed", { reason: "clone of https://ci:pa55word@git.example.com/x.git exited 128", from: "running" });
    addEvent("gate.channel_failed", { gate: "g1", reason: "POST https://lavish.example.com/pages?api_key=k-5544 refused" });
    addEvent("run.launch_deferred", { mode: "fresh", reason: "pull https://user:pass@registry.example.com failed" });
    for (const includeText of [false, true]) {
      const data = read(DIAG_VERBS, "diag.export", { target: "t1", "include-text": includeText }, config);
      const text = JSON.stringify(data);
      for (const secret of ["user:pass", "bot@", "qwerty12345", "hunter2", "y-secret", "abc123", "tok-998877", "pa55word", "k-5544"]) expect(text).not.toContain(secret);
      expect(((data.config as Record<string, Record<string, unknown>>).github as Record<string, unknown>).api_url).toBe("https://<redacted>@ghe.example.com/api/v3");
      expect((data.run as Record<string, unknown>).cleanup_detail).toBe("git push https://<redacted>@git.example.com/repo.git failed");
      expect(text).toContain("clone of https://<redacted>@git.example.com/x.git exited 128");
      expect(text).toContain("https://lavish.example.com/pages?api_key=<redacted> refused");
    }
  });

  test("a cancel reason someone typed is redacted without --include-text; one Flowryn wrote stays", () => {
    const TYPED = "client asked us to stop the migration work";
    addEvent("run.cancelled", { reason: TYPED, from: "running" });
    addEvent("run.cancelled", { reason: "by leader", from: "running" });
    addEvent("run.cancelled", { reason: "your backlog edit won (divergence d7)", from: "running" });
    expect(cancelReasons(false)).toEqual([`<redacted: ${TYPED.length} chars>`, "by leader", "your backlog edit won (divergence d7)"]);
    expect(cancelReasons(true)).toEqual([TYPED, "by leader", "your backlog edit won (divergence d7)"]);
  });

  test("an unknown target is not_found", () => {
    expect(() => read(DIAG_VERBS, "diag.export", { target: "nope" })).toThrow("no run or task nope");
  });
});
