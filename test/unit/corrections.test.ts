import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { phaseKind } from "../../src/config/workflows.ts";
import { tx, type Db } from "../../src/db/db.ts";
import {
  classPass,
  contentWords,
  correctionsList,
  correctionsOf,
  correctionsPass,
  correctionsPlanOf,
  CORRECTIONS_CLASS_KIND,
  CORRECTIONS_FILER,
  CORRECTIONS_MAX_SHIPS,
  CORRECTIONS_PASS_KIND,
  CORRECTIONS_SHIPS_KIND,
  CORRECTIONS_WINDOW_MS,
  fileChecks,
  filedNote,
  LEARNINGS_SWEPT_KIND,
  listedIds,
  parseChecks,
  parseStale,
  repeatedClass,
  SWEEP_FILER,
} from "../../src/leader/corrections.ts";
import { getLesson, learn, unlearn } from "../../src/leader/learnings.ts";
import { intentArgs, pendingIntents } from "../../src/journal/journal.ts";
import { getProject, listProjects, type ProjectRow } from "../../src/lifecycle/projects.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import { createSteer } from "../../src/lifecycle/steers.ts";
import { CHECKS_HEADING, CORRECT_SKILL_NAME, STALE_HEADING } from "../../src/skills/correct.ts";
import { skillPath, STAGE_SKILLS } from "../../src/skills/stages.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * Corrections become checks (docs/notes/2026-11-22-phase-corrections-become-7t.md): what the weekly
 * list gathers, the weekly pass that files a scout per project, and the filing of the scout's checks
 * as ships. test/integration/corrections.test.ts runs a scout through a real daemon.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 12);

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  tx(db, () => {
    for (const id of ["web", "api"]) {
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, workflow) VALUES (?1, ?2, ?3, 'main', 'local-only', 'fix')").run(id, `https://example.test/${id}.git`, `/tmp/${id}`);
    }
  });
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function seedTask(task: string, project = "web", run = `r-${task}`): RunRow {
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', ?3)").run(task, project, NOW - 3 * DAY);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'cleaned', 'gone', 'fix', 'build', '/tmp/wt', 'fm/x', 'abc123', 'h', ?3, ?3)`,
    ).run(run, task, NOW - 3 * DAY);
  });
  return { id: run, task_id: task } as RunRow;
}

function answer(id: string, task: string, by: string, at: number, question = "Fold the details?"): void {
  db.query(
    "INSERT INTO decisions (id, task_id, question, options, blocking, state, answer, answered_by, answered_at, note, created_at) VALUES (?1, ?2, ?3, '[\"keep\",\"drop\"]', 0, 'answered', 'drop', ?4, ?5, 'less on screen', ?5)",
  ).run(id, task, question, by, at);
}

function gate(id: string, run: string, kind: string, feedback: string | null, closedAt: number, replacedBy: string | null = null): void {
  db.query("INSERT INTO gates (id, run_id, stage, kind, state, feedback, opened_at, closed_at, replaced_by) VALUES (?1, ?2, 'qa', ?3, 'changes', ?4, ?5, ?5, ?6)").run(id, run, kind, feedback, closedAt, replacedBy);
}

function lesson(project: string | null, text: string, now: number, correction = true): number {
  return learn(db, { scope: "default", project, text, until: null, replaces: null, correction, max: 25, now, source: "cli" }).lesson.id;
}

/** One correction of each kind in web, plus ones the list must leave out. */
function seedWeek(): void {
  const run = seedTask("web-page-a1");
  const other = seedTask("api-thing-b2", "api");
  tx(db, () => {
    answer("q1", "web-page-a1", "captain", NOW - DAY);
    answer("q2", "web-page-a1", "policy", NOW - DAY); // a rule's answer: Flowryn's own
    answer("q3", "web-page-a1", "captain", NOW - 9 * DAY); // last week
    answer("q4", "api-thing-b2", "captain", NOW - DAY); // another project
    createSteer(db, run, "Drop the section titles; one table.", NOW - 2 * DAY, null, false, false, "leader");
    createSteer(db, run, "Take the base's new head.", NOW - 2 * DAY); // Flowryn's own steer
    createSteer(db, other, "API words", NOW - 2 * DAY, null, false, false, "leader");
    gate("g10", run.id, "review", "No fold on the briefing; it repeats Context.", NOW - 3 * DAY);
    gate("g11", run.id, "merge", "verify failed", NOW - 3 * DAY); // a failed check, already enforced
    gate("g12", run.id, "review", "replaced by run r2", NOW - 3 * DAY, "r2");
    gate("g13", run.id, "review", "promoted to a ship", NOW - 3 * DAY);
    db.query("INSERT INTO review_messages (gate_id, seq, author, body, created_at) VALUES ('g10', 1, 'user', 'Labels are one word.', ?1), ('g10', 2, 'worker', 'Done.', ?1)").run(NOW - 3 * DAY);
  });
  lesson("web", "User: never repeat what Context shows.", NOW - 4 * DAY);
  lesson("web", "User: one table, no section titles.", NOW - 20 * DAY);
  lesson("web", "User: one table, no section titles.", NOW - 2 * DAY); // confirmed again this week
  lesson("web", "Old lesson", NOW - 20 * DAY);
  lesson(null, "No project", NOW - DAY);
  lesson("web", "Web deploys from the release branch.", NOW - DAY, false); // a plain fact, not a correction
}

