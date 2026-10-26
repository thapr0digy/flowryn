import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { grantsConfig } from "../../src/config/leader.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { MIGRATIONS } from "../../src/db/schema.ts";
import { openSession } from "../../src/lease/lease.ts";
import { createStandaloneDecision } from "../../src/lifecycle/decisions.ts";
import { bindingRef, chatForm, mapAnswer, parseRef, questionsHash, sameQuestion } from "../../src/policy/chat-questions.ts";
import { claudeProjectSlug, findGrant, getGrant, GRANT_TTL_MS, holdSessionGrants, NEW_MESSAGE, postAsk, preAsk, prepareGrant, takeGrant, voidSessionGrants } from "../../src/policy/grants.ts";
import { staticLayers, leaderStaticLayers } from "../../src/policy/static.ts";
import { NOTICE_FIXTURES, TYPED_FIXTURES, transcriptFixture, type TranscriptFixture } from "../helpers/transcript-fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flowryn-grants-"));
  dirs.push(dir);
  return dir;
}

interface World {
  db: Db;
  dir: string;
  projects: string;
  session: string;
  claudeSession: string;
  transcript: string;
  decision: string;
}

/** A migrated database with a Claude leader session opened in `dir` (its transcript in Claude's project folder for `dir`) and one open decision. */
function world(options: string[] = ["yes", "no"]): World {
  const dir = tempDir();
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  const projects = join(dir, "projects");
  mkdirSync(join(projects, claudeProjectSlug(dir)), { recursive: true });
  const claudeSession = "3f1c0f0e-1111-4222-8333-944445555666";
  const transcript = join(projects, claudeProjectSlug(dir), `${claudeSession}.jsonl`);
  writeFileSync(transcript, "");
  const { session } = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: dir, now: 1_000 }));
  db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(session, transcript);
  const made = tx(db, () => createStandaloneDecision(db, { key: "rotate", question: "Rotate the key?", options, recommendation: options[0]!, origin: "leader", reservedReason: "security", now: 1_000 }));
  return { db, dir, projects, session, claudeSession, transcript, decision: made.id };
}

/** Claude's transcript lines for one AskUserQuestion call and your answer (the shapes recorded live, c15). */
function writeTranscript(w: World, toolUseId: string, questions: unknown[], answers: Record<string, string>, at = new Date()): void {
  appendFileSync(w.transcript, JSON.stringify({ type: "assistant", sessionId: w.claudeSession, timestamp: at.toISOString(), message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }] } }) + "\n");
  appendFileSync(
    w.transcript,
    JSON.stringify({ type: "user", sessionId: w.claudeSession, timestamp: at.toISOString(), toolUseResult: { questions, answers, annotations: {} }, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "answered" }] } }) + "\n",
  );
}

/** Ask and answer one binding question through both hooks; returns the context lines. */
function askAndAnswer(w: World, toolUseId: string, answer: string, now: number, transcript = true): string[] {
  const q = chatForm(w.db, w.decision).question;
  expect(tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId, input: { questions: [q] }, now }))).toBeNull();
  const result = { questions: [q], answers: { [q.question]: answer }, annotations: {} };
  const lines = tx(w.db, () => postAsk(w.db, { session: w.session, toolUseId, input: result, response: result, claudeSession: w.claudeSession, transcriptPath: w.transcript, now }));
  if (transcript) writeTranscript(w, toolUseId, [q], { [q.question]: answer }, new Date(now));
  return lines;
}

function grantIn(lines: string[]): string {
  return /Grant (c\d+)/.exec(lines.join("\n"))![1]!;
}

