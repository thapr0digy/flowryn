import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { autonomyGateVerdict, autonomyVerdict, PARKING_CLASSES, startedUnderAutonomy } from "../../src/attention/autonomy-pass.ts";
import { autonomyLines } from "../../src/attention/autonomy-report.ts";
import { decisionsConfig, RESERVED_CLASSES } from "../../src/attention/decisions-policy.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { SEES_ALL } from "../../src/leader/scope.ts";
import { CI_WAIT_ORIGIN, CI_WAIT_OPTIONS, CI_WAIT_RESERVED } from "../../src/lifecycle/ci-wait.ts";
import type { DecisionRow } from "../../src/lifecycle/decisions.ts";
import { GATE_QUESTION_RESERVED } from "../../src/lifecycle/gate-questions.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import type { RunWithPolicy } from "../../src/lifecycle/runs.ts";
import type { GateRow } from "../../src/lifecycle/stages.ts";
import { insertApproval } from "../../src/policy/approvals.ts";
import {
  AUTONOMY_MAX_MS,
  autonomyFor,
  autonomyRef,
  canonicalTerms,
  checkTerms,
  endAutonomy,
  expireAutonomy,
  liveAutonomy,
  mintAutonomyApproval,
  parseAutonomyRef,
  startAutonomy,
} from "../../src/policy/autonomy.ts";
import { bindingRef, chatForm, mapAnswer, parseRef } from "../../src/policy/chat-questions.ts";
import { checkGate, chooseApproval, takeApproval, type MergeFacts } from "../../src/policy/merge.ts";
import { summarize } from "../../src/forge/types.ts";
import { sha256Hex } from "../../src/util/hash.ts";

/**
 * Unattended mode (docs/notes/2026-11-05-unattended-mode-one-9e.md): the standing approval's
 * record and terms, the question and gate rules each alone, the merge choice, and the morning
 * report. Tests named "assumption: …" fail when a design assumption is wrong.
 */

let dir = "";
let db: Db;
const NOW = new Date(2026, 10, 5, 22, 0).getTime();
const HOUR = 3_600_000;
const CONFIG = parseConfig('[projects.web]\nverify = ["true"]\n\n[projects.api]\nverify = ["true"]\n', "/tmp/h");
const cfg = decisionsConfig(CONFIG);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-autonomy-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    for (const p of ["web", "api", "bare"]) db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES (?1, 'x', '/p', 'main', 'direct-PR')").run(p);
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES ('t', 'web', 'ship', 'direct-PR', 0, 1, 'feature', 0)").run();
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const grant = (projects = ["web"], until = NOW + 8 * HOUR, now = NOW) =>
  tx(db, () => startAutonomy(db, { terms: canonicalTerms(projects, until), channel: "cli-tty", actor: "me (your terminal)", grantId: null, words: "ship the queue\u0007 overnight", now }));

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return error.code;
    throw error;
  }
  return "ok";
}

