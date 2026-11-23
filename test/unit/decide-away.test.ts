import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomyVerdict } from "../../src/attention/autonomy-pass.ts";
import { composeReturnBrief } from "../../src/attention/briefing.ts";
import { decisionsConfig } from "../../src/attention/decisions-policy.ts";
import { awayQuestionsLine, QUESTIONS_HEADER, questionsText } from "../../src/attention/router.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { answerDecision, overrideRuleAnswer } from "../../src/lifecycle/decision-verbs.ts";
import { captainAnswerable, getDecision, isRuleAnswer, LEADER_AWAY_VIA, type DecisionRow } from "../../src/lifecycle/decisions.ts";
import { autonomyForDecision, awayProjects, canonicalTerms, endAutonomy, startAutonomy } from "../../src/policy/autonomy.ts";
import { AUTONOMY_SUMMARY } from "../../src/policy/chat-questions.ts";
import { SEES_ALL } from "../../src/leader/scope.ts";

/**
 * The leader answers reserved worker questions while the user is away under unattended mode
 * (docs/notes/2026-11-23-while-the-user-67.md): the one rule (autonomyForDecision), the record
 * answerDecision writes, the undo, the return brief's line and the leader's wake text. The verb
 * itself, with its role refusals, is driven through the real CLI in test/integration/decide-away.test.ts.
 * Tests named "assumption: …" fail when a design assumption is wrong.
 */

let dir = "";
let db: Db;
const NOW = new Date(2026, 10, 23, 2, 0).getTime();
const HOUR = 3_600_000;
const cfg = decisionsConfig(parseConfig('[projects.web]\nverify = ["true"]\n', "/tmp/h"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-decide-away-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    for (const p of ["web", "api"]) db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES (?1, 'x', '/p', 'main', 'direct-PR')").run(p);
    run("r1", "web-a", "web");
    run("r2", "api-a", "api");
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A live run, started after the autonomy migration (as every run of today is). */
function run(id: string, taskId: string, project: string): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, ?2, 'ship', 'direct-PR', 0, 0, 'feature', 0)").run(taskId, project);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '2.1.281', 'running', 'busy', 'feature', 'build', '/tmp/wt', 'fm/x', 'abc123', 'h', ?3, 0)`,
  ).run(id, taskId, Date.now() + 1000);
}

const grant = (projects = ["web"], until = NOW + 8 * HOUR) =>
  tx(db, () => startAutonomy(db, { terms: canonicalTerms(projects, until), channel: "cli-tty", actor: "me (your terminal)", grantId: null, words: null, now: NOW }));

let next = 1;
/** An open, blocking, reserved destructive question of run r1 (task web-a). */
function reserved(over: Partial<DecisionRow> = {}): DecisionRow {
  const id = `q${next++}`;
  const d = {
    id,
    task_id: "web-a",
    run_id: "r1",
    question: "Should I drop the legacy users table before the migration?",
    options: JSON.stringify(["keep", "drop"]),
    blocking: 1,
    state: "open",
    recommendation: "keep",
    reserved_reason: "destructive: drop",
    reserved_class: "destructive",
    created_at: NOW,
    ...over,
  };
  db.query(
    "INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, recommendation, reserved_reason, reserved_class, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
  ).run(d.id, d.task_id, d.run_id, d.question, d.options, d.blocking, d.state, d.recommendation, d.reserved_reason, d.reserved_class, d.created_at);
  return getDecision(db, id)!;
}

const leaderAway = (d: DecisionRow, rationale: string, at = NOW + HOUR) =>
  tx(db, () => answerDecision({ db, now: () => at }, d, { choice: "keep", words: rationale, by: "leader", via: LEADER_AWAY_VIA, autonomy: "u1" }));

describe("the rule: a live grant covering the question's run", () => {
  test("a live grant for the question's project covers it", () => {
    grant(["web"]);
    expect(autonomyForDecision(db, reserved(), NOW + HOUR)?.id).toBe("u1");
  });

  test("no grant, another project's grant, past its end, or after back: none", () => {
    const d = reserved();
    expect(autonomyForDecision(db, d, NOW + HOUR)).toBeNull();
    grant(["api"]);
    expect(autonomyForDecision(db, d, NOW + HOUR)).toBeNull();
    grant(["web"], NOW + 2 * HOUR);
    expect(autonomyForDecision(db, d, NOW + 2 * HOUR)).toBeNull();
    expect(autonomyForDecision(db, d, NOW + HOUR)?.id).toBe("u2");
    tx(db, () => endAutonomy(db, NOW + HOUR));
    expect(autonomyForDecision(db, d, NOW + HOUR + 1)).toBeNull();
  });

  test("assumption: a standalone decision (the leader's own, no run) is never covered", () => {
    grant(["web"]);
    expect(autonomyForDecision(db, { run_id: null }, NOW + HOUR)).toBeNull();
  });

  test("assumption: a run started before the autonomy migration is not covered", () => {
    grant(["web"]);
    db.query("UPDATE runs SET started_at = 0 WHERE id = 'r1'").run();
    expect(autonomyForDecision(db, reserved(), NOW + HOUR)).toBeNull();
  });

  test("assumption: the daemon's autonomy pass still parks a reserved question itself", () => {
    grant(["web"]);
    const d = reserved();
    expect(autonomyVerdict(d, { state: "running", sensitive: 0 }, cfg, { noCi: null }).action).toBe("park");
  });
});