describe("the week's corrections", () => {
  test("people's corrections in the project and window: captain answers, leader steers, page words, review send-backs, lessons new or confirmed again", () => {
    seedWeek();
    const rows = correctionsOf(db, "web", NOW - CORRECTIONS_WINDOW_MS, NOW);
    expect(rows.map((r) => [r.id, r.source])).toEqual([
      ["l1", "lesson"],
      ["g10", "send-back"],
      ["g10.1", "page"],
      ["l2", "lesson"],
      ["m1", "steer"],
      ["q1", "answer"],
    ]);
    expect(rows.find((r) => r.id === "q1")!.text).toBe("Fold the details? → drop: less on screen");
    expect(rows.find((r) => r.id === "l2")).toMatchObject({ text: "User: one table, no section titles.", again: true });
    expect(correctionsList("web", NOW - CORRECTIONS_WINDOW_MS, NOW, rows)).toContain("- l2 · lesson learned again · 2026-11-20 · - · User: one table, no section titles.");
    expect(correctionsOf(db, "api", NOW - CORRECTIONS_WINDOW_MS, NOW).map((r) => r.id)).toEqual(["m3", "q4"]);
  });

  test("the list: one line per correction, id first, words sanitised and secrets redacted", () => {
    seedTask("web-page-a1");
    tx(db, () => answer("q1", "web-page-a1", "captain", NOW - DAY, "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789?\nyes\u001b[31m"));
    const list = correctionsList("web", NOW - CORRECTIONS_WINDOW_MS, NOW, correctionsOf(db, "web", NOW - CORRECTIONS_WINDOW_MS, NOW));
    expect(list).toStartWith("# Corrections in web, 2026-11-15 to 2026-11-22\n");
    const line = list.split("\n").find((l) => l.startsWith("- q1"))!;
    expect(line).toStartWith("- q1 · user's answer · 2026-11-21 · web-page-a1 · ");
    expect(line).not.toContain("ghp_");
    expect(line).not.toContain("\u001b");
    expect([...listedIds(list).keys()]).toEqual(["q1"]);
  });
});

test("a plain fact is no correction until it is learned again as one; a replacement of a correction stays one", () => {
  const fact = lesson("web", "Api uses pnpm.", NOW - 3 * DAY, false);
  lesson("web", "Web deploys from the release branch.", NOW - 3 * DAY, false);
  expect(correctionsOf(db, "web", NOW - CORRECTIONS_WINDOW_MS, NOW)).toEqual([]);
  expect(correctionsPass(db, listProjects(db), NOW)!.filed).toEqual([]);
  lesson("web", "Api uses pnpm.", NOW - DAY, true);
  expect(correctionsOf(db, "web", NOW - CORRECTIONS_WINDOW_MS, NOW).map((r) => r.id)).toEqual([`l${fact}`]);
  lesson("web", "Api uses pnpm.", NOW - DAY / 2, false);
  expect(getLesson(db, fact)!.correction).toBe(1);
});

test("lessons the user unlearned or replaced are not corrections; ones set aside by the cap or expiry still are", () => {
  const unlearned = lesson("web", "User: wrong lesson.", NOW - 3 * DAY);
  const replaced = lesson("web", "User: first wording.", NOW - 3 * DAY);
  const replacement = learn(db, { scope: "default", project: "web", text: "User: better wording.", until: null, replaces: getLesson(db, replaced), correction: false, max: 25, now: NOW - 2 * DAY, source: "cli" }).lesson.id;
  const capped = lesson("web", "User: capped.", NOW - 3 * DAY);
  tx(db, () => {
    unlearn(db, getLesson(db, unlearned)!, NOW - DAY, "cli");
    db.query("UPDATE learnings SET archived_at = ?2, archive_reason = 'cap' WHERE id = ?1").run(capped, NOW - DAY);
  });
  expect(correctionsOf(db, "web", NOW - CORRECTIONS_WINDOW_MS, NOW).map((r) => r.id).toSorted()).toEqual([`l${capped}`, `l${replacement}`].toSorted());
});