describe("the standing approval's record", () => {
  test("terms: projects sorted and unique, the end cut to its minute, and a ref that reads back", () => {
    const terms = canonicalTerms(["web", "api", "web"], NOW + 8 * HOUR + 42_123);
    expect(terms.projects).toEqual(["api", "web"]);
    expect(terms.until % 60_000).toBe(0);
    expect(parseAutonomyRef(autonomyRef(terms))).toEqual(terms);
    expect(parseAutonomyRef("autonomy:web@2026-13-01T08:00")).toBeNull();
    expect(parseAutonomyRef("autonomy:Web@2026-11-06T08:00")).toBeNull();
    expect(parseAutonomyRef("autonomy:web,api@2026-11-06T08:00")).toBeNull();
  });

  test("checkTerms: ahead, at most 16 hours, each project registered with verify steps", () => {
    expect(refusal(() => checkTerms(db, CONFIG, canonicalTerms(["web"], NOW + HOUR), NOW))).toBe("ok");
    expect(refusal(() => checkTerms(db, CONFIG, canonicalTerms(["web"], NOW - HOUR), NOW))).toBe("bad_args");
    expect(refusal(() => checkTerms(db, CONFIG, canonicalTerms(["web"], NOW + AUTONOMY_MAX_MS + 60_000), NOW))).toBe("bad_args");
    expect(refusal(() => checkTerms(db, CONFIG, canonicalTerms(["bare"], NOW + HOUR), NOW))).toBe("bad_args");
    expect(refusal(() => checkTerms(db, CONFIG, canonicalTerms(["nope"], NOW + HOUR), NOW))).toBe("bad_args");
    expect(refusal(() => checkTerms(db, CONFIG, canonicalTerms([], NOW + HOUR), NOW))).toBe("bad_args");
  });

  test("one row, its words sanitised and kept out of the event", () => {
    const row = grant();
    expect(row.id).toBe("u1");
    expect(row.words).toBe("ship the queue overnight");
    const event = db.query("SELECT payload FROM events WHERE kind = 'autonomy.started'").get() as { payload: string };
    expect(event.payload).not.toContain("ship the queue");
  });

  test("assumption: autonomy for project A never covers project B", () => {
    grant(["web"]);
    expect(autonomyFor(db, "web", NOW + HOUR)?.id).toBe("u1");
    expect(autonomyFor(db, "api", NOW + HOUR)).toBeNull();
  });

  test("assumption: an expired or ended grant covers nothing, and what it minted ends with it", () => {
    grant(["web"], NOW + 2 * HOUR);
    expect(autonomyFor(db, "web", NOW + 3 * HOUR)).toBeNull();
    expect(tx(db, () => expireAutonomy(db, NOW + 3 * HOUR))?.end_reason).toBe("expired");
    const second = grant(["web"], NOW + 8 * HOUR, NOW + 3 * HOUR);
    const minted = tx(db, () => mintAutonomyApproval(db, second, { task: "t", ref: "https://github.com/acme/web/pull/1", head: "h1", action: "merge" }, NOW + 3 * HOUR));
    expect(minted.channel).toBe("autonomous");
    expect(minted.actor).toContain("standing approval u2");
    expect(minted.expires_at).toBeLessThanOrEqual(second.expires_at);
    expect(tx(db, () => endAutonomy(db, NOW + 4 * HOUR))?.end_reason).toBe("back");
    expect(liveAutonomy(db, NOW + 4 * HOUR)).toBeNull();
    const after = db.query("SELECT expires_at FROM approvals WHERE id = ?1").get(minted.id) as { expires_at: number };
    expect(after.expires_at).toBe(NOW + 4 * HOUR);
  });

  test("a new grant supersedes the live one: at most one is live", () => {
    grant(["web"]);
    const next = grant(["web", "api"], NOW + 9 * HOUR, NOW + HOUR);
    expect(liveAutonomy(db, NOW + HOUR)?.id).toBe(next.id);
    expect((db.query("SELECT end_reason FROM autonomy_grants WHERE id = 'u1'").get() as { end_reason: string }).end_reason).toBe("superseded");
    expect(() => db.query("INSERT INTO autonomy_grants (id, channel, actor, projects, terms_hash, started_at, expires_at) VALUES ('ux', 'cli-tty', 'x', '[]', 'h', 0, 1)").run()).toThrow();
  });
});

