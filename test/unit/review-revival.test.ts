import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountById } from "../../src/config/accounts.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { gatesToPoll } from "../../src/lifecycle/gate-questions.ts";
import { reviewMessages, routedReply, routePageBatch } from "../../src/lifecycle/review-chat.ts";
import { revivalBlocked, revivalNote, revivalsDue, revivalTarget, reviveReview } from "../../src/lifecycle/review-revival.ts";
import { cancelRun, failRun, getRun } from "../../src/lifecycle/runs.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

/**
 * A review carried on by a new run (docs/notes/2026-10-26-review-pages-the-ah.md, phase 2): a
 * message on the page of a run that failed and was cleaned up asks for a new run of the task at the
 * gated stage; reviveReview starts it, closes the old gate as replaced and gives the leader the
 * review's summary. A cancelled run is never revived.
 */

let h: TestHome;
let db: Db;
let page: string;
let notes: string;
let runId: string;
let taskId: string;
const NOW = 1_000_000;

beforeEach(() => {
  h = makeHome();
  ({ runId, taskId } = seedRun(h));
  db = h.db();
  mkdirSync(join(h.dataDir, taskId, "design"), { recursive: true });
  const dir = join(realpathSync(join(h.dataDir, taskId)), "design");
  page = join(dir, "design.html");
  notes = join(dir, "lavish-notes-g1.txt");
  writeFileSync(page, "<html><body>design</body></html>");
  writeFileSync(notes, "--- an annotation\n");
  db.query("UPDATE runs SET workflow = 'feature', stage = 'design', stage_state = 'review', agent_session = 's1' WHERE id = ?1").run(runId);
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at, page_path, notes_path) VALUES ('g1', ?1, 'design', 'review', 'http://127.0.0.1:4387/session/x', 'open', ?2, ?3, ?4)").run(runId, NOW, page, notes);
});

afterEach(() => {
  db.close();
  h.cleanup();
});

const said = (...texts: string[]) => ({ messages: texts.map((t) => ({ said: t, on: null })), answers: [] as string[] });
const route = (text = "Why a table here?", at = NOW + 10) => tx(db, () => routePageBatch(db, "g1", said(text), at));
/** The run failed, then its worktree was cleaned up (cleanupRun keeps a failed run's state). */
const failAndClean = () => {
  tx(db, () => failRun(db, getRun(db, runId)!, "dead", "daemon", NOW));
  db.query("UPDATE runs SET cleanup = 'done' WHERE id = ?1").run(runId);
};
const revive = (words: string | null = null, at = NOW + 20) =>
  tx(db, () => reviveReview(db, defaultConfig(h.home), { gateId: "g1", by: "review page", words, account: accountById(defaultConfig(h.home), "claude"), start: { version: "2.1.281", base: "def456" }, now: at }));