describe("the record", () => {
  test("a leader-away answer is the leader's, with its reason, its grant and a decision.answered event naming both", () => {
    grant(["web"]);
    const d = reserved();
    const done = leaderAway(d, "the table is still read by billing; keep it");
    expect(done.steer).not.toBeNull();
    expect(getDecision(db, d.id)).toMatchObject({ state: "answered", answer: "keep", answered_by: "leader", answered_via: "leader-away", rationale: "the table is still read by billing; keep it", autonomy_id: "u1" });
    const ev = db.query("SELECT payload FROM events WHERE kind = 'decision.answered' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ decision: d.id, by: "leader", via: "leader-away", reserved: "destructive", autonomy: "u1" });
    const steer = db.query("SELECT body FROM messages WHERE id = ?1").get(done.steer) as { body: string };
    expect(steer.body).toContain(`Answer to your question ${d.id}`);
  });

  test("a plain leader answer carries no grant", () => {
    const d = reserved({ reserved_reason: null, reserved_class: null });
    tx(db, () => answerDecision({ db, now: () => NOW }, d, { choice: "keep", words: "fine", by: "leader", via: "leader" }));
    expect(getDecision(db, d.id)).toMatchObject({ answered_via: "leader", autonomy_id: null });
    const ev = db.query("SELECT payload FROM events WHERE kind = 'decision.answered' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(ev.payload)).not.toHaveProperty("autonomy");
  });
});

describe("the user's review and undo", () => {
  test("a leader-away answer is undoable by the user; a plain leader answer is not", () => {
    grant(["web"]);
    const away = reserved();
    leaderAway(away, "keep it");
    expect(isRuleAnswer(getDecision(db, away.id)!)).toBe(true);
    expect(captainAnswerable(getDecision(db, away.id)!)).toBe(true);
    const plain = reserved({ reserved_reason: null, reserved_class: null });
    tx(db, () => answerDecision({ db, now: () => NOW }, plain, { choice: "keep", words: "fine", by: "leader", via: "leader" }));
    expect(isRuleAnswer(getDecision(db, plain.id)!)).toBe(false);
  });

  test("the user's undo steers the worker off the leader's answer and records it as theirs", () => {
    grant(["web"]);
    const d = reserved();
    leaderAway(d, "keep it");
    const undone = tx(db, () => overrideRuleAnswer({ db, now: () => NOW + 2 * HOUR }, getDecision(db, d.id)!, { choice: "drop", words: null, via: "shell" }));
    const body = (db.query("SELECT body FROM messages WHERE id = ?1").get(undone.steer) as { body: string }).body;
    expect(body).toContain("from keep (leader-away) to drop");
    expect(body).toContain("if what you did on the leader's answer is already committed");
    expect(getDecision(db, d.id)).toMatchObject({ answer: "drop", answered_by: "captain" });
  });

  test("the return brief lists it under Decided for you, marked reserved, with its reason and undo", () => {
    grant(["web"]);
    const d = reserved();
    leaderAway(d, "the table is still read by billing; keep it");
    const brief = composeReturnBrief(db, { since: NOW, until: NOW + 2 * HOUR, now: NOW + 2 * HOUR, ageMs: HOUR, reason: "back" });
    expect(brief).toContain(`- [${d.id}] Should I drop the legacy users table before the migration? → keep (reserved: destructive; the leader decided while you were away; undo: flowryn decide ${d.id} <choice> --by captain): the table is still read by billing; keep it`);
  });

  test("once the run is over the line says there is no undo", () => {
    grant(["web"]);
    const d = reserved();
    leaderAway(d, "keep it");
    db.query("UPDATE runs SET state = 'cancelled' WHERE id = 'r1'").run();
    const brief = composeReturnBrief(db, { since: NOW, until: NOW + 2 * HOUR, now: NOW + 2 * HOUR, ageMs: HOUR, reason: "back" });
    expect(brief).toContain("the leader decided while you were away; run over, no undo)");
  });
});

describe("what the leader and the user are told", () => {
  test("the wake text names the covered projects only while a grant is live", () => {
    const items = [{ id: "i1", lane: "P1" as const, line: "Worker question q1" }];
    expect(questionsText(items)).toBe(`${QUESTIONS_HEADER}\n- [i1] Worker question q1`);
    expect(awayQuestionsLine([])).toBeNull();
    expect(awayProjects(db, NOW + HOUR, SEES_ALL)).toEqual([]);
    grant(["web"]);
    const projects = awayProjects(db, NOW + HOUR, SEES_ALL);
    expect(projects).toEqual(["web"]);
    expect(questionsText(items, 0, projects)).toContain("unattended mode for web: decide those projects' reserved questions too, after a second look, with flowryn decide <id> <choice> --rationale -");
    expect(awayProjects(db, NOW + HOUR, { project: (p) => p !== "web" })).toEqual([]);
  });

  test("the autonomy consent sentence says the leader may decide what the daemon parks", () => {
    expect(AUTONOMY_SUMMARY).toContain("parks only its task for you, unless your leader decides it after a second look, recording why");
  });
});