describe("the chat question binds exactly the terms", () => {
  test("its prefix names the ref, Start grants and No declines, free text grants nothing", () => {
    const ref = autonomyRef(canonicalTerms(["web"], NOW + 8 * HOUR));
    expect(parseRef(ref)).toBe(ref);
    expect(refusal(() => parseRef("autonomy:web"))).toBe("bad_args");
    const form = chatForm(db, ref);
    expect(form.action).toBe("autonomy");
    expect(bindingRef(form.question.question)).toBe(ref);
    expect(form.question.question).toContain("parks only its task");
    expect(mapAnswer(form, "Start autonomy", null)).toEqual({ kind: "grant", choice: "start", words: null });
    expect(mapAnswer(form, "No", null).kind).toBe("declined");
    expect(mapAnswer(form, "sure, go", null).kind).toBe("none");
  });

  test("assumption: other terms are another item, so a grant for one never starts the other", () => {
    const a = autonomyRef(canonicalTerms(["web"], NOW + 8 * HOUR));
    const b = autonomyRef(canonicalTerms(["web", "api"], NOW + 8 * HOUR));
    const c = autonomyRef(canonicalTerms(["web"], NOW + 9 * HOUR));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

let nextQ = 1;
function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: `q${nextQ++}`,
    task_id: "t",
    run_id: "r1",
    question: "Which cache layout should the index use?",
    options: JSON.stringify(["flat", "nested"]),
    blocking: 0,
    state: "open",
    answer: null,
    answered_via: null,
    answered_at: null,
    origin: null,
    key: null,
    context: null,
    recommendation: "flat",
    reserved_reason: null,
    reserved_class: null,
    defer_until: null,
    answered_by: null,
    rationale: null,
    created_at: NOW,
    kind: null,
    gate_id: null,
    note: "fewer files to scan",
    blocks: "the index writer",
    autonomy_id: null,
    autonomy_state: null,
    ...over,
  };
}

const live = { state: "running" as const, sensitive: 0 };
const ci = (rec: string) => decision({ origin: CI_WAIT_ORIGIN, options: JSON.stringify(CI_WAIT_OPTIONS), recommendation: rec, reserved_reason: CI_WAIT_RESERVED, reserved_class: "ci-wait", question: "Ship x: its pipeline waited 130 min in CI." });
const nm = (rec: string) => decision({ options: JSON.stringify(["fix", "approve", "skip"]), recommendation: rec, reserved_reason: "nomistakes: no rule matched", reserved_class: "nomistakes-floor", question: "The ci step: CI never started on the PR." });

describe("which questions autonomy decides, parks or leaves", () => {
  test("an ordinary question with a recommendation is decided as recommended", () => {
    expect(autonomyVerdict(decision(), live, cfg, { noCi: null })).toEqual({ action: "decide", choice: "flat" });
  });

  test("assumption: every protected class parks, by its recorded class or by its wording", () => {
    expect(PARKING_CLASSES).toEqual(RESERVED_CLASSES.filter((c) => c !== "merge"));
    for (const klass of PARKING_CLASSES) expect(autonomyVerdict(decision({ reserved_class: klass, reserved_reason: klass }), live, cfg, { noCi: null }).action).toBe("park");
    for (const text of ["Should I drop the users table?", "Can I force-push the branch?", "Rotate the API key now?", "Disable TLS verification for the test host?", "Publish the release notes to the blog?"]) {
      expect({ text, action: autonomyVerdict(decision({ question: text }), live, cfg, { noCi: null }).action }).toEqual({ text, action: "park" });
    }
  });

  test("assumption: the wording is checked with every protected class on, whatever reserved_classes narrows", () => {
    const narrow = decisionsConfig(parseConfig('[decisions]\nreserved_classes = ["merge"]\n', "/tmp/h"));
    expect(autonomyVerdict(decision({ question: "Delete the old rows?" }), live, narrow, { noCi: null }).action).toBe("park");
  });

  test("a merge-class question is decided: the grant is the record it waits for", () => {
    expect(autonomyVerdict(decision({ reserved_reason: "merge", reserved_class: "merge" }), live, cfg, { noCi: null }).action).toBe("decide");
  });

  test("assumption: the worker's own --reserved reason parks; a review gate's question does not", () => {
    expect(autonomyVerdict(decision({ reserved_reason: "the user owns pricing" }), live, cfg, { noCi: null }).action).toBe("park");
    expect(autonomyVerdict(decision({ reserved_reason: GATE_QUESTION_RESERVED, gate_id: "g1" }), live, cfg, { noCi: null }).action).toBe("decide");
  });

  test("a sensitive task's question parks; one with no recommendation is the leader's", () => {
    expect(autonomyVerdict(decision(), { ...live, sensitive: 1 }, cfg, { noCi: null }).action).toBe("park");
    expect(autonomyVerdict(decision({ recommendation: null }), live, cfg, { noCi: null }).action).toBe("skip");
    expect(autonomyVerdict(decision({ recommendation: "other" }), live, cfg, { noCi: null }).action).toBe("skip");
  });

  test("multi and text questions take their recommendation as written", () => {
    expect(autonomyVerdict(decision({ kind: "multi", options: JSON.stringify(["a", "b", "c"]), recommendation: "a, c" }), live, cfg, { noCi: null })).toEqual({ action: "decide", choice: "a, c" });
    expect(autonomyVerdict(decision({ kind: "text", options: "[]", recommendation: "use v2" }), live, cfg, { noCi: null })).toEqual({ action: "decide", choice: "use v2" });
  });

  test("assumption: a CI wait is accepted without CI only when the default branch says no_ci", () => {
    expect(autonomyVerdict(ci("accept-without-ci"), live, cfg, { noCi: false }).action).toBe("park");
    expect(autonomyVerdict(ci("accept-without-ci"), live, cfg, { noCi: true }).action).toBe("decide");
    expect(autonomyVerdict(ci("merge-main"), live, cfg, { noCi: false }).action).toBe("decide");
    expect(autonomyVerdict(nm("approve"), live, cfg, { noCi: null }).action).toBe("park");
    expect(autonomyVerdict(nm("approve"), live, cfg, { noCi: true }).action).toBe("decide");
    expect(autonomyVerdict(nm("fix"), live, cfg, { noCi: null }).action).toBe("decide");
  });

  test("answered, already handled, standalone and finished-run questions are left alone", () => {
    expect(autonomyVerdict(decision({ state: "answered" }), live, cfg, { noCi: null }).action).toBe("skip");
    expect(autonomyVerdict(decision({ autonomy_state: "parked" }), live, cfg, { noCi: null }).action).toBe("skip");
    expect(autonomyVerdict(decision({ run_id: null }), live, cfg, { noCi: null }).action).toBe("skip");
    expect(autonomyVerdict(decision(), { state: "failed", sensitive: 0 }, cfg, { noCi: null }).action).toBe("skip");
  });
});

function pinned(): GateRow {
  const page = join(dir, "design.html");
  const spec = join(dir, "spec.md");
  writeFileSync(page, "<html>page</html>");
  writeFileSync(spec, "# spec");
  return { id: "g1", run_id: "r1", stage: "design", kind: "review", review_url: "http://127.0.0.1:1/session/x", page_path: page, state: "open", spec_path: spec, spec_digest: sha256Hex("# spec"), page_digest: sha256Hex("<html>page</html>") } as GateRow;
}
describe("which review gates autonomy passes", () => {
  const run = { id: "r1", task_id: "t" } as unknown as RunWithPolicy;

  const good = { briefOk: true, current: true, designStage: true };

  test("a design review with its pins unchanged and a full brief passes", () => {
    expect(autonomyGateVerdict(run, pinned(), good)).toEqual({ action: "pass" });
  });

  test("assumption: a changed spec or page, a missing pin, a loose brief or no page parks it", () => {
    const changed = pinned();
    writeFileSync(changed.spec_path!, "# spec, edited");
    expect(autonomyGateVerdict(run, changed, good).action).toBe("park");
    expect(autonomyGateVerdict(run, { ...pinned(), spec_digest: null }, good).action).toBe("park");
    expect(autonomyGateVerdict(run, pinned(), { ...good, briefOk: false }).action).toBe("park");
    expect(autonomyGateVerdict(run, { ...pinned(), review_url: null, page_path: null }, good).action).toBe("park");
  });

  test("assumption: a run started before unattended mode existed behaves as before", () => {
    expect(autonomyGateVerdict(run, pinned(), { ...good, current: false }).action).toBe("skip");
    expect(startedUnderAutonomy(db, 0)).toBe(false);
    expect(startedUnderAutonomy(db, Date.now() + 1000)).toBe(true);
  });
});

function facts(sensitive = 0): MergeFacts {
  const run = { id: "r1", task_id: "t", project_id: "web", sensitive, branch: "flowryn/t", state: "ready" } as unknown as RunWithPolicy;
  const project = { id: "web", path: "/p", default_branch: "main" } as unknown as ProjectRow;
  return {
    run,
    project,
    delivered: { kind: "pr", ref: "https://github.com/acme/web/pull/1", head: "h1", at: 0 },
    ref: "https://github.com/acme/web/pull/1",
    head: "h1",
    title: "t",
    pr: { number: 1, url: "https://github.com/acme/web/pull/1", title: "t", state: "open", draft: false, headSha: "h1", headRef: "flowryn/t", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: null },
    checks: summarize([{ name: "ci", state: "green", detail: "success" }]),
    remote: "h1",
    primaryBranch: null,
    primaryDirty: false,
    fastForward: false,
    local: undefined,
  } as MergeFacts;
}

const daemon = { role: "daemon" as const };
const leader = { role: "leader" as const, runId: null, taskId: null, session: "L1" };

describe("the merge takes the standing approval", () => {
  test("the daemon's merge of sensitive, not-yolo work in a covered project is allowed, and records it", () => {
    grant(["web"]);
    const chosen = chooseApproval(db, facts(1), { caller: daemon }, "merge", NOW + HOUR);
    expect(chosen.choice).toEqual({ kind: "autonomy", autonomy: "u1" });
    expect(refusal(() => checkGate(facts(1), chosen))).toBe("ok");
    const id = tx(db, () => takeApproval(db, facts(1), chosen.choice!, "merge", NOW + HOUR));
    const row = db.query("SELECT channel, actor, consumed_at FROM approvals WHERE id = ?1").get(id) as { channel: string; actor: string; consumed_at: number | null };
    expect(row.channel).toBe("autonomous");
    expect(row.actor).toContain("u1");
    expect(row.consumed_at).not.toBeNull();
  });

  test("assumption: a leader's merge never takes it, and neither does a waiver", () => {
    grant(["web"]);
    db.query("INSERT INTO leader_sessions (session_id, harness, token_hash) VALUES ('L1', 'claude', 'x')").run();
    expect(chooseApproval(db, facts(1), { caller: leader }, "merge", NOW + HOUR).choice).toBeNull();
    expect(chooseApproval(db, facts(1), { caller: daemon, allowRed: "ci" }, "merge", NOW + HOUR).choice).toBeNull();
  });

  test("assumption: an expired grant, an ended one, or another project's grants nothing", () => {
    grant(["api"]);
    expect(chooseApproval(db, facts(1), { caller: daemon }, "merge", NOW + HOUR).choice).toBeNull();
    grant(["web"], NOW + 2 * HOUR, NOW + HOUR);
    expect(chooseApproval(db, facts(1), { caller: daemon }, "merge", NOW + 3 * HOUR).choice).toBeNull();
    tx(db, () => endAutonomy(db, NOW + 90 * 60_000));
    expect(chooseApproval(db, facts(1), { caller: daemon }, "merge", NOW + 100 * 60_000).choice).toBeNull();
  });

  test("assumption: a red check is still refused under the standing approval", () => {
    grant(["web"]);
    const red = { ...facts(1), checks: summarize([{ name: "ci", state: "red", detail: "failure" }]) };
    const chosen = chooseApproval(db, red, { caller: daemon }, "merge", NOW + HOUR);
    expect(refusal(() => checkGate(red, chosen))).toBe("red_checks");
  });

  test("a choice whose grant ended before the merge records is refused", () => {
    grant(["web"]);
    const chosen = chooseApproval(db, facts(1), { caller: daemon }, "merge", NOW + HOUR);
    tx(db, () => endAutonomy(db, NOW + HOUR));
    expect(refusal(() => tx(db, () => takeApproval(db, facts(1), chosen.choice!, "merge", NOW + HOUR + 1)))).toBe("approval_required");
  });
});

describe("the morning report", () => {
  test("lists gates, decisions, merges and parked tasks, filtered by the lens, words sanitised", () => {
    const row = grant(["web"]);
    tx(db, () => {
      db.query("INSERT INTO events (ulid, ts, source, task_id, kind, payload) VALUES ('e1', ?1, 'daemon', 't', 'autonomy.gate_passed', ?2)").run(NOW + 1, JSON.stringify({ autonomy: "u1", gate: "g1", stage: "design", review_url: "http://127.0.0.1:1/session/x", spec_path: "/r/design/spec.md" }));
      db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, answer, answered_by, answered_via, rationale, created_at) VALUES ('q9', 't', 'r1', 'Which layout?', '[\"flat\",\"nested\"]', 0, 'answered', 'flat', 'worker', 'autonomous', 'Decided under unattended mode (u1) as the worker recommended: fewer files', ?1)").run(NOW);
      db.query("INSERT INTO events (ulid, ts, source, task_id, kind, payload) VALUES ('e2', ?1, 'daemon', 't', 'autonomy.decided', ?2)").run(NOW + 2, JSON.stringify({ autonomy: "u1", decision: "q9", choice: "flat" }));
      const approval = mintAutonomyApproval(db, row, { task: "t", ref: "https://github.com/acme/web/pull/1", head: "h1", action: "merge" }, NOW + 3);
      db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state, merge_sha) VALUES ('m1', 't', 'https://github.com/acme/web/pull/1', 'h1', ?1, ?2, 'merged', 'abcdef1234567890')").run(approval.id, NOW + 4);
      db.query("INSERT INTO events (ulid, ts, source, task_id, kind, payload) VALUES ('e3', ?1, 'daemon', 'other', 'autonomy.parked', ?2)").run(NOW + 5, JSON.stringify({ autonomy: "u1", gate: "g2", why: "a destructive question\u001b[31m" }));
      insertApproval(db, { task: "t", ref: "x", head: "h", channel: "cli-tty", actor: "me", action: "merge", now: NOW });
    });
    const lines = autonomyLines(db, { since: NOW - 1, until: NOW + HOUR, now: NOW + HOUR, lens: SEES_ALL });
    const text = lines.join("\n");
    expect(lines[0]).toContain("Autonomous (u1: live, projects web");
    expect(text).toContain("design review g1 passed; page http://127.0.0.1:1/session/x; spec /r/design/spec.md");
    expect(text).toContain('[q9] t: "Which layout?" → flat; why: fewer files; undo: flowryn decide q9 <choice> --by captain');
    expect(text).toContain("https://github.com/acme/web/pull/1 merged as abcdef123456");
    expect(text).toContain("other on g2: a destructive question");
    expect(text).not.toContain("\u001b");
    const scoped = { ...SEES_ALL, restricted: true, task: (id: string | null | undefined) => id === "t" };
    expect(autonomyLines(db, { since: NOW - 1, until: NOW + HOUR, now: NOW + HOUR, lens: scoped }).join("\n")).toContain("Parked: none.");
  });

  test("nothing at all when no grant was live in the window", () => {
    expect(autonomyLines(db, { since: NOW, until: NOW + HOUR, now: NOW + HOUR, lens: SEES_ALL })).toEqual([]);
  });
});
