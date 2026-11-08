import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endAway, startAway } from "../../src/attention/away.ts";
import { composeReturnBrief } from "../../src/attention/briefing.ts";
import { decisionsConfig, type DecisionsConfig } from "../../src/attention/decisions-policy.ts";
import {
  applyValidation,
  callValidator,
  changesWords,
  gateFacts,
  getValidation,
  pageText,
  parseValidatorReply,
  pickValidations,
  questionTake,
  validatorAction,
  validatorRefusal,
  VALIDATOR_CONTRACT,
  type CallResult,
  type GateFacts,
} from "../../src/attention/gate-validator.ts";
import { loadConfig, parseConfig } from "../../src/config/config.ts";
import { configSectionProblems } from "../../src/config/effective.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { parseGateQuestions } from "../../src/lavish/questions.ts";
import { getDecision, isRuleAnswer } from "../../src/lifecycle/decisions.ts";
import { openGateQuestions } from "../../src/lifecycle/gate-questions.ts";
import { getRun, getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { type GateRow } from "../../src/lifecycle/stages.ts";
import { reopenableValidatorPass } from "../../src/policy/gates.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

/**
 * The review-gate validator (docs/notes/2026-11-08-unattended-loops-answer-4y.md): its config,
 * every eligibility check alone, the reply schema, the question rule, what a finished call does,
 * the brief's lines and the undo's checks. No model is called: the call goes through its seam.
 */

let h: TestHome;
let db: Db;
let runId: string;
let taskId: string;
let page: string;
const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 8, 23, 0).getTime();
const HEAD = "a".repeat(40);

const config = (text: string) => decisionsConfig(parseConfig(text, "/tmp/h"));
const CFG: DecisionsConfig = config('[decisions]\ndefault_gates = ["design", "qa"]\ndefault_after_h = 2\n');

const QUESTIONS = {
  questions: [
    { key: "store", kind: "single", question: "Where do cached tokens live?", options: ["db", "file"], recommend: "db", blocks: "which store TokenCache writes to", why: "db is transactional" },
  ],
  decided: [],
};

beforeEach(() => {
  h = makeHome();
  const seeded = seedRun(h);
  runId = seeded.runId;
  taskId = seeded.taskId;
  db = h.db();
  db.query("UPDATE runs SET workflow = 'feature', stage = 'design', stage_state = 'review' WHERE id = ?1").run(runId);
  db.query("UPDATE task_policy SET workflow = 'feature' WHERE task_id = ?1").run(taskId);
  mkdirSync(join(h.dataDir, taskId, "design"), { recursive: true });
  page = join(realpathSync(join(h.dataDir, taskId)), "design", "design.html");
  writeFileSync(page, "<html><body><h1>Design</h1><p>Store tokens in the db.</p><script>evil()</script></body></html>");
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, page_path, state, opened_at) VALUES ('g1', ?1, 'design', 'review', 'http://127.0.0.1:4387/session/x', ?2, 'open', ?3)").run(runId, page, NOW - 3 * HOUR);
});

afterEach(() => {
  db.close();
  h.cleanup();
});

const gate = (): GateRow => db.query("SELECT * FROM gates WHERE id = 'g1'").get() as GateRow;
const awayBy = (by: string, now = NOW - HOUR) => tx(db, () => startAway(db, { until: NOW + 8 * HOUR, words: null, by, now }));
const withQuestions = () => tx(db, () => openGateQuestions(db, getRun(db, runId)!, { id: "g1", stage: "design", review_url: null }, page, parseGateQuestions(JSON.stringify(QUESTIONS)), NOW - 3 * HOUR));
const pick = (now = NOW, inFlight: Set<string> = new Set()) => tx(db, () => pickValidations(db, { cfg: CFG, now, heads: new Map([[runId, HEAD]]), inFlight, limit: 2 }));
const reply = (obj: unknown): CallResult => ({ reply: JSON.stringify(obj), costUsd: 0.12 });
const apply = (id: string, result: CallResult, headNow: string | null = HEAD, now = NOW + 60_000) => tx(db, () => applyValidation(db, { id, result, headNow, cfg: CFG, now, reportPath: null }));
const PASS = { verdict: "pass", findings: [], questions: [] };
const CHANGES = { verdict: "changes", findings: [{ requirement: "Requirement 2", problem: "The cap is not enforced.", fix: "Abort past the cap." }], questions: [] };

