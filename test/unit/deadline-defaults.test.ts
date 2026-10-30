import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startAway } from "../../src/attention/away.ts";
import { composeBriefing, composeReturnBrief } from "../../src/attention/briefing.ts";
import { deadlineDefaults, deadlineRefusal, userAbsent, waitedLabel } from "../../src/attention/deadline-defaults.ts";
import { DEADLINE_FLOOR, decisionsConfig, RESERVED_CLASSES, type DecisionsConfig } from "../../src/attention/decisions-policy.ts";
import { parseConfig } from "../../src/config/config.ts";
import { configSectionProblems } from "../../src/config/effective.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { CI_WAIT_ORIGIN, CI_WAIT_OPTIONS, CI_WAIT_RESERVED } from "../../src/lifecycle/ci-wait.ts";
import { overrideRuleAnswer } from "../../src/lifecycle/decision-verbs.ts";
import { getDecision, isRuleAnswer, type DecisionRow } from "../../src/lifecycle/decisions.ts";
import { claim, openSession } from "../../src/lease/lease.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * Deadline defaults (docs/notes/2026-10-30-deadline-defaults-for-gg.md): the
 * config and its floor, each eligibility check alone, the pass while the user
 * is away or inactive, the brief's "Decided for you" lines and the undo.
 */

let h: TestHome;
let db: Db;
const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 30, 9, 0).getTime();

const config = (text: string) => decisionsConfig(parseConfig(text, "/tmp/h"));
const OPTED: DecisionsConfig = config('[decisions]\ndefault_classes = ["ci-wait", "nomistakes"]\n');

beforeEach(() => {
  h = makeHome();
  db = h.db();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://example.test/web.git', '/tmp/web', 'main', 'no-mistakes')").run();
  run("r1", "web-a", 0);
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function run(id: string, taskId: string, sensitive: 0 | 1, state = "validating"): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', 1, ?2, 'feature', 0)").run(taskId, sensitive);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '2.1.281', ?3, 'busy', 'feature', 'ship', '/tmp/wt', 'fm/x', 'abc123', 'h', 0, 0)`,
  ).run(id, taskId, state);
}

let next = 1;
/** A CI-wait question as the watchdog opens it, `ageH` hours old; `over` changes any column. */
function question(ageH: number, over: Partial<DecisionRow> = {}): DecisionRow {
  const id = `q${next++}`;
  const d = {
    id,
    task_id: "web-a",
    run_id: "r1",
    question: "Ship x (web): its no-mistakes pipeline has waited 130 min in CI with no checks registered.",
    options: JSON.stringify(CI_WAIT_OPTIONS),
    origin: CI_WAIT_ORIGIN,
    key: id,
    recommendation: "merge-main",
    reserved_reason: CI_WAIT_RESERVED,
    reserved_class: "ci-wait",
    created_at: NOW - ageH * HOUR,
    ...over,
  };
  db.query(
    `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, recommendation, reserved_reason, reserved_class, created_at, gate_id, defer_until, context)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 'open', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  ).run(d.id, d.task_id, d.run_id, d.question, d.options, d.origin, d.key, d.recommendation, d.reserved_reason, d.reserved_class, d.created_at, over.gate_id ?? null, over.defer_until ?? null, over.context ?? null);
  return getDecision(db, id)!;
}

const away = () => tx(db, () => startAway(db, { until: NOW + 8 * HOUR, words: null, by: "human", now: NOW - HOUR }));
const pass = (cfg = OPTED, now = NOW) => tx(db, () => deadlineDefaults(db, { cfg, now }));
const runOf = (state = "validating", sensitive = 0) => ({ state: state as "validating", sensitive });

describe("[decisions] default_after_h and default_classes", () => {
  test("off by default: four hours, no kinds", () => {
    const cfg = config("");
    expect(cfg.default_after_h).toBe(4);
    expect(cfg.default_classes).toEqual([]);
  });

  test.each([...RESERVED_CLASSES])("the floor refuses %s whatever the config says", (klass) => {
    expect(() => config(`[decisions]\ndefault_classes = ["ci-wait", "${klass}"]\n`)).toThrow(`${klass} is always the user's; no deadline may answer it`);
  });

  test("every keyword class is on the floor, including irreversible and outward", () => {
    expect([...DEADLINE_FLOOR].toSorted()).toEqual([...RESERVED_CLASSES].toSorted());
  });

  test("unknown kinds and bad hours are refused; a floor class is a startup problem", () => {
    expect(() => config('[decisions]\ndefault_classes = ["lint"]\n')).toThrow("lint is not one of ci-wait, nomistakes");
    expect(() => config("[decisions]\ndefault_after_h = 0\n")).toThrow("default_after_h");
    expect(() => config("[decisions]\ndefault_after_h = 169\n")).toThrow("at most 168");
    expect(() => config('[decisions]\ndefault_after_h = "4"\n')).toThrow("default_after_h");
    expect(config("[decisions]\ndefault_after_h = 0.5\n").default_after_h).toBe(0.5);
    expect(configSectionProblems(parseConfig('[decisions]\ndefault_classes = ["merge"]\n', "/tmp/h")).join(" ")).toContain("merge is always the user's");
  });
});