describe("the weekly pass", () => {
  test("files one approved scout per project with two corrections or more, its list the plan's shared brief; one event; not again within a week", () => {
    seedWeek();
    const pass = correctionsPass(db, listProjects(db), NOW)!;
    expect(pass.filed.map((f) => [f.project, f.corrections])).toEqual([
      ["api", 2],
      ["web", 6],
    ]);
    const web = pass.filed.find((f) => f.project === "web")!;
    const plan = db.query("SELECT * FROM plans WHERE id = ?1").get(web.plan) as { state: string; filed_by: string; preamble: string };
    expect(plan).toMatchObject({ state: "approved", filed_by: CORRECTIONS_FILER });
    expect([...listedIds(plan.preamble).keys()].toSorted()).toEqual(["g10", "g10.1", "l1", "l2", "m1", "q1"]);
    expect(db.query("SELECT kind, workflow, auto FROM task_policy WHERE task_id = ?1").get(web.task)).toEqual({ kind: "scout", workflow: "corrections", auto: 1 });
    const add = pendingIntents(db).find((i) => i.task_id === web.task)!;
    expect(intentArgs(add).flags).toMatchObject({ kind: "scout", repo: "web" });
    const events = db.query("SELECT payload FROM events WHERE kind = ?1").all(CORRECTIONS_PASS_KIND) as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ since: NOW - CORRECTIONS_WINDOW_MS, until: NOW, skipped: [] });
    expect(correctionsPass(db, listProjects(db), NOW + 6 * DAY)).toBeNull();
  });

  test("a week later: a project whose last scout has not reported is skipped, with the reason; one correction is too few; removed projects and quiet ones are passed over", () => {
    seedWeek();
    const first = correctionsPass(db, listProjects(db), NOW)!;
    const later = NOW + CORRECTIONS_WINDOW_MS;
    const run = seedTask("web-later-c3");
    tx(db, () => {
      createSteer(db, run, "Again: no section titles.", later - DAY, null, false, false, "human");
      createSteer(db, run, "And no fold.", later - DAY, null, false, false, "leader");
      seedTask("api-later-d4", "api");
      answer("q9", "api-later-d4", "captain", later - DAY);
      db.query("UPDATE projects SET removed_at = ?1 WHERE id = 'api'").run(later - DAY);
    });
    const pass = correctionsPass(db, listProjects(db, { removed: true }), later)!;
    const webTask = first.filed.find((f) => f.project === "web")!.task;
    expect(pass.filed).toEqual([]);
    expect(pass.skipped).toEqual([{ project: "web", why: `${webTask}, the last corrections scout, has not reported` }]);
    // Once it has reported (its run landed, before cleanup), the next week's scout is filed.
    tx(db, () => {
      db.query("UPDATE projects SET removed_at = NULL WHERE id = 'api'").run();
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r-scout', ?1, 'claude', '2.1.281', 'landed', 'gone', 'corrections', 'investigate', '/tmp/s', 'fm/s', 'abc', 'h', ?2, ?2)`,
      ).run(webTask, later);
    });
    const third = later + CORRECTIONS_WINDOW_MS;
    tx(db, () => {
      createSteer(db, run, "Titles again.", third - 2 * DAY, null, false, false, "leader");
      createSteer(db, run, "Titles once more.", third - DAY, null, false, false, "leader");
    });
    expect(correctionsPass(db, listProjects(db), third - DAY)).toBeNull();
    const filed = correctionsPass(db, listProjects(db), third)!;
    expect(filed.filed.map((f) => [f.project, f.corrections])).toEqual([["web", 2]]);
    expect(filed.skipped).toEqual([]);
    // One correction in a week is too few for a class.
    tx(db, () => answer("q10", "api-later-d4", "captain", third + DAY));
    const one = correctionsPass(db, listProjects(db), third + CORRECTIONS_WINDOW_MS)!;
    expect(one.skipped).toEqual([{ project: "api", why: "1 correction, fewer than 2" }]);
  });
});