/** Facts that pass every check; each test breaks one. */
function okFacts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    gate: { kind: "review", state: "open", stage: "design", opened_at: NOW - 3 * HOUR, page_path: "/p.html" },
    run: { state: "running", sensitive: 0 },
    away: { since: NOW - HOUR },
    autonomyCovered: false,
    pendingPlan: false,
    pinned: true,
    roundsUsed: 0,
    running: false,
    questions: [],
    ...over,
  };
}

describe("[decisions] default_gates, validator_max_usd and validator_rounds", () => {
  test("off by default: no gates, $1, two rounds", () => {
    expect(config("")).toMatchObject({ default_gates: [], validator_max_usd: 1, validator_rounds: 2 });
  });

  test("design and qa are taken; anything else, a bad cap or bad rounds are refused", () => {
    expect(CFG.default_gates).toEqual(["design", "qa"]);
    expect(() => config('[decisions]\ndefault_gates = ["merge"]\n')).toThrow(/not one of design, qa/);
    expect(() => config('[decisions]\ndefault_gates = "design"\n')).toThrow(/list of review stages/);
    for (const usd of ["0", "21", '"1"']) expect(() => config(`[decisions]\nvalidator_max_usd = ${usd}\n`)).toThrow(/validator_max_usd/);
    for (const rounds of ["0", "6", "1.5"]) expect(() => config(`[decisions]\nvalidator_rounds = ${rounds}\n`)).toThrow(/validator_rounds/);
    expect(config("[decisions]\nvalidator_max_usd = 2.5\nvalidator_rounds = 3\n")).toMatchObject({ validator_max_usd: 2.5, validator_rounds: 3 });
  });

  test("a bad key is a startup problem, so SIGHUP's reload is rejected too", () => {
    const problems = configSectionProblems(parseConfig('[decisions]\ndefault_gates = ["build"]\n', "/tmp/h"));
    expect(problems.join("\n")).toContain("default_gates");
  });
});

describe("validatorRefusal: each check alone", () => {
  test("eligible facts pass", () => {
    expect(validatorRefusal(okFacts(), CFG, NOW)).toBeNull();
  });

  const cases: [string, Partial<GateFacts>, RegExp][] = [
    ["a merge gate", { gate: { ...okFacts().gate, kind: "merge" } }, /not a review gate/],
    ["a closed gate", { gate: { ...okFacts().gate, state: "passed" } }, /not open/],
    ["a stage not opted in", { gate: { ...okFacts().gate, stage: "draft" } }, /not opted in/],
    ["no user-started away", { away: null }, /has not started away/],
    ["too young", { gate: { ...okFacts().gate, opened_at: NOW - HOUR } }, /not waited long enough/],
    ["no run", { run: null }, /run is over/],
    ["an ended run", { run: { state: "failed", sensitive: 0 } }, /run is over/],
    ["a sensitive task", { run: { state: "running", sensitive: 1 } }, /sensitive/],
    ["unattended mode covers it", { autonomyCovered: true }, /unattended mode/],
    ["a pending plan", { pendingPlan: true }, /phase plan/],
    ["no page", { gate: { ...okFacts().gate, page_path: null } }, /no review page/],
    ["the pins changed", { pinned: false }, /changed since it was pinned/],
    ["one running", { running: true }, /already running/],
    ["rounds used", { roundsUsed: 2 }, /2 validator rounds used/],
    ["a floor-kind question", { questions: [{ question: "Pick one", context: null, reserved_class: "security" }] }, /kind security/],
    ["a protected wording", { questions: [{ question: "Drop the users table?", context: null, reserved_class: null }] }, /wording names a protected kind/],
  ];
  for (const [name, over, why] of cases) {
    test(name, () => {
      expect(validatorRefusal(okFacts(over), CFG, NOW)).toMatch(why);
    });
  }

  test("with default_gates empty nothing is opted in", () => {
    expect(validatorRefusal(okFacts(), config(""), NOW)).toMatch(/not opted in/);
  });
});