describe("deadlineRefusal: each check alone", () => {
  test("a due, opted-in CI-wait question with a recommendation may be answered", () => {
    expect(deadlineRefusal(question(5), runOf(), OPTED, NOW)).toBeNull();
  });

  test.each<[string, Partial<DecisionRow>, string]>([
    ["a question with no kind (older rows, a worker's own reason)", { reserved_class: null }, "kind none is always the user's"],
    ["a keyword class", { reserved_class: "destructive" }, "kind destructive is always the user's"],
    ["a no-mistakes ask a floor kept for the user", { reserved_class: "nomistakes-floor" }, "kind nomistakes-floor is always the user's"],
    ["a no-mistakes ask whose facts did not read", { reserved_class: "nomistakes-unread" }, "kind nomistakes-unread is always the user's"],
    ["no recommendation", { recommendation: null }, "no recommendation among its options"],
    ["a recommendation outside the options", { recommendation: "ship-it" }, "no recommendation among its options"],
    ["the recommendation keep-waiting", { recommendation: "keep-waiting" }, "the recommendation keep-waiting is the user's"],
    ["the recommendation accept-without-ci", { recommendation: "accept-without-ci" }, "the recommendation accept-without-ci is the user's"],
    ["a review gate's question", { gate_id: "g1" }, "review-gate question"],
    ["a deferred question", { defer_until: "2026-11-02" }, "deferred"],
    ["wording that names a protected kind", { context: "and then delete the old bucket" }, "its wording names a protected kind"],
  ])("refused: %s", (_name, over, why) => {
    expect(deadlineRefusal(question(5, over), runOf(), OPTED, NOW)).toBe(why);
  });

  test("a kind that is not opted in, a question not yet due, a run that is over or sensitive", () => {
    const d = question(5);
    expect(deadlineRefusal(d, runOf(), config('[decisions]\ndefault_classes = ["nomistakes"]\n'), NOW)).toBe("kind ci-wait is not opted in");
    expect(deadlineRefusal(question(3.9), runOf(), OPTED, NOW)).toBe("has not waited long enough");
    expect(deadlineRefusal(d, runOf("cleaned"), OPTED, NOW)).toBe("its run is over");
    expect(deadlineRefusal(d, null, OPTED, NOW)).toBe("its run is over");
    expect(deadlineRefusal(d, runOf("validating", 1), OPTED, NOW)).toBe("sensitive task");
  });

  test("the wording check holds even when reserved_classes narrows the keyword classes", () => {
    const narrow = { ...OPTED, reserved_classes: ["credential"] };
    expect(deadlineRefusal(question(5, { context: "force-push the branch" }), runOf(), narrow, NOW)).toBe("its wording names a protected kind");
  });

  test("a standalone decision is never taken", () => {
    const d = { ...question(5), run_id: null };
    expect(deadlineRefusal(d, runOf(), OPTED, NOW)).toBe("standalone decision");
  });
});