describe("a repeated class files its scout at once (docs/notes/2026-11-27-phase-corrections-become-jx.md)", () => {
  /** The first weekly pass ran at NOW with nothing to file, so the next is a week away. */
  function quietWeek(): void {
    expect(correctionsPass(db, listProjects(db), NOW)!.filed).toEqual([]);
  }

  test("two matching corrections in different tasks file the scout within one pass, not after 7 days", () => {
    quietWeek();
    const a = seedTask("web-a-1");
    const b = seedTask("web-b-2");
    tx(db, () => {
      createSteer(db, a, "Drop the section titles on the briefing page.", NOW + DAY, null, false, false, "leader");
      createSteer(db, b, "The briefing page has section titles again: drop them.", NOW + 2 * DAY, null, false, false, "human");
    });
    const at = NOW + 2 * DAY + 1;
    expect(correctionsPass(db, listProjects(db), at)).toBeNull();
    const pass = classPass(db, listProjects(db), at);
    expect(pass.filed.map((f) => [f.project, f.corrections, f.repeat])).toEqual([["web", 2, ["m1", "m2"]]]);
    const plan = db.query("SELECT filed_by, preamble FROM plans WHERE id = ?1").get(pass.filed[0]!.plan) as { filed_by: string; preamble: string };
    expect(plan.filed_by).toBe(CORRECTIONS_FILER);
    expect([...listedIds(plan.preamble).keys()]).toEqual(["m1", "m2"]);
    expect((db.query("SELECT body FROM plan_phases WHERE task_id = ?1").get(pass.filed[0]!.task) as { body: string }).body).toContain("Filed early: m1 and m2 look like one class");
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(CORRECTIONS_CLASS_KIND)).toEqual({ n: 1 });
    // The scout is open: no second one for the same words.
    expect(classPass(db, listProjects(db), at + 1).filed).toEqual([]);
  });

  test("not a class: one task's corrections (an answer and the steer that relays it), or words that do not overlap; nothing is recorded", () => {
    quietWeek();
    const a = seedTask("web-a-1");
    const b = seedTask("web-b-2");
    tx(db, () => {
      answer("q1", "web-a-1", "captain", NOW + DAY, "Drop the section titles on the briefing page?");
      createSteer(db, a, "The user says: drop the section titles on the briefing page.", NOW + DAY, null, false, false, "leader");
      createSteer(db, b, "Merge main before you deliver.", NOW + DAY, null, false, false, "leader");
    });
    expect(classPass(db, listProjects(db), NOW + 2 * DAY).filed).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(CORRECTIONS_CLASS_KIND)).toEqual({ n: 0 });
  });

  test("a lesson learned again is a class by itself: its scout files a check citing it alone", () => {
    quietWeek();
    const id = lesson("web", "User: labels are one word.", NOW - 20 * DAY);
    lesson("web", "User: labels are one word.", NOW + DAY);
    const filed = classPass(db, listProjects(db), NOW + 2 * DAY).filed;
    expect(filed.map((f) => f.repeat)).toEqual([[`l${id}`]]);
    const report = REPORT(`### Labels are one word\nEvidence: l${id}\nLaw: | Labels are one word | test/ui/labels.test.ts | fails at 1a2b3c4 |\nA test over every label.`);
    const checks = tx(db, () => fileChecks(db, { project: getProject(db, "web")!, scoutTask: filed[0]!.task, runId: "r-scout", plan: correctionsPlanOf(db, filed[0]!.task)!, report, skillPath: null, now: NOW + 3 * DAY }))!;
    expect(checks.refused).toEqual([]);
    expect(checks.ships).toHaveLength(1);
  });

  test("a weekly pass counts a lesson learned again as two corrections", () => {
    lesson("web", "User: labels are one word.", NOW - 20 * DAY);
    lesson("web", "User: labels are one word.", NOW - DAY);
    expect(correctionsPass(db, listProjects(db), NOW)!.filed.map((f) => [f.project, f.corrections])).toEqual([["web", 1]]);
  });

  test("a class split by a scout's filing is still seen: a new correction brings the older one it repeats into the next list", () => {
    quietWeek();
    const [a, b, c, d] = ["web-a-1", "web-b-2", "web-c-3", "web-d-4"].map((t) => seedTask(t));
    tx(db, () => {
      createSteer(db, a!, "Merge origin main before you deliver the branch.", NOW + DAY, null, false, false, "leader");
      createSteer(db, b!, "Drop the section titles on the briefing page.", NOW + 2 * DAY, null, false, false, "leader");
      createSteer(db, c!, "The briefing page has section titles again: drop them.", NOW + 2 * DAY, null, false, false, "leader");
    });
    const first = classPass(db, listProjects(db), NOW + 2 * DAY + 1).filed[0]!;
    expect(first.repeat).toEqual(["m2", "m3"]);
    tx(db, () => {
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r-scout', ?1, 'claude', '2.1.281', 'landed', 'gone', 'corrections', 'investigate', '/tmp/s', 'fm/s', 'abc', 'h', ?2, ?2)`,
      ).run(first.task, NOW + 2 * DAY + 1);
      createSteer(db, d!, "Again you did not merge origin main before you delivered the branch.", NOW + 3 * DAY, null, false, false, "human");
    });
    const second = classPass(db, listProjects(db), NOW + 3 * DAY + 1).filed;
    expect(second.map((f) => f.repeat)).toEqual([["m1", "m4"]]);
    expect([...listedIds(correctionsPlanOf(db, second[0]!.task)!.preamble).keys()]).toEqual(["m1", "m4"]);
  });

  test("an older correction a new one repeats joins the list even when a lesson learned again files the scout", () => {
    quietWeek();
    const [a, b, c, d] = ["web-a-1", "web-b-2", "web-c-3", "web-d-4"].map((t) => seedTask(t));
    tx(db, () => {
      createSteer(db, a!, "Merge origin main before you deliver the branch.", NOW + DAY, null, false, false, "leader");
      createSteer(db, b!, "Drop the section titles on the briefing page.", NOW + 2 * DAY, null, false, false, "leader");
      createSteer(db, c!, "The briefing page has section titles again: drop them.", NOW + 2 * DAY, null, false, false, "leader");
    });
    const first = classPass(db, listProjects(db), NOW + 2 * DAY + 1).filed[0]!;
    const id = lesson("web", "User: labels are one word.", NOW - 20 * DAY);
    tx(db, () => {
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r-scout', ?1, 'claude', '2.1.281', 'landed', 'gone', 'corrections', 'investigate', '/tmp/s', 'fm/s', 'abc', 'h', ?2, ?2)`,
      ).run(first.task, NOW + 2 * DAY + 1);
      createSteer(db, d!, "Again you did not merge origin main before you delivered the branch.", NOW + 3 * DAY, null, false, false, "human");
    });
    lesson("web", "User: labels are one word.", NOW + 3 * DAY);
    const second = classPass(db, listProjects(db), NOW + 3 * DAY + 1).filed;
    expect(second.map((f) => f.repeat)).toEqual([[`l${id}`]]);
    expect([...listedIds(correctionsPlanOf(db, second[0]!.task)!.preamble).keys()].toSorted()).toEqual(["m1", "m4", `l${id}`].toSorted());
  });

  test("a scout's list starts where the project's last scout's ended: corrections it already had are not sent again", () => {
    quietWeek();
    const a = seedTask("web-a-1");
    const b = seedTask("web-b-2");
    tx(db, () => {
      createSteer(db, a, "Drop the section titles on the briefing page.", NOW + DAY, null, false, false, "leader");
      createSteer(db, b, "The briefing page has section titles again: drop them.", NOW + DAY, null, false, false, "leader");
    });
    const first = classPass(db, listProjects(db), NOW + 2 * DAY).filed[0]!;
    tx(db, () =>
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r-scout', ?1, 'claude', '2.1.281', 'landed', 'gone', 'corrections', 'investigate', '/tmp/s', 'fm/s', 'abc', 'h', ?2, ?2)`,
      ).run(first.task, NOW + 2 * DAY),
    );
    expect(classPass(db, listProjects(db), NOW + 3 * DAY).filed).toEqual([]);
    tx(db, () => createSteer(db, a, "One more thing: merge main first.", NOW + 4 * DAY, null, false, false, "leader"));
    const weekly = correctionsPass(db, listProjects(db), NOW + CORRECTIONS_WINDOW_MS)!;
    expect(weekly.skipped).toEqual([{ project: "web", why: "1 correction, fewer than 2" }]);
  });

  test("content words: lower case, no stopwords, ids or short words, a plural's s cut", () => {
    expect([...contentWords("Drop the Section titles on q12's page, don't again (m4).")]).toEqual(["drop", "section", "title", "page"]);
    expect(repeatedClass([], 0)).toBeNull();
  });
});