describe("binding questions", () => {
  test("only a prefix of an item id and ' · ' binds; refs parse from the command line", () => {
    expect(bindingRef("q42 · Rotate?")).toBe("q42");
    expect(bindingRef("merge web-billing-q4 · Title: PR")).toBe("merge:web-billing-q4");
    expect(bindingRef("g7 · Pass")).toBe("g7");
    expect(bindingRef("Is q42 fine?")).toBeNull();
    expect(bindingRef("q42: Rotate?")).toBeNull();
    expect(parseRef("merge:T17")).toBe("merge:T17");
    expect(parseRef("merge T17")).toBe("merge:T17");
    expect(parseRef("d3")).toBe("d3");
    expect(() => parseRef("T17")).toThrow(FlowrynError);
  });

  test("a decision's form: its options as labels, the recommendation marked; text or too many options cannot be asked", () => {
    const w = world();
    const form = chatForm(w.db, w.decision);
    expect(form.question).toMatchObject({ question: `${w.decision} · Rotate the key?`, header: w.decision, multiSelect: false });
    expect(form.choices).toEqual([
      { label: "yes (Recommended)", choice: "yes" },
      { label: "no", choice: "no" },
    ]);
    const five = world(["a", "b", "c", "d", "e"]);
    expect(() => chatForm(five.db, five.decision)).toThrow("a chat question takes 2 to 4");
    tx(w.db, () => w.db.query("UPDATE decisions SET state = 'answered' WHERE id = ?1").run(w.decision));
    expect(() => chatForm(w.db, w.decision)).toThrow("already answered");
  });

  test("the comparison and hash see only what the user sees, in order; key order and extra fields do not matter", () => {
    const a = { question: "q1 · x", header: "q1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false };
    const reordered = { multiSelect: false, options: [{ description: "a", label: "A" }, { description: "b", label: "B" }], header: "q1", question: "q1 · x", extra: 1 };
    expect(sameQuestion(a, reordered as never)).toBe(true);
    expect(questionsHash([a])).toBe(questionsHash([reordered as never]));
    expect(sameQuestion(a, { ...a, options: [a.options[1]!, a.options[0]!] })).toBe(false);
    expect(sameQuestion(a, { ...a, options: [{ label: "A", description: "harmless" }, a.options[1]!] })).toBe(false);
  });

  test("an answer maps to a choice by its label; multi-select joins labels; free text grants only a gate's changes", () => {
    const w = world(["red", "green", "blue"]);
    const form = chatForm(w.db, w.decision);
    expect(mapAnswer(form, "red (Recommended)", null)).toEqual({ kind: "grant", choice: "red", words: null });
    expect(mapAnswer(form, "red", null)).toMatchObject({ kind: "none" });
    expect(mapAnswer(form, "maybe green?", "note")).toMatchObject({ kind: "none" });
    tx(w.db, () => w.db.query("UPDATE decisions SET kind = 'multi' WHERE id = ?1").run(w.decision));
    const multi = chatForm(w.db, w.decision);
    expect(multi.question.multiSelect).toBe(true);
    expect(mapAnswer(multi, "red (Recommended), blue", null)).toEqual({ kind: "grant", choice: "red, blue", words: null });
    expect(mapAnswer(multi, "red (Recommended), purple", null)).toMatchObject({ kind: "none" });
    const gate = { ...form, action: "gate" as const, choices: [{ label: "Pass", choice: "pass" }, { label: "Changes", choice: "changes" }], freeText: "changes", question: { ...form.question, multiSelect: false } };
    expect(mapAnswer(gate, "Make it blue", "and bigger")).toEqual({ kind: "grant", choice: "changes", words: "Make it blue\nand bigger" });
    const merge = { ...gate, action: "merge" as const, choices: [{ label: "Merge", choice: "merge" }, { label: "Don't merge", choice: null }], freeText: null };
    expect(mapAnswer(merge, "Don't merge", null)).toEqual({ kind: "declined", label: "Don't merge" });
  });
});

describe("assumptions the design rests on (c15, run live by spikes/claude/c15-ask-user-question.sh)", () => {
  test("A1: PostToolUse's tool_response carries answers keyed by the question text, and that makes the grant", () => {
    const w = world();
    const lines = askAndAnswer(w, "toolu_a1", "no", 2_000);
    const g = getGrant(w.db, grantIn(lines))!;
    expect(g).toMatchObject({ item: w.decision, action: "decide", choice: "no", answer: "no", session_id: w.session, expires_at: 2_000 + GRANT_TTL_MS });
  });

  test("A2: an AskUserQuestion that brings its own answers is denied, before any dialog", () => {
    const w = world();
    const q = chatForm(w.db, w.decision).question;
    const deny = tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_a2", input: { questions: [q], answers: { [q.question]: "yes (Recommended)" } }, now: 2_000 }));
    expect(deny).toContain("may not carry its own answers");
    expect(w.db.query("SELECT 1 FROM chat_questions").all()).toEqual([]);
  });

  test("A4: the answer must be in Claude's transcript when the grant is used; without it the grant is refused", () => {
    const w = world();
    const grant = grantIn(askAndAnswer(w, "toolu_a4", "yes (Recommended)", Date.now(), false));
    const ask = { session: w.session, item: w.decision, choice: "yes", grantId: grant };
    expect(() => prepareGrant({ db: w.db, now: () => Date.now() }, ask, w.projects)).toThrow("Claude's transcript has no such question");
    const q = chatForm(w.db, w.decision).question;
    writeTranscript(w, "toolu_a4", [q], { [q.question]: "yes (Recommended)" });
    expect(prepareGrant({ db: w.db, now: () => Date.now() }, ask, w.projects)).toBe(grant);
    expect(getGrant(w.db, grant)!.verified_at).not.toBeNull();
  });

  test("A5: a grant runs through grant use, which no ask rule matches, since a hook allow does not override one", () => {
    // The leader's ask rules (src/bridges/claude/settings.ts) match decide --by captain and gate pass, never grant use.
    const rules = ["flowryn gate pass *", "flowryn cleanup * --discard*", "flowryn decide *captain*", "flowryn merge *allow-red*"].map((r) => new RegExp(`^${r.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
    expect(rules.some((r) => r.test("flowryn grant use c7"))).toBe(false);
    expect(rules.some((r) => r.test("flowryn decide q1 yes --by captain"))).toBe(true);
  });
});

describe("grant lifecycle", () => {
  test("one use; a second use, another session, another choice or item are refused", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_l1", "yes (Recommended)", now));
    expect(() => findGrant(w.db, { session: w.session, item: w.decision, choice: "no", grantId: null }, now)).toThrow(/was "yes"/);
    expect(() => findGrant(w.db, { session: w.session, item: w.decision, choice: "no", grantId: grant }, now)).toThrow(/is for/);
    expect(() => findGrant(w.db, { session: "L999", item: w.decision, choice: "yes", grantId: grant }, now)).toThrow("another leader session");
    expect(findGrant(w.db, { session: "L999", item: w.decision, choice: "yes", grantId: null }, now)).toBeNull();
    expect(prepareGrant({ db: w.db, now: () => now }, { session: w.session, item: w.decision, choice: "yes", grantId: null }, w.projects)).toBe(grant);
    tx(w.db, () => takeGrant(w.db, grant, "decide", now));
    expect(() => tx(w.db, () => takeGrant(w.db, grant, "decide", now))).toThrow("already used");
  });

  test("it expires after the window, and ends with the turn", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_l2", "no", now));
    expect(() => findGrant(w.db, { session: w.session, item: w.decision, choice: "no", grantId: grant }, now + GRANT_TTL_MS)).toThrow("expired");
    expect(findGrant(w.db, { session: w.session, item: w.decision, choice: "no", grantId: null }, now + GRANT_TTL_MS)).toBeNull();
    expect(tx(w.db, () => voidSessionGrants(w.db, w.session, "the turn ended", now))).toBe(1);
    expect(() => findGrant(w.db, { session: w.session, item: w.decision, choice: "no", grantId: grant }, now)).toThrow("voided: the turn ended");
  });

  test("a question asked once is answered once; a pre-tool for a tool use already seen is denied", () => {
    const w = world();
    const now = Date.now();
    askAndAnswer(w, "toolu_l3", "no", now);
    const q = chatForm(w.db, w.decision).question;
    const result = { questions: [q], answers: { [q.question]: "yes (Recommended)" }, annotations: {} };
    const again = tx(w.db, () => postAsk(w.db, { session: w.session, toolUseId: "toolu_l3", input: result, response: result, claudeSession: w.claudeSession, transcriptPath: w.transcript, now }));
    expect(again.join("\n")).toContain("already answered");
    expect(tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_l3", input: { questions: [q] }, now }))).toContain("already asked");
    const unseen = tx(w.db, () => postAsk(w.db, { session: w.session, toolUseId: "toolu_never", input: result, response: result, claudeSession: w.claudeSession, transcriptPath: w.transcript, now }));
    expect(unseen.join("\n")).toContain("did not see this question asked");
    expect(w.db.query("SELECT COUNT(*) AS n FROM captain_grants").get()).toEqual({ n: 1 });
  });

  test("the transcript must be the session's own, inside Claude's projects directory, with the answer given after the question was recorded", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_l4", "no", now, false));
    const q = chatForm(w.db, w.decision).question;
    // An answer from before the question was recorded (a replay of an older line) does not count.
    writeTranscript(w, "toolu_l4", [q], { [q.question]: "no" }, new Date(now - 5 * 60_000));
    const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("no such answer");
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, join(w.dir, "elsewhere"))).toThrow("not inside Claude's projects directory");
    w.db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(w.session, join(w.dir, "other.jsonl"));
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("not the one this leader session started with");
    expect(w.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'grant.refused'").get()).toEqual({ n: 3 });
  });

  test("Claude's folder for a directory replaces every character but A-Z, a-z and 0-9 with '-'", () => {
    expect(claudeProjectSlug("/Users/me/.flowryn/x")).toBe("-Users-me--flowryn-x");
    expect(claudeProjectSlug("/srv/my_repo v2")).toBe("-srv-my-repo-v2");
  });

  test("a question whose tool use in Claude's transcript carried its own answers grants nothing, even with the hooks fooled", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_pf", "yes (Recommended)", now, false));
    const q = chatForm(w.db, w.decision).question;
    const answers = { [q.question]: "yes (Recommended)" };
    appendFileSync(w.transcript, JSON.stringify({ type: "assistant", sessionId: w.claudeSession, timestamp: new Date(now).toISOString(), message: { content: [{ type: "tool_use", id: "toolu_pf", name: "AskUserQuestion", input: { questions: [q], answers } }] } }) + "\n");
    appendFileSync(w.transcript, JSON.stringify({ type: "user", sessionId: w.claudeSession, timestamp: new Date(now).toISOString(), toolUseResult: { questions: [q], answers, annotations: {} }, message: { content: [{ type: "tool_result", tool_use_id: "toolu_pf", content: "answered" }] } }) + "\n");
    expect(() => prepareGrant({ db: w.db, now: () => now }, { session: w.session, item: w.decision, choice: "yes", grantId: grant }, w.projects)).toThrow("the question carried its own answers");
    expect(getGrant(w.db, grant)!.verified_at).toBeNull();
  });

  test("the transcript must sit in Claude's project folder for the directory the session was opened in", () => {
    const w = world();
    const now = Date.now();
    const other = join(w.projects, claudeProjectSlug(join(w.dir, "elsewhere")));
    mkdirSync(other, { recursive: true });
    w.transcript = join(other, `${w.claudeSession}.jsonl`);
    writeFileSync(w.transcript, "");
    w.db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(w.session, w.transcript);
    const grant = grantIn(askAndAnswer(w, "toolu_cwd", "no", now));
    const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("not in Claude's project folder for the leader's directory");
    w.db.query("UPDATE leader_sessions SET cwd = NULL WHERE session_id = ?1").run(w.session);
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("has no working directory");
    w.db.query("UPDATE leader_sessions SET cwd = ?2 WHERE session_id = ?1").run(w.session, join(w.dir, "elsewhere"));
    expect(prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toBe(grant);
  });

  test("a later answer to the same item replaces the earlier grant", () => {
    const w = world();
    const now = Date.now();
    const first = grantIn(askAndAnswer(w, "toolu_r1", "yes (Recommended)", now));
    const second = grantIn(askAndAnswer(w, "toolu_r2", "no", now + 1));
    expect(getGrant(w.db, first)!.void_reason).toBe("a later answer replaced it");
    expect(() => findGrant(w.db, { session: w.session, item: w.decision, choice: "yes", grantId: first }, now + 1)).toThrow("voided: a later answer replaced it");
    expect(() => findGrant(w.db, { session: w.session, item: w.decision, choice: "yes", grantId: null }, now + 1)).toThrow(/was "no"/);
    expect(findGrant(w.db, { session: w.session, item: w.decision, choice: "no", grantId: null }, now + 1)!.id).toBe(second);
  });

  test("a merge grant binds to the head it showed", () => {
    const w = world();
    const now = Date.now();
    tx(w.db, () => {
      w.db.query("INSERT INTO captain_grants (id, session_id, tool_use_id, item, action, task_id, choice, question, answer, binds, transcript_path, created_at, expires_at, verified_at) VALUES ('c9', ?1, 't', 'merge:T1', 'merge', 'T1', 'merge', 'merge T1 · x', 'Merge', 'aaaaaaaa1111', ?2, ?3, ?4, ?3)").run(w.session, w.transcript, now, now + GRANT_TTL_MS);
    });
    expect(() => prepareGrant({ db: w.db, now: () => now }, { session: w.session, item: "merge:T1", choice: "merge", grantId: null, head: "bbbbbbbb2222" }, w.projects)).toThrow("was for head aaaaaaaa; the head is now bbbbbbbb");
    expect(prepareGrant({ db: w.db, now: () => now }, { session: w.session, item: "merge:T1", choice: "merge", grantId: null, head: "aaaaaaaa1111" }, w.projects)).toBe("c9");
  });
});

/** A transcript fixture's line in this world's transcript, as Claude writes it after the answer. */
function writeEntry(w: World, name: TranscriptFixture): void {
  appendFileSync(w.transcript, JSON.stringify({ ...transcriptFixture(name), sessionId: w.claudeSession }) + "\n");
}

describe("background notices hold a grant (docs/notes/2026-10-17-chat-answers-survive-es.md)", () => {
  for (const name of NOTICE_FIXTURES) {
    test(`${name} after the answer: the held grant is used`, () => {
      const w = world();
      const now = Date.now();
      const grant = grantIn(askAndAnswer(w, `toolu_n_${name.replaceAll("-", "_")}`, "no", now));
      expect(tx(w.db, () => holdSessionGrants(w.db, w.session, now))).toBe(1);
      writeEntry(w, name);
      expect(prepareGrant({ db: w.db, now: () => now }, { session: w.session, item: w.decision, choice: "no", grantId: grant }, w.projects)).toBe(grant);
      expect(getGrant(w.db, grant)).toMatchObject({ held_prompts: 1, voided_at: null });
    });
  }

  for (const name of TYPED_FIXTURES) {
    test(`${name} after the answer: the grant is voided at use, even when the hook took it for a notice`, () => {
      const w = world();
      const now = Date.now();
      const grant = grantIn(askAndAnswer(w, `toolu_t_${name.replaceAll("-", "_")}`, "no", now));
      tx(w.db, () => holdSessionGrants(w.db, w.session, now));
      writeEntry(w, "monitor-event");
      writeEntry(w, name);
      const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
      expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow(`grant ${grant} was voided: ${NEW_MESSAGE}`);
      expect(getGrant(w.db, grant)).toMatchObject({ void_reason: NEW_MESSAGE });
      expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("was voided");
    });
  }

  test("assumption: Claude writes an absorbed notice after the answer's line; one written before it does not count", () => {
    const w = world();
    const now = Date.now();
    writeEntry(w, "monitor-event");
    const grant = grantIn(askAndAnswer(w, "toolu_order", "no", now));
    tx(w.db, () => holdSessionGrants(w.db, w.session, now));
    const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("does not yet show 1 of the 1");
    // Refused, not voided: once Claude writes the line, a retry passes.
    writeEntry(w, "monitor-event");
    expect(prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toBe(grant);
  });

  test("assumption: each notice fires the prompt hook at most once; more holds than notices refuses", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_twice", "no", now));
    tx(w.db, () => holdSessionGrants(w.db, w.session, now));
    tx(w.db, () => holdSessionGrants(w.db, w.session, now));
    writeEntry(w, "background-task-done");
    const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("does not yet show 1 of the 2");
    expect(getGrant(w.db, grant)!.voided_at).toBeNull();
  });

  test("a hold after the grant was verified checks the transcript again", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_reverify", "no", now));
    const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
    expect(prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toBe(grant);
    expect(getGrant(w.db, grant)!.verified_at).not.toBeNull();
    tx(w.db, () => holdSessionGrants(w.db, w.session, now));
    expect(getGrant(w.db, grant)!.verified_at).toBeNull();
    expect(() => tx(w.db, () => takeGrant(w.db, grant, "decide", now))).toThrow("is not verified");
    writeEntry(w, "subagent-handback");
    expect(prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toBe(grant);
    expect(tx(w.db, () => takeGrant(w.db, grant, "decide", now))).toMatchObject({ consumed_by: "decide", held_prompts: 1 });
  });

  test("migration 36: grants keep their rows and start held across no notice", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "flowryn.db"));
    migrate(db, MIGRATIONS.slice(0, 35));
    db.exec("INSERT INTO captain_grants (id, session_id, tool_use_id, item, action, choice, question, answer, transcript_path, created_at, expires_at) VALUES ('c1', 'L1', 'toolu_1', 'q1', 'decide', 'yes', 'q1 · ?', 'yes', '/t.jsonl', 1, 2)");
    expect(migrate(db, MIGRATIONS.slice(0, 36))).toEqual([36]);
    expect(db.query("SELECT id, choice, held_prompts FROM captain_grants").all()).toEqual([{ id: "c1", choice: "yes", held_prompts: 0 }]);
    db.close();
  });

  test("a hold leaves used, voided and expired grants alone; the ten minutes and the turn's end still apply", () => {
    const w = world();
    const now = Date.now();
    const grant = grantIn(askAndAnswer(w, "toolu_limits", "no", now));
    expect(tx(w.db, () => holdSessionGrants(w.db, w.session, now + GRANT_TTL_MS))).toBe(0);
    writeEntry(w, "monitor-event");
    tx(w.db, () => holdSessionGrants(w.db, w.session, now));
    const ask = { session: w.session, item: w.decision, choice: "no", grantId: grant };
    expect(() => findGrant(w.db, ask, now + GRANT_TTL_MS)).toThrow("expired");
    expect(tx(w.db, () => voidSessionGrants(w.db, w.session, "the turn ended", now))).toBe(1);
    expect(tx(w.db, () => holdSessionGrants(w.db, w.session, now))).toBe(0);
    expect(() => prepareGrant({ db: w.db, now: () => now }, ask, w.projects)).toThrow("voided: the turn ended");
    expect(w.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'grant.held'").get()).toEqual({ n: 1 });
  });
});

describe("configuration and static layers", () => {
  test("[grants] claude_projects_dir defaults to $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects", () => {
    const config = parseConfig("", "/h");
    expect(grantsConfig(config, { HOME: "/u" }).claude_projects_dir).toBe("/u/.claude/projects");
    expect(grantsConfig(config, { HOME: "/u", CLAUDE_CONFIG_DIR: "/c" }).claude_projects_dir).toBe("/c/projects");
    expect(grantsConfig(parseConfig('[grants]\nclaude_projects_dir = "/x"', "/h"), {}).claude_projects_dir).toBe("/x");
    expect(() => grantsConfig(parseConfig("[grants]\nttl = 3", "/h"), {})).toThrow("not a known setting");
  });

  test("the leader may not write Claude's transcripts; its memory notes stay writable", () => {
    const paths = { backlog: "/b/backlog.md", todos: "/b/todos.md", db: "/s/flowryn.db" };
    const config = { tasks: { backlog: paths.backlog, todos: paths.todos }, state_dir: "/s" } as never;
    const leader = leaderStaticLayers(config, "/u/.claude/projects");
    expect(leader.permissionsDeny).toContain("Edit(//u/.claude/projects/**/*.jsonl)");
    expect(staticLayers(paths).permissionsDeny).not.toContain("Edit(//u/.claude/projects/**/*.jsonl)");
  });
});