describe("the pass", () => {
  test("the user present: nothing is answered, however old", () => {
    const d = question(30);
    expect(userAbsent(db, NOW)).toBe(false);
    expect(pass()).toEqual([]);
    expect(getDecision(db, d.id)!.state).toBe("open");
  });

  test("off while default_classes is empty, even with the user away", () => {
    question(30);
    away();
    expect(pass(config(""))).toEqual([]);
  });

  test("away: a due question is answered as recommended by policy via deadline, the worker steered, an event recorded", () => {
    const due = question(4.2);
    const young = question(1);
    away();
    const answered = pass();
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ decision: due.id, run: "r1", choice: "merge-main" });
    const row = getDecision(db, due.id)!;
    expect(row).toMatchObject({ state: "answered", answer: "merge-main", answered_by: "policy", answered_via: "deadline" });
    expect(row.rationale).toContain("after 4h 12m while the user was away");
    expect(isRuleAnswer(row)).toBe(true);
    const steer = db.query("SELECT body FROM messages WHERE id = ?1").get(answered[0]!.steer) as { body: string };
    expect(steer.body).toContain("git merge origin/main");
    const event = db.query("SELECT payload FROM events WHERE kind = 'decision.deadline_default'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ decision: due.id, class: "ci-wait", choice: "merge-main", waited_ms: 4.2 * HOUR });
    expect(getDecision(db, young.id)!.state).toBe("open");
    // A second pass finds nothing left to take.
    expect(pass()).toEqual([]);
  });

  test("inactive in every leader session counts as absent; one active session does not", () => {
    question(5);
    const session = (inactiveSince: number | null) =>
      tx(db, () => {
        const { session: id } = openSession(db, { harness: "claude", pane: `p${next++}`, cwd: "/x", now: NOW - 10 * HOUR });
        db.query("UPDATE leader_sessions SET user_inactive_since = ?2 WHERE session_id = ?1").run(id, inactiveSince);
        return id;
      });
    const first = session(NOW - 30 * 60_000);
    tx(db, () => claim(db, first, "vacant", NOW - 10 * HOUR));
    expect(userAbsent(db, NOW)).toBe(true);
    db.query("UPDATE leader_sessions SET user_inactive_since = NULL WHERE session_id = ?1").run(first);
    expect(userAbsent(db, NOW)).toBe(false);
    expect(pass()).toEqual([]);
  });
});