describe("the learnings sweep: each project's lessons sorted once into law, fact or stale", () => {
  function sweep(): { project: ProjectRow; task: string; preamble: string } {
    seedWeek();
    const pass = correctionsPass(db, listProjects(db), NOW)!;
    expect(pass.swept.map((s) => [s.project, s.lessons])).toEqual([["web", 4]]);
    const task = pass.swept[0]!.task;
    const plan = correctionsPlanOf(db, task)!;
    expect(plan.sweep).toBe(true);
    return { project: getProject(db, "web")!, task, preamble: plan.preamble };
  }

  test("the weekly pass files one sweep per project with lessons, of its lessons in use, approved and a scout; never a second", () => {
    const { task, preamble } = sweep();
    expect(db.query("SELECT pl.filed_by, pl.state FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1").get(task)).toEqual({ filed_by: SWEEP_FILER, state: "approved" });
    expect(db.query("SELECT kind, workflow FROM task_policy WHERE task_id = ?1").get(task)).toEqual({ kind: "scout", workflow: "corrections" });
    expect([...listedIds(preamble).keys()]).toEqual(["l1", "l2", "l3", "l5"]);
    expect(preamble).toContain("- l5 · lesson · ");
    expect(preamble).toContain("- l1 · correction · ");
    lesson("web", "A new lesson after the sweep.", NOW + DAY);
    const next = correctionsPass(db, listProjects(db), NOW + CORRECTIONS_WINDOW_MS)!;
    expect(next.swept).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM plans WHERE filed_by = ?1").get(SWEEP_FILER)).toEqual({ n: 1 });
  });

  test("its report puts each listed lesson in one bucket, recorded once: law (a filed ship cites it, one is enough), stale, or fact", () => {
    const { project, task, preamble } = sweep();
    const report = [
      "## Short answer",
      "One law, one stale.",
      "",
      `## ${CHECKS_HEADING}`,
      "### Context is never repeated",
      "Evidence: l1",
      "Law: | Context is never repeated | test/ui/context.test.ts | fails at 1a2b3c4 |",
      "A test that the briefing never repeats Context.",
      "",
      `## ${STALE_HEADING}`,
      "- l3: the code it names is gone",
      "- l1: cited by a law, so not stale",
      "- l999: not in the list",
      "- l3: twice",
    ].join("\n");
    const filed = tx(db, () => fileChecks(db, { project, scoutTask: task, runId: "r-sweep", plan: { preamble, sweep: true }, report, skillPath: null, now: NOW + DAY }))!;
    expect(filed.ships).toHaveLength(1);
    expect(filed.swept).toEqual({ law: ["l1"], stale: [{ id: "l3", why: "the code it names is gone" }], fact: ["l2", "l5"] });
    const ship = db.query("SELECT body FROM plan_phases WHERE task_id = ?1").get(filed.ships[0]!) as { body: string };
    expect(ship.body).toContain(`Filed by the learnings sweep ${task}`);
    const events = db.query("SELECT payload FROM events WHERE kind = ?1").all(LEARNINGS_SWEPT_KIND) as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ project: "web", plan: filed.plan, law: ["l1"], fact: ["l2", "l5"] });
    expect(filedNote(filed)).toBe(`; 1 check filed as ships (${filed.plan}); 1 stale lesson proposed for flowryn unlearn: l3`);
  });

  test("a sweep report with no law still sorts every lesson; a corrections scout's entry citing one correction is still refused", () => {
    const { project, task, preamble } = sweep();
    const filed = tx(db, () => fileChecks(db, { project, scoutTask: task, runId: "r-sweep", plan: { preamble, sweep: true }, report: "## Short answer\nAll facts.\n", skillPath: null, now: NOW + DAY }))!;
    expect(filed).toEqual({ plan: null, ships: [], refused: [], swept: { law: [], stale: [], fact: ["l1", "l2", "l3", "l5"] } });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(CORRECTIONS_SHIPS_KIND)).toEqual({ n: 0 });
    expect(parseStale("## Stale lessons\n- `l7` — gone\n* l8 old\nnot a line\n")).toEqual([
      { id: "l7", why: "gone" },
      { id: "l8", why: "old" },
    ]);
  });
});

