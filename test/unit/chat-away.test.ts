import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../../src/db/db.ts";
import { MERGE_DEFAULTS } from "../../src/config/merge.ts";
import { awayRef, parseAwayRef } from "../../src/policy/autonomy.ts";
import { awaySummary, bindingRef, chatForm, mapAnswer, parseRef } from "../../src/policy/chat-questions.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * A plain away the user confirms in chat (docs/notes/2026-11-08-unattended-loops-answer-4y.md):
 * the item `away:<YYYY-MM-DDTHH:MM>`, its binding question, and what an answer grants.
 */

let h: TestHome;
let db: Db;
const NOW = new Date(2026, 10, 8, 23, 0).getTime();
const UNTIL = new Date(2026, 10, 9, 7, 30).getTime();

beforeEach(() => {
  h = makeHome();
  db = h.db();
});
afterEach(() => {
  db.close();
  h.cleanup();
});

describe("the away item", () => {
  test("awayRef names the end to the minute and parseAwayRef reads it back", () => {
    expect(awayRef(UNTIL)).toBe("away:2026-11-09T07:30");
    expect(parseAwayRef("away:2026-11-09T07:30")).toBe(UNTIL);
  });

  test("anything else is no away item", () => {
    for (const bad of ["away:", "away:tomorrow", "away:2026-13-09T07:30", "away:2026-11-09T7:30", "away:2026-11-09T07:30 extra", "autonomy:web@2026-11-09T07:30"]) expect(parseAwayRef(bad)).toBeNull();
  });

  test("parseRef takes it as typed and refuses a malformed one", () => {
    expect(parseRef("away:2026-11-09T07:30")).toBe("away:2026-11-09T07:30");
    expect(() => parseRef("away:soon")).toThrow(/is not away:<YYYY-MM-DDTHH:MM>/);
  });
});

describe("its binding question", () => {
  test("the form binds to the item, states what it allows and what it never does, and maps the answer", () => {
    const form = chatForm(db, "away:2026-11-09T07:30", MERGE_DEFAULTS, NOW);
    expect(form).toMatchObject({ ref: "away:2026-11-09T07:30", action: "away", task: null, freeText: null });
    expect(form.question.question.startsWith("away 2026-11-09T07:30 · ")).toBe(true);
    expect(form.question.question).toContain("never merges");
    expect(bindingRef(form.question.question)).toBe("away:2026-11-09T07:30");
    expect(mapAnswer(form, "Decide while I'm away", null)).toEqual({ kind: "grant", choice: "start", words: null });
    expect(mapAnswer(form, "No", null)).toEqual({ kind: "declined", label: "No" });
    expect(mapAnswer(form, "sure, whatever", null).kind).toBe("none");
  });

  test("an end in the past cannot be asked", () => {
    expect(() => chatForm(db, "away:2026-11-09T07:30", MERGE_DEFAULTS, UNTIL + 60_000)).toThrow(/in the past/);
  });
});

describe("what the away confirmation says it merges", () => {
  const OFF = { sensitive_when_away: false };
  const ON = { sensitive_when_away: true };

  test("with [merge] sensitive_when_away off it never merges and never touches a sensitive task", () => {
    const text = awaySummary(OFF);
    expect(text).toContain("It never merges, never answers a merge, destructive, irreversible, security, credential or outward question, and never touches a sensitive task");
    expect(text).not.toContain("yolo");
    expect(chatForm(db, "away:2026-11-09T07:30", OFF, NOW).question.question).toContain(text);
  });

  test("with it on it says yolo PRs merge by themselves, sensitive ones after verify and the validator, and other projects never", () => {
    const text = awaySummary(ON);
    expect(text).toContain("Pull requests of yolo projects merge by themselves once their gates pass, sensitive ones included");
    expect(text).toContain("only after its local verify and a fresh-context validator have both passed at its exact head");
    expect(text).toContain("A project that is not yolo never merges by policy.");
    expect(text).toContain("never answers a merge, destructive, irreversible, security, credential or outward question");
    expect(text).not.toContain("never merges,");
    expect(text).not.toContain("never touches a sensitive task");
    expect(chatForm(db, "away:2026-11-09T07:30", ON, NOW).question.question).toContain(text);
  });

  test("the two forms differ, so a question asked under one setting grants nothing under the other", () => {
    expect(chatForm(db, "away:2026-11-09T07:30", ON, NOW).question).not.toEqual(chatForm(db, "away:2026-11-09T07:30", OFF, NOW).question);
  });
});