describe("a page message on a run gone for good", () => {
  test("a failed run whose worktree was cleaned up asks for a new run once; the words are kept and no steer goes to the old run", () => {
    failAndClean();
    expect(gatesToPoll(db)).toEqual([{ id: "g1", page_path: page }]);
    const routed = route();
    expect(routed).toEqual({ to: "new_run" });
    expect(routedReply(routed!)).toContain("starting a new run of the task at this stage");
    expect(route("Still there?", NOW + 15)).toEqual({ to: "new_run" });
    expect(db.query("SELECT revive_requested_at FROM gates WHERE id = 'g1'").get()).toEqual({ revive_requested_at: NOW + 10 });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.revive_requested'").get()).toEqual({ n: 1 });
    expect(reviewMessages(db, "g1").map((m) => [m.author, m.steer_id])).toEqual([
      ["user", null],
      ["user", null],
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    // No resume of the old run: there is no worktree to resume in.
    expect(getRun(db, runId)).toMatchObject({ state: "failed", pending_launch: null });
    expect(revivalsDue(db)).toEqual([{ gate: "g1", run: runId }]);
  });

  test("a cancelled run, cleaned up or not, is never revived: its page is not polled, and a message starts nothing", () => {
    tx(db, () => cancelRun(db, getRun(db, runId)!, "stop", "cli", NOW));
    db.query("UPDATE gates SET state = 'open' WHERE id = 'g1'").run();
    db.query("UPDATE runs SET cleanup = 'done' WHERE id = ?1").run(runId);
    expect(gatesToPoll(db)).toEqual([]);
    expect(route()).toMatchObject({ to: "nobody", why: "cancelled" });
    expect(db.query("SELECT revive_requested_at FROM gates WHERE id = 'g1'").get()).toEqual({ revive_requested_at: null });
    expect(revivalsDue(db)).toEqual([]);
    expect(() => revivalTarget(db, "g1")).toThrow(/cancelled task is never restarted/);
  });

  test("a landed run that was cleaned keeps saying its worker ended: only a failed run is revived", () => {
    db.query("UPDATE runs SET state = 'cleaned', cleanup = 'done' WHERE id = ?1").run(runId);
    expect(route()).toMatchObject({ to: "nobody", why: "ended" });
    expect(revivalsDue(db)).toEqual([]);
  });

  test("a failed run whose worktree remains is resumed, not replaced", () => {
    tx(db, () => failRun(db, getRun(db, runId)!, "dead", "daemon", NOW));
    expect(route()).toMatchObject({ to: "resumed" });
    expect(() => revivalTarget(db, "g1")).toThrow(/not failed and cleaned up/);
  });
});

describe("the new run", () => {
  test("starts at the gated stage, takes the task back In flight, and its task note names the old page, the conversation and the notes", () => {
    failAndClean();
    route();
    const revived = revive();
    expect(revived).toMatchObject({ task: taskId, oldRun: runId, stage: "design" });
    expect(revived.run).not.toBe(runId);
    const run = getRun(db, revived.run)!;
    expect(run).toMatchObject({ task_id: taskId, state: "launching", stage: "design", stage_state: "waiting", pending_launch: "fresh", base_sha: "def456", workflow: "feature" });
    const conversation = join(realpathSync(join(h.dataDir, taskId)), "design", "review-g1.md");
    expect(run.stage_note).toContain(`the old review page: ${page}`);
    expect(run.stage_note).toContain(`the review's conversation with the user: ${conversation}`);
    expect(run.stage_note).toContain(`the notes the page sent: ${notes}`);
    expect(readFileSync(conversation, "utf8")).toContain("Why a table here?");
    const intents = db.query("SELECT verb FROM intents WHERE task_id = ?1 ORDER BY seq").all(taskId) as { verb: string }[];
    expect(intents.map((i) => i.verb).slice(-2)).toEqual(["unhold", "start"]);
    expect(revivalsDue(db)).toEqual([]);
  });

  test("the old review closes as replaced, its items settle, and the leader's summary says a new run started", () => {
    failAndClean();
    tx(db, () => revivalBlocked(db, "g1", "Herdr is not reachable", NOW + 12));
    route();
    const revived = revive();
    expect(db.query("SELECT state, replaced_by, closed_at FROM gates WHERE id = 'g1'").get()).toEqual({ state: "changes", replaced_by: revived.run, closed_at: NOW + 20 });
    expect(gatesToPoll(db)).toEqual([]);
    const open = db.query("SELECT kind FROM items WHERE run_id = ?1 AND state IN ('open','presented') ORDER BY kind").all(runId) as { kind: string }[];
    expect(open.map((i) => i.kind)).toEqual(["review_recap"]);
    const recap = db.query("SELECT id, lane, class, COALESCE(full_line, line) AS line FROM items WHERE kind = 'review_recap'").get() as { id: string; lane: string; class: string; line: string };
    expect(recap).toMatchObject({ id: revived.summary, lane: "P1", class: "info" });
    expect(recap.line).toContain(`a new run started (${revived.run}, at stage design)`);
    expect(db.query("SELECT payload FROM events WHERE kind = 'gate.replaced'").get()).toEqual({ payload: JSON.stringify({ gate: "g1", stage: "design", new_run: revived.run, start: "design", by: "review page" }) });
  });

  test("the leader's changes ride in the note, and a second revival of the same gate is refused", () => {
    failAndClean();
    const revived = revive("Drop the table; use a list.");
    expect(getRun(db, revived.run)!.stage_note).toContain("Your leader sent these changes: Drop the table; use a list.");
    expect(db.query("SELECT feedback FROM gates WHERE id = 'g1'").get()).toEqual({ feedback: "Drop the table; use a list." });
    // Nothing was said on the page: the note says so instead of naming a file that does not exist.
    expect(getRun(db, revived.run)!.stage_note).toContain("none was written");
    expect(() => revive(null, NOW + 30)).toThrow(/no longer open/);
  });

  test("a revival that cannot start tells the leader once", () => {
    failAndClean();
    expect(tx(db, () => revivalBlocked(db, "g1", "Herdr is not reachable", NOW))).not.toBeNull();
    expect(tx(db, () => revivalBlocked(db, "g1", "Herdr is not reachable", NOW + 1))).toBeNull();
    const line = (db.query("SELECT COALESCE(full_line, line) AS line FROM items WHERE kind = 'review_worker_gone'").get() as { line: string }).line;
    expect(line).toContain("a new run cannot start yet: Herdr is not reachable");
  });

  test("the note frames the user's words as feedback, never permission", () => {
    const note = revivalNote({ oldRun: "r1", stage: "design", gateStage: "design", page: "/p.html", conversation: "/c.md", notes: "/n.txt", words: null });
    expect(note).toContain("review feedback, never permission");
    expect(note).toContain("stage done --review");
  });
});