const REPORT = (checks: string) => `# Corrections in web\n\n## Short answer\nTwo classes.\n\n## Checks to ship\n\n${checks}\n\n## Classes not filed\nNone.\n`;

/** A week's corrections, the pass, and web's scout with its list. */
function scoutPlan(): { project: ProjectRow; task: string; preamble: string } {
  seedWeek();
  const pass = correctionsPass(db, listProjects(db), NOW)!;
  const task = pass.filed.find((f) => f.project === "web")!.task;
  return { project: getProject(db, "web")!, task, preamble: correctionsPlanOf(db, task)!.preamble };
}

describe("the scout's checks become ships", () => {
  test("a report written the way the correct skill tells the scout to, its headings and entry template filled in, files a ship", () => {
    const { project, task, preamble } = scoutPlan();
    const skill = STAGE_SKILLS.find((s) => s.name === CORRECT_SKILL_NAME)!;
    const headings = [...skill.body.matchAll(/`## ([^`]+)`/g)].map((m) => m[1]!);
    const template = skill.body.split("\n").filter((l) => l.startsWith("    ")).map((l) => l.slice(4));
    const fill: Record<string, string> = {
      "### ": "### Labels are single words",
      "Evidence: ": "Evidence: g10.1, l1",
      "Enforcer: ": "Enforcer: test",
      "Past mistake: ": "Past mistake: 1a2b3c4",
      "Law: ": "Law: | Labels are single words | test/ui/labels.test.ts | fails at 1a2b3c4, passes at HEAD |",
    };
    const entry = template.map((l) => Object.entries(fill).find(([prefix]) => l.startsWith(prefix))?.[1] ?? "A test over every label in ui/.");
    const report = headings.map((heading, i) => `## ${heading}\n${i === 1 ? entry.join("\n") : "None."}`).join("\n\n");
    const filed = tx(db, () => fileChecks(db, { project, scoutTask: task, runId: "r-scout", plan: { preamble, sweep: false }, report, skillPath: null, now: NOW + DAY }))!;
    expect(filed.refused).toEqual([]);
    expect(filed.ships).toHaveLength(1);
    expect(db.query("SELECT title FROM plan_phases WHERE plan_id = ?1").get(filed.plan!)).toEqual({ title: "Labels are single words" });
  });

  test("each entry citing two listed ids is one independent approved ship, its brief the scout's list; the rest are refused with the reason", () => {
    const { project, task, preamble } = scoutPlan();
    const report = REPORT(
      [
        "### Labels are single words",
        "Evidence: g10.1, l1",
        "Enforcer: test",
        "Past mistake: 1a2b3c4",
        "Law: | Labels are single words | test/ui/labels.test.ts | fails at 1a2b3c4, passes at HEAD |",
        "A test over every label in ui/.",
        "",
        "### No section titles split a table",
        "Evidence: m1 l2 l2",
        "Enforcer: lint",
        "Law: | One table, no section titles | `.oxlintrc.json` `no-split-table` | fails at 5e6f7a8 |",
        "A lint rule.",
        "",
        "### A one-off",
        "Evidence: q1",
        "Words.",
        "",
        "### Made-up evidence",
        "Evidence: q1, q999",
        "Words.",
        "",
        "### No words",
        "Evidence: q1, m1",
        "",
        "### No law row",
        "Evidence: q1, m1",
        "Words.",
        "",
        "### A law row naming no commit",
        "Evidence: q1, m1",
        "Law: | Rule | test/a.test.ts | - |",
        "Words.",
        "",
        "### A law row naming no enforcer",
        "Evidence: q1, m1",
        "Law: | Rule | people remember it | fails at 1a2b3c4 |",
        "Words.",
      ].join("\n"),
    );
    const filed = tx(db, () => fileChecks(db, { project, scoutTask: task, runId: "r-scout", plan: { preamble, sweep: false }, report, skillPath: skillPath(h.stateDir, CORRECT_SKILL_NAME), now: NOW + DAY }))!;
    expect(filed.ships).toHaveLength(2);
    expect(filed.refused).toEqual([
      { title: "A one-off", why: "cites 1 correction; a class needs 2" },
      { title: "Made-up evidence", why: "cites ids not in its list: q999" },
      { title: "No words", why: "no words under the title" },
      { title: "No law row", why: "no Law: line (| rule | enforced by | proven on |)" },
      { title: "A law row naming no commit", why: "its Law: row's Proven on names no commit the check fails at" },
      { title: "A law row naming no enforcer", why: "its Law: row's Enforced by names nothing verify can run or confirm" },
    ]);
    const plan = db.query("SELECT state, filed_by, preamble FROM plans WHERE id = ?1").get(filed.plan) as { state: string; filed_by: string; preamble: string };
    expect(plan).toEqual({ state: "approved", filed_by: `corrections scout (${task})`, preamble });
    const phases = db.query("SELECT title, body, workflow, blocked_by FROM plan_phases WHERE plan_id = ?1 ORDER BY phase_no").all(filed.plan!) as { title: string; body: string; workflow: string; blocked_by: string }[];
    expect(phases.map((p) => [p.title, p.workflow, p.blocked_by])).toEqual([
      ["Labels are single words", "fix", "[]"],
      ["No section titles split a table", "fix", "[]"],
    ]);
    expect(phases[0]!.body).toContain("A test over every label in ui/.");
    expect(phases[0]!.body).toContain("Law: | Labels are single words | test/ui/labels.test.ts | fails at 1a2b3c4, passes at HEAD |");
    expect(phases[0]!.body).toContain("add its Law: row to the project's AGENTS.md");
    expect(phases[0]!.body).toContain(`Filed by the weekly corrections scout ${task}`);
    expect(phases[0]!.body).toContain(skillPath(h.stateDir, CORRECT_SKILL_NAME)!);
    for (const ship of filed.ships) expect(db.query("SELECT kind, auto FROM task_policy WHERE task_id = ?1").get(ship)).toEqual({ kind: "ship", auto: 1 });
    const event = db.query("SELECT task_id, payload FROM events WHERE kind = ?1").get(CORRECTIONS_SHIPS_KIND) as { task_id: string; payload: string };
    expect(event.task_id).toBe(task);
    expect(JSON.parse(event.payload)).toMatchObject({ project: "web", plan: filed.plan, ships: filed.ships });
  });

  test(`at most ${CORRECTIONS_MAX_SHIPS} ships from one report; no checks section files nothing and records nothing; only a corrections scout has a plan to file from`, () => {
    const { project, task, preamble } = scoutPlan();
    const many = Array.from({ length: CORRECTIONS_MAX_SHIPS + 1 }, (_, i) => `### Check ${i + 1}\nEvidence: q1, m1\nLaw: | Check ${i + 1} | test/c${i}.test.ts | fails at 1a2b3c4 |\nWords.`).join("\n\n");
    const filed = tx(db, () => fileChecks(db, { project, scoutTask: task, runId: "r-scout", plan: { preamble, sweep: false }, report: REPORT(many), skillPath: null, now: NOW + DAY }))!;
    expect(filed.ships).toHaveLength(CORRECTIONS_MAX_SHIPS);
    expect(filed.refused).toEqual([{ title: `Check ${CORRECTIONS_MAX_SHIPS + 1}`, why: `over ${CORRECTIONS_MAX_SHIPS} checks from one report` }]);
    expect(tx(db, () => fileChecks(db, { project, scoutTask: task, runId: "r-scout", plan: { preamble, sweep: false }, report: "# Report\n\n## Short answer\nNothing repeats.\n", skillPath: null, now: NOW + DAY }))).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(CORRECTIONS_SHIPS_KIND)).toEqual({ n: 1 });
    seedTask("web-other-e5");
    expect(correctionsPlanOf(db, "web-other-e5")).toBeNull();
  });

  test("parsing: entries end at the next ## section; the Evidence line splits on commas and spaces, once each; the Law: row splits as the laws step splits it", () => {
    const entries = parseChecks(`## Short answer\nx\n\n## checks to ship\n### A\nEvidence: q1,  m1 q1\nLaw: | No \\| in names | \`a.ts\` \`x|y\` | fails at 1a2b3c4 |\nwords\n## Classes not filed\n### B\nEvidence: q1, m1\n`);
    expect(entries).toEqual([
      { title: "A", evidence: ["q1", "m1"], law: ["No | in names", "`a.ts` `x|y`", "fails at 1a2b3c4"], body: "Evidence: q1,  m1 q1\nLaw: | No \\| in names | `a.ts` `x|y` | fails at 1a2b3c4 |\nwords" },
    ]);
    expect(parseChecks("## Checks to ship\n### A\nLaw: not a row\nwords")[0]!.law).toBeNull();
  });
});