describe("parseValidatorReply", () => {
  const open = ["q1"];
  test("a pass, a changes with findings, and a fenced reply parse", () => {
    expect(parseValidatorReply(JSON.stringify(PASS), open)).toEqual({ verdict: "pass", findings: [], questions: [] });
    expect(parseValidatorReply(JSON.stringify(CHANGES), open)?.findings).toEqual([{ requirement: "Requirement 2", file: null, problem: "The cap is not enforced.", fix: "Abort past the cap." }]);
    const fenced = `Here it is:\n\`\`\`json\n${JSON.stringify({ ...PASS, questions: [{ id: "q1", choice: "db", consistent_with_spec: true, why: "spec says db" }] })}\n\`\`\``;
    expect(parseValidatorReply(fenced, open)?.questions).toEqual([{ id: "q1", choice: "db", consistent_with_spec: true, why: "spec says db" }]);
  });

  test("a pass that lists findings is read as changes", () => {
    expect(parseValidatorReply(JSON.stringify({ ...CHANGES, verdict: "pass" }), open)?.verdict).toBe("changes");
  });

  const bad: [string, string][] = [
    ["prose", "Looks good to me."],
    ["an array", "[]"],
    ["an extra key", JSON.stringify({ ...PASS, merge: true })],
    ["an unknown verdict", JSON.stringify({ ...PASS, verdict: "approve" })],
    ["changes without findings", JSON.stringify({ ...PASS, verdict: "changes" })],
    ["a finding without requirement or file", JSON.stringify({ ...CHANGES, findings: [{ problem: "x", fix: "y" }] })],
    ["a finding with an extra key", JSON.stringify({ ...CHANGES, findings: [{ file: "a.ts", problem: "x", fix: "y", run: "rm" }] })],
    ["an oversized field", JSON.stringify({ ...CHANGES, findings: [{ file: "a.ts", problem: "x".repeat(601), fix: "y" }] })],
    ["too many findings", JSON.stringify({ ...CHANGES, findings: Array.from({ length: 21 }, () => ({ file: "a.ts", problem: "x", fix: "y" })) })],
    ["an unknown question", JSON.stringify({ ...PASS, questions: [{ id: "q9", choice: "db", consistent_with_spec: true, why: "w" }] })],
    ["a question twice", JSON.stringify({ ...PASS, questions: [1, 2].map(() => ({ id: "q1", choice: "db", consistent_with_spec: true, why: "w" })) })],
    ["consistent_with_spec not a boolean", JSON.stringify({ ...PASS, questions: [{ id: "q1", choice: "db", consistent_with_spec: "yes", why: "w" }] })],
  ];
  for (const [name, text] of bad) {
    test(`no verdict: ${name}`, () => {
      expect(parseValidatorReply(text, open)).toBeNull();
    });
  }
});

describe("questionTake", () => {
  const d = { kind: "single", options: JSON.stringify(["db", "file"]), recommendation: "db" } as const;
  const v = (choice: string, consistent: boolean) => ({ id: "q1", choice, consistent_with_spec: consistent, why: "w" });
  test("the recommendation, picked and consistent, is taken", () => expect(questionTake(d, v("db", true))).toBe("db"));
  test("picked but not consistent is left", () => expect(questionTake(d, v("db", false))).toBeNull());
  test("another choice is left, even consistent", () => expect(questionTake(d, v("file", true))).toBeNull());
  test("no entry is left", () => expect(questionTake(d, undefined)).toBeNull());
  test("a recommendation that is not an option is left", () => expect(questionTake({ ...d, recommendation: "redis" }, v("redis", true))).toBeNull());
  test("a multi question is left", () => expect(questionTake({ ...d, kind: "multi" }, v("db", true))).toBeNull());
});