describe("the brief and the undo", () => {
  test("the return brief lists a deadline answer under Decided for you, with its wait and undo, and not under Settled by rule", () => {
    const d = question(5);
    away();
    pass();
    const brief = composeReturnBrief(db, { since: NOW - HOUR, until: NOW + HOUR, now: NOW + HOUR, ageMs: HOUR, reason: "back" });
    expect(brief).toContain("Decided for you (1):");
    expect(brief).toContain(`- [${d.id}] Ship x (web)`);
    expect(brief).toContain(`→ merge-main (deadline after 5h 0m; undo: flowryn decide ${d.id} <choice> --by captain)`);
    expect(brief).not.toContain("Settled by rule");
    expect(brief).not.toContain("Decided for you: nothing.");
  });

  test("once the run is over the brief says there is no undo", () => {
    const d = question(5);
    away();
    pass();
    db.query("UPDATE runs SET state = 'cleaned' WHERE id = 'r1'").run();
    const brief = composeReturnBrief(db, { since: NOW - HOUR, until: NOW + HOUR, now: NOW + HOUR, ageMs: HOUR, reason: "back" });
    expect(brief).toContain(`[${d.id}]`);
    expect(brief).toContain("run over, no undo");
  });

  test("the regular briefing lists it too", () => {
    question(5);
    away();
    pass();
    const briefing = tx(db, () => composeBriefing(db, { session: null, now: NOW + 1, morningHour: 7, ageMs: HOUR, markMorning: false }));
    expect(JSON.stringify(briefing)).toContain("Decided for you since the last briefing (1):");
    expect(JSON.stringify(briefing)).toContain("deadline after 5h 0m");
  });

  test("undo of a CI-wait deadline answer steers the worker to the new choice's instruction", () => {
    const d = question(5);
    away();
    pass();
    const undone = tx(db, () => overrideRuleAnswer({ db, now: () => NOW + HOUR }, getDecision(db, d.id)!, { choice: "accept-without-ci", words: null, via: "shell" }));
    const body = (db.query("SELECT body FROM messages WHERE id = ?1").get(undone.steer) as { body: string }).body;
    expect(body).toContain(`The user changed the answer to ${d.id} from merge-main (deadline) to accept-without-ci.`);
    expect(body).toContain("no-mistakes axi abort");
    expect(getDecision(db, d.id)).toMatchObject({ answer: "accept-without-ci", answered_by: "captain" });
  });

  test("undo of a no-mistakes deadline answer names the deadline, not a rule", () => {
    const d = question(5, { reserved_class: "nomistakes", origin: "web-a", options: JSON.stringify(["fix", "approve", "skip"]), recommendation: "fix", reserved_reason: "nomistakes: no rule for r-1 (review warning, touched)", question: "no-mistakes review finding r-1" });
    away();
    pass();
    const undone = tx(db, () => overrideRuleAnswer({ db, now: () => NOW + HOUR }, getDecision(db, d.id)!, { choice: "approve", words: null, via: "shell" }));
    const body = (db.query("SELECT body FROM messages WHERE id = ?1").get(undone.steer) as { body: string }).body;
    expect(body).toContain("from fix (deadline) to approve");
    expect(body).toContain("if what you did on the deadline default's answer is already committed");
  });

  test("the user confirming the deadline's own choice records it and steers nothing", () => {
    for (const fields of [{}, { reserved_class: "nomistakes", origin: "web-a", options: JSON.stringify(["fix", "approve", "skip"]), recommendation: "fix", reserved_reason: "nomistakes: no rule for r-1 (review warning, touched)", question: "no-mistakes review finding r-1" }]) {
      const d = question(5, fields);
      away();
      pass();
      const answered = getDecision(db, d.id)!;
      const steers = (db.query("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
      const confirmed = tx(db, () => overrideRuleAnswer({ db, now: () => NOW + HOUR }, answered, { choice: answered.answer!, words: null, via: "shell" }));
      expect(confirmed.steer).toBeNull();
      expect((db.query("SELECT count(*) AS n FROM messages").get() as { n: number }).n).toBe(steers);
      expect(getDecision(db, d.id)).toMatchObject({ answer: answered.answer, answered_by: "captain", answered_via: "shell", rationale: `(confirmed ${answered.answer} (deadline))` });
    }
  });

  test("the user confirming the deadline's choice with words passes the words on without a redo", () => {
    const d = question(5);
    away();
    pass();
    const confirmed = tx(db, () => overrideRuleAnswer({ db, now: () => NOW + HOUR }, getDecision(db, d.id)!, { choice: "merge-main", words: "also add a regression test", via: "shell" }));
    const body = (db.query("SELECT body FROM messages WHERE id = ?1").get(confirmed.steer) as { body: string }).body;
    expect(body).toBe(`The user confirmed merge-main for ${d.id}; keep going as you are, nothing to undo or redo. The user's words: "also add a regression test"`);
    expect(getDecision(db, d.id)).toMatchObject({ answer: "merge-main", answered_by: "captain", rationale: "(confirmed merge-main (deadline))\nalso add a regression test" });
  });

  test("waitedLabel", () => {
    expect(waitedLabel(4 * HOUR + 12 * 60_000 + 59_000)).toBe("4h 12m");
  });
});