describe("plan phases of a scout workflow are scouts", () => {
  test("a built-in workflow ending in no merge gate is a scout's; any other, or none, a ship's", () => {
    expect(phaseKind("corrections")).toBe("scout");
    expect(phaseKind("scout")).toBe("scout");
    for (const id of ["fix", "feature", "feature-ui", "draft", "mine", null]) expect(phaseKind(id)).toBe("ship");
  });

  test("the correct skill is one of the worker skills, within the stage skills' budget", () => {
    const skill = STAGE_SKILLS.find((s) => s.name === CORRECT_SKILL_NAME)!;
    expect(skill.body.length).toBeLessThan(6000);
    expect(skill.description.length).toBeLessThan(260);
  });

  test("a person's steer carries who sent it; Flowryn's own does not", () => {
    const run = seedTask("web-page-a1");
    tx(db, () => {
      createSteer(db, run, "mine", NOW, null, false, false, "leader");
      createSteer(db, run, "flowryn's", NOW);
    });
    const payloads = (db.query("SELECT payload FROM events WHERE kind = 'steer.created' ORDER BY seq").all() as { payload: string }[]).map((e) => JSON.parse(e.payload));
    expect(payloads[0]).toMatchObject({ by: "leader" });
    expect(payloads[1].by).toBeUndefined();
  });
});