describe("validatorAction", () => {
  const verdict = { verdict: "pass" as const, findings: [], questions: [] };
  const base = { verdict, failure: null, refusal: null, awayChanged: false, headMoved: false };
  test("a verdict acts", () => expect(validatorAction(base)).toEqual({ action: "pass" }));
  test("no verdict fails", () => expect(validatorAction({ ...base, verdict: null, failure: "timed out" })).toEqual({ action: "fail", why: "timed out" }));
  test("the user back advises", () => expect(validatorAction({ ...base, awayChanged: true }).action).toBe("advise"));
  test("eligibility lost advises", () => expect(validatorAction({ ...base, refusal: "its run is over" })).toEqual({ action: "advise", why: "its run is over" }));
  test("the head moved advises", () => expect(validatorAction({ ...base, headMoved: true }).action).toBe("advise"));
});

describe("picking and acting, against the database", () => {
  test("nothing is picked without a user-started away: none, automatic, the leader's own", () => {
    expect(pick()).toEqual([]);
    awayBy("auto");
    expect(pick()).toEqual([]);
    awayBy("leader");
    expect(pick()).toEqual([]);
    awayBy("human");
    expect(pick().map((p) => p.id)).toEqual(["j1"]);
    expect(getValidation(db, "j1")).toMatchObject({ state: "running", gate_id: "g1", head: HEAD, waited_ms: 3 * HOUR });
  });

  test("a running row this daemon does not run fails, and its round counts", () => {
    awayBy("human");
    pick();
    // j1 is not this daemon's: it fails, and the second round starts in the same pass.
    expect(pick().map((p) => p.id)).toEqual(["j2"]);
    expect(getValidation(db, "j1")).toMatchObject({ state: "failed", reason: "the daemon stopped while it ran" });
    // j2 is: it keeps running, and the gate gets no third round.
    expect(pick(NOW, new Set(["j2"]))).toEqual([]);
    expect(getValidation(db, "j2")!.state).toBe("running");
  });

  test("pass: the gate passes on channel validator, the next stage is requested", () => {
    awayBy("human");
    const [p] = pick();
    expect(apply(p!.id, reply(PASS))).toMatchObject({ state: "passed" });
    expect(gate().state).toBe("passed");
    const approval = db.query("SELECT channel, actor FROM approvals WHERE id = ?1").get(gate().approval_id) as { channel: string; actor: string };
    expect(approval).toEqual({ channel: "validator", actor: "validator j1" });
    expect(getRun(db, runId)!.stage).toBe("build");
    expect(getValidation(db, "j1")).toMatchObject({ state: "passed", cost_usd: 0.12 });
  });

  test("pass with a question: the agreeing recommendation is taken by policy via validator, then the gate passes", () => {
    const [q] = withQuestions();
    awayBy("human");
    const [p] = pick();
    apply(p!.id, reply({ ...PASS, questions: [{ id: q, choice: "db", consistent_with_spec: true, why: "the spec stores in the db" }] }));
    const d = getDecision(db, q!)!;
    expect(d).toMatchObject({ state: "answered", answer: "db", answered_by: "policy", answered_via: "validator" });
    expect(isRuleAnswer(d)).toBe(true);
    expect(gate().state).toBe("passed");
  });

  test("pass with a question it disagrees with: the question stays open, the gate is held for the user", () => {
    const [q] = withQuestions();
    awayBy("human");
    const [p] = pick();
    expect(apply(p!.id, reply({ ...PASS, questions: [{ id: q, choice: "file", consistent_with_spec: true, why: "w" }] }))).toMatchObject({ state: "held" });
    expect(getDecision(db, q!)!.state).toBe("open");
    expect(gate().state).toBe("open");
    expect(db.query("SELECT 1 FROM items WHERE kind = 'validator_held' AND state = 'open'").get()).not.toBeNull();
  });

  test("changes: the gate is sent back with the findings, attributed to the validator", () => {
    awayBy("human");
    const [p] = pick();
    expect(apply(p!.id, reply(CHANGES))).toMatchObject({ state: "changes" });
    expect(gate()).toMatchObject({ state: "changes" });
    expect(gate().feedback).toContain("The independent validator (j1)");
    expect(gate().feedback).toContain("Fix: Abort past the cap.");
    const event = db.query("SELECT payload FROM events WHERE kind = 'gate.changes'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ by: "validator j1" });
  });

  test("no verdict: malformed, a timeout and a cap breach fail; the gate keeps waiting; an item says so", () => {
    awayBy("human");
    for (const result of [{ reply: "LGTM", costUsd: 0.1 }, { reply: null, reason: "no verdict within 600 s", costUsd: null }, { reply: null, reason: "it reached its $1.00 cap", costUsd: 1.01 }] as CallResult[]) {
      db.query("DELETE FROM gate_validations").run();
      const [p] = pick();
      expect(apply(p!.id, result)).toMatchObject({ state: "failed" });
      expect(gate().state).toBe("open");
    }
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'validator_failed'").get()).toEqual({ n: 3 });
  });

  test("the user came back mid-call: the verdict is advice, nothing acts", () => {
    awayBy("human");
    const [p] = pick();
    tx(db, () => endAway(db, "back", NOW + 1000));
    expect(apply(p!.id, reply(PASS))).toMatchObject({ state: "advised" });
    expect(gate().state).toBe("open");
    expect(db.query("SELECT line FROM items WHERE kind = 'validator_advice'").get()).toMatchObject({ line: expect.stringContaining("flowryn show j1") });
  });

  test("the run ended mid-call: advice, nothing acts", () => {
    awayBy("human");
    const [p] = pick();
    db.query("UPDATE runs SET state = 'cancelled' WHERE id = ?1").run(runId);
    expect(apply(p!.id, reply(PASS))).toMatchObject({ state: "advised" });
    expect(gate().state).toBe("open");
  });

  test("the head moved mid-call: advice", () => {
    awayBy("human");
    const [p] = pick();
    expect(apply(p!.id, reply(PASS), "b".repeat(40))).toMatchObject({ state: "advised" });
    expect(apply(p!.id, reply(PASS))).toBeNull();
  });

  test("at most validator_rounds per stage per away; a new away starts the count again", () => {
    awayBy("human");
    for (let i = 0; i < 2; i++) {
      const [p] = pick();
      apply(p!.id, { reply: "garbage", costUsd: null });
    }
    expect(pick()).toEqual([]);
    expect(validatorRefusal(gateFacts(db, gate(), NOW), CFG, NOW)).toMatch(/2 validator rounds used/);
    tx(db, () => endAway(db, "back", NOW));
    awayBy("human", NOW);
    expect(pick(NOW + 3 * HOUR).length).toBe(1);
  });
});

describe("the brief and the undo", () => {
  test("Decided for you lists the pass with its wait, report and undo, and a changes round", () => {
    awayBy("human");
    const [p] = pick();
    apply(p!.id, reply(PASS));
    const brief = composeReturnBrief(db, { since: NOW - 2 * HOUR, until: NOW + HOUR, now: NOW + HOUR, ageMs: HOUR, reason: "back" });
    expect(brief).toContain("Decided for you (1):");
    expect(brief).toContain(`- [j1] design review of ${taskId} → passed by the validator (after 3h 0m; report: flowryn show j1; undo: flowryn gate reopen ${taskId} --gate design --body-file -)`);
  });

  test("a changes round lists its findings count; a failed round its reason", () => {
    awayBy("human");
    const [p] = pick();
    apply(p!.id, reply(CHANGES));
    const brief = composeReturnBrief(db, { since: NOW - 2 * HOUR, until: NOW + HOUR, now: NOW + HOUR, ageMs: HOUR, reason: "back" });
    expect(brief).toContain("→ sent back by the validator with 1 finding (after 3h 0m; report: flowryn show j1)");
  });

  test("gate reopen is allowed only for a live, undelivered run whose latest review of that stage the validator passed", () => {
    awayBy("human");
    const [p] = pick();
    apply(p!.id, reply(PASS));
    const run = () => getRunWithPolicy(db, runId)!;
    expect(reopenableValidatorPass(db, run(), "design").id).toBe("g1");
    expect(() => reopenableValidatorPass(db, run(), "qa")).toThrow(/no qa review/);
    db.query("INSERT INTO artifacts (task_id, kind, ref, head_sha, created_at) VALUES (?1, 'pr', 'https://example.test/pr/1', ?2, ?3)").run(taskId, HEAD, NOW);
    expect(() => reopenableValidatorPass(db, run(), "design")).toThrow(/delivered/);
    db.query("DELETE FROM artifacts").run();
    db.query("UPDATE approvals SET channel = 'cli-tty'").run();
    expect(() => reopenableValidatorPass(db, run(), "design")).toThrow(/not passed by the validator/);
    db.query("UPDATE runs SET state = 'failed' WHERE id = ?1").run(runId);
    expect(() => reopenableValidatorPass(db, run(), "design")).toThrow(/run is over/);
  });
});

describe("the call (its seam; no model)", () => {
  test("Claude gets the review tools only, the cap, the worktree as an extra dir, a scratch cwd, and the fenced inputs; the contract names the schema", async () => {
    awayBy("human");
    const [p] = pick();
    const loaded = loadConfig(h.home).config;
    let seen: { argv: string[]; cwd: string; stdin: string } | null = null;
    const result = await callValidator({
      db,
      config: loaded,
      git: async () => ({ code: 1, stdout: "", stderr: "no repo" }),
      picked: p!,
      maxUsd: 0.5,
      dir: join(h.stateDir, "validations", p!.id),
      call: async (argv, opts) => {
        seen = { argv, cwd: String(opts.cwd), stdin: String(opts.stdin) };
        return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(PASS), total_cost_usd: 0.03 }), stderr: "", timedOut: false, aborted: false, spawnError: null, truncated: false } as never;
      },
    });
    expect(result).toEqual({ reply: JSON.stringify(PASS), costUsd: 0.03 });
    const s = seen!;
    const flag = (name: string) => s.argv[s.argv.indexOf(name) + 1];
    expect(flag("--tools")).toBe("Read,Grep,Glob");
    expect(flag("--max-budget-usd")).toBe("0.5");
    expect(flag("--add-dir")).toBe("/tmp/wt");
    expect(s.argv).toContain("--restricted");
    expect(s.cwd).toBe(join(h.stateDir, "validations", p!.id, "cwd"));
    expect(s.stdin).toContain("Store tokens in the db.");
    expect(s.stdin).not.toContain("evil()");
    expect(s.stdin).toMatch(/FLOWRYN-DATA-[0-9a-f]{24}/);
    expect(VALIDATOR_CONTRACT).toContain('"verdict": "pass" | "changes"');
  });

  test("a cap breach reported by Claude is no reply", async () => {
    awayBy("human");
    const [p] = pick();
    const result = await callValidator({
      db,
      config: loadConfig(h.home).config,
      git: async () => ({ code: 1, stdout: "", stderr: "" }),
      picked: p!,
      maxUsd: 0.5,
      dir: join(h.stateDir, "validations", p!.id),
      call: async () => ({ code: 1, stdout: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.51, errors: ["Reached maximum budget ($0.5)"] }), stderr: "", timedOut: false, aborted: false, spawnError: null, truncated: false }) as never,
    });
    expect(result.reply).toBeNull();
    expect((result as { reason: string }).reason).toMatch(/cap/);
  });

  test("a timeout and a spawn failure are no reply", async () => {
    awayBy("human");
    const [p] = pick();
    const base = { db, config: loadConfig(h.home).config, git: async () => ({ code: 1, stdout: "", stderr: "" }), picked: p!, maxUsd: 0.5, dir: join(h.stateDir, "validations", p!.id) };
    const timedOut = await callValidator({ ...base, call: async () => ({ code: 124, stdout: "", stderr: "", timedOut: true, aborted: false, spawnError: null, truncated: false }) as never });
    expect((timedOut as { reason: string }).reason).toMatch(/no verdict within/);
    const spawn = await callValidator({ ...base, call: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: "ENOENT", truncated: false }) as never });
    expect((spawn as { reason: string }).reason).toMatch(/did not start/);
  });
});

describe("text helpers", () => {
  test("pageText drops scripts, styles and tags", () => {
    expect(pageText("<style>x{}</style><h1>A</h1><p>b &amp; c</p><script>no()</script>")).toBe("A\nb & c");
  });

  test("changesWords numbers the findings and names the validator", () => {
    const words = changesWords("j4", parseValidatorReply(JSON.stringify(CHANGES), [])!);
    expect(words).toContain("The independent validator (j4)");
    expect(words).toContain("1. (requirement: Requirement 2) The cap is not enforced. Fix: Abort past the cap.");
  });
});
