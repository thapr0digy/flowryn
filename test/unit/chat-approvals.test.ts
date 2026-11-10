import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { MERGE_DEFAULTS } from "../../src/config/merge.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { openSession } from "../../src/lease/lease.ts";
import { bindingRef, chatForm, mapAnswer, parseRef } from "../../src/policy/chat-questions.ts";
import { discardBinds, discardBindsProblem, discardFacts, noteDiscardFacts, readDiscardFacts, type DiscardFacts } from "../../src/policy/discard-facts.ts";
import { claudeProjectSlug, getGrant, postAsk, preAsk, prepareGrant } from "../../src/policy/grants.ts";
import type { GitRunner } from "../../src/policy/landed.ts";

/** Chat-answer approvals for discard and allow-red (docs/notes/2026-11-09-chat-answer-approvals-wa.md). */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HEAD = "aaaaaaaa11112222333344445555666677778888";
const NEW_HEAD = "bbbbbbbb11112222333344445555666677778888";
const PR = "https://github.test/o/web/pull/7";

interface World {
  db: Db;
  projects: string;
  session: string;
  claudeSession: string;
  transcript: string;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "flowryn-chat-approvals-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  const projects = join(dir, "projects");
  mkdirSync(join(projects, claudeProjectSlug(dir)), { recursive: true });
  const claudeSession = "3f1c0f0e-1111-4222-8333-944445555666";
  const transcript = join(projects, claudeProjectSlug(dir), `${claudeSession}.jsonl`);
  writeFileSync(transcript, "");
  const { session } = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: dir, now: 1_000 }));
  db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(session, transcript);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.test/o/web.git', '/tmp/web', 'main', 'direct-PR')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('T1', 'web', 'ship', 'direct-PR', 0, 'fix', 1)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 'T1', 'claude', '2.1.281', 'ready', 'idle', 'fix', 'ship', '/tmp/wt-T1', 'flowryn/t1', 'abc123', 'h', 1, 1)`,
    ).run();
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 'T1', 'pr', ?1, ?2, 1)").run(PR, HEAD);
  });
  return { db, projects, session, claudeSession, transcript };
}

function setChecks(w: World, red: string[], head = HEAD): void {
  const checks = { state: red.length > 0 ? "red" : "green", line: `${red.length} red of 3`, red, pending: [], total: 3, not_started: [] };
  w.db.query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)").run(
    JSON.stringify({ url: PR, number: 7, title: "t", state: "open", draft: false, head, head_ref: "flowryn/t1", merge_sha: null, checks, observed_at: 1 }),
  );
}

function facts(over: Partial<DiscardFacts> = {}): DiscardFacts {
  return { head: HEAD, uncommitted: 2, digest: "d1".repeat(32), worktree: "/tmp/wt-T1", branch: "flowryn/t1", ...over };
}

function seedDiscard(w: World, f: DiscardFacts = facts(), now = 5_000): void {
  noteDiscardFacts(w.db, { id: "r1", task_id: "T1" }, f, "cli", now);
}

function thrown(fn: () => unknown): FlowrynError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error("expected a FlowrynError");
}

/** Ask and answer one binding question through both hooks, with Claude's transcript showing it; returns the grant id or the lines. */
function askAndAnswer(w: World, ref: string, answer: string, toolUseId = "toolu_1"): { grant: string | null; lines: string[] } {
  const q = chatForm(w.db, ref, MERGE_DEFAULTS).question;
  const now = Date.now();
  expect(tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId, input: { questions: [q] }, merge: MERGE_DEFAULTS, now }))).toBeNull();
  const at = new Date(now).toISOString();
  appendFileSync(w.transcript, JSON.stringify({ type: "assistant", sessionId: w.claudeSession, timestamp: at, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: [q] } }] } }) + "\n");
  appendFileSync(
    w.transcript,
    JSON.stringify({ type: "user", sessionId: w.claudeSession, timestamp: at, toolUseResult: { questions: [q], answers: { [q.question]: answer }, annotations: {} }, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "answered" }] } }) + "\n",
  );
  const lines = tx(w.db, () =>
    postAsk(w.db, { session: w.session, toolUseId, input: { questions: [q] }, response: { answers: { [q.question]: answer } }, claudeSession: w.claudeSession, transcriptPath: w.transcript, merge: MERGE_DEFAULTS, now }),
  );
  return { grant: /Grant (c\d+)/.exec(lines.join("\n"))?.[1] ?? null, lines };
}

const ctx = (w: World) => ({ db: w.db, now: () => Date.now() });

describe("the item ids", () => {
  test("parseRef and bindingRef accept discard and allow-red as merge does", () => {
    expect(parseRef("discard:T1")).toBe("discard:T1");
    expect(parseRef("discard T1")).toBe("discard:T1");
    expect(parseRef("allow-red:web-billing-q4")).toBe("allow-red:web-billing-q4");
    expect(parseRef("allow-red web-billing-q4")).toBe("allow-red:web-billing-q4");
    expect(bindingRef("discard T1 · Title: worktree")).toBe("discard:T1");
    expect(bindingRef("allow-red T1 · Title: PR")).toBe("allow-red:T1");
    expect(bindingRef("merge T1 · Title")).toBe("merge:T1");
    expect(bindingRef("discard T1: worktree")).toBeNull();
  });

  test("a malformed item is refused", () => {
    expect(thrown(() => parseRef("discard:")).code).toBe("bad_args");
    expect(thrown(() => parseRef("allow-red:-x")).code).toBe("bad_args");
    expect(thrown(() => parseRef("discard:T1@x")).code).toBe("bad_args");
  });
});

describe("the discard question", () => {
  test("shows the worktree, branch, head, uncommitted count, and says it cannot be undone", () => {
    const w = world();
    seedDiscard(w);
    const form = chatForm(w.db, "discard:T1", MERGE_DEFAULTS);
    expect(form.action).toBe("discard");
    expect(form.question.question.startsWith("discard T1 · ")).toBe(true);
    expect(form.question.question).toContain("worktree /tmp/wt-T1, branch flowryn/t1 at aaaaaaaa, 2 uncommitted change(s)");
    expect(form.question.question).toContain("It cannot be undone once the worktree is removed.");
    expect(form.question.options.map((o) => o.label)).toEqual(["Discard", "Keep it"]);
    expect(form.binds).toBe(discardBinds(facts()));
    expect(mapAnswer(form, "Keep it", null)).toEqual({ kind: "declined", label: "Keep it" });
    expect(mapAnswer(form, "Discard", null)).toEqual({ kind: "grant", choice: "discard", words: null });
    expect(mapAnswer(form, "yes do it", null).kind).toBe("none");
  });

  test("without a recorded snapshot it names the cleanup command that records one", () => {
    const w = world();
    const error = thrown(() => chatForm(w.db, "discard:T1", MERGE_DEFAULTS));
    expect(error.code).toBe("not_ready");
    expect(error.help).toContain("flowryn cleanup T1 --discard");
  });

  test("an already-removed worktree cannot be asked", () => {
    const w = world();
    seedDiscard(w);
    w.db.query("UPDATE runs SET cleanup = 'done' WHERE id = 'r1'").run();
    expect(thrown(() => chatForm(w.db, "discard:T1", MERGE_DEFAULTS)).code).toBe("not_ready");
  });

  test("noting the same facts again records nothing; new facts record one event", () => {
    const w = world();
    seedDiscard(w);
    seedDiscard(w, facts(), 9_000);
    expect(discardFacts(w.db, "r1")?.observed_at).toBe(5_000);
    seedDiscard(w, facts({ uncommitted: 3, digest: "d2".repeat(32) }), 9_000);
    expect(discardFacts(w.db, "r1")?.uncommitted).toBe(3);
    const events = w.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'discard.observed'").get() as { n: number };
    expect(events.n).toBe(2);
  });
});

function git(status: { code: number; stdout: string }, head = HEAD): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
    return { ...status, stderr: "" };
  };
}

describe("readDiscardFacts", () => {
  const run = { worktree_path: "/tmp/wt-T1", branch: "flowryn/t1" };

  test("counts entries and digests the status, so another file changes the binding", async () => {
    const two = await readDiscardFacts(git({ code: 0, stdout: " M a.ts\0?? b.ts\0" }), run, { path: "/tmp/web" });
    const three = await readDiscardFacts(git({ code: 0, stdout: " M a.ts\0?? b.ts\0?? c.ts\0" }), run, { path: "/tmp/web" });
    expect(two.uncommitted).toBe(2);
    expect(three.uncommitted).toBe(3);
    expect(two.digest).not.toBe(three.digest);
    expect(discardBindsProblem("c1", discardBinds(two), three)).toContain("uncommitted files have changed");
    expect(discardBindsProblem("c1", discardBinds(two), two)).toBeNull();
  });

  test("an unreadable status never matches a readable one", async () => {
    const bad = await readDiscardFacts(git({ code: 128, stdout: "" }), run, { path: "/tmp/web" });
    const clean = await readDiscardFacts(git({ code: 0, stdout: "" }), run, { path: "/tmp/web" });
    expect(bad.uncommitted).toBe(-1);
    expect(bad.digest).not.toBe(clean.digest);
  });

  test("a moved head is named", () => {
    expect(discardBindsProblem("c4", discardBinds(facts()), facts({ head: NEW_HEAD }))).toBe("grant c4 was for head aaaaaaaa; the head is now bbbbbbbb");
  });
});

describe("the allow-red question", () => {
  test("names the one failing check, and the answer's choice is that check", () => {
    const w = world();
    setChecks(w, ["lint (ubuntu)"]);
    const form = chatForm(w.db, "allow-red:T1", MERGE_DEFAULTS);
    expect(form.action).toBe("allow-red");
    expect(form.question.question).toBe(`allow-red T1 · T1: PR ${PR} at aaaaaaaa, checks 1 red of 3. Merge it waiving the one failing check "lint (ubuntu)"? Every other check must be green.`);
    expect(form.binds).toBe(HEAD);
    expect(mapAnswer(form, "Waive and merge", null)).toEqual({ kind: "grant", choice: "lint (ubuntu)", words: null });
    expect(mapAnswer(form, "Don't merge", null).kind).toBe("declined");
  });

  test("no failing check, or two, cannot be asked", () => {
    const w = world();
    setChecks(w, []);
    expect(thrown(() => chatForm(w.db, "allow-red:T1", MERGE_DEFAULTS)).message).toContain("nothing to waive");
    setChecks(w, ["a", "b"]);
    expect(thrown(() => chatForm(w.db, "allow-red:T1", MERGE_DEFAULTS)).message).toContain("only one can be waived");
  });

  test("unknown checks and a local delivery cannot be asked", () => {
    const w = world();
    expect(thrown(() => chatForm(w.db, "allow-red:T1", MERGE_DEFAULTS)).message).toContain("unknown");
    w.db.query("UPDATE artifacts SET kind = 'local' WHERE id = 'a1'").run();
    expect(thrown(() => chatForm(w.db, "allow-red:T1", MERGE_DEFAULTS)).message).toContain("local-only");
  });

  test("the plain merge question still says it never waives", () => {
    const w = world();
    setChecks(w, ["lint"]);
    expect(chatForm(w.db, "merge:T1", MERGE_DEFAULTS).question.options[0]!.description).toContain("never waives a red check");
  });
});

describe("grants bind to what was shown", () => {
  test("a discard tap is used for the same head and files, refused for a new head or new files", () => {
    const w = world();
    seedDiscard(w);
    const { grant } = askAndAnswer(w, "discard:T1", "Discard");
    expect(grant).not.toBeNull();
    expect(getGrant(w.db, grant!)?.action).toBe("discard");
    const ask = { session: w.session, item: "discard:T1", choice: "discard", grantId: grant };
    expect(thrown(() => prepareGrant(ctx(w), { ...ask, discard: facts({ head: NEW_HEAD }) }, w.projects)).message).toContain("the head is now bbbbbbbb");
    expect(thrown(() => prepareGrant(ctx(w), { ...ask, discard: facts({ uncommitted: 3, digest: "d3".repeat(32) }) }, w.projects)).message).toContain("uncommitted files have changed");
    expect(thrown(() => prepareGrant(ctx(w), ask, w.projects)).message).toContain("cannot be checked against the worktree");
    expect(prepareGrant(ctx(w), { ...ask, discard: facts() }, w.projects)).toBe(grant);
  });

  test("Keep it grants nothing", () => {
    const w = world();
    seedDiscard(w);
    const { grant, lines } = askAndAnswer(w, "discard:T1", "Keep it");
    expect(grant).toBeNull();
    expect(lines.join("\n")).toContain("nothing is granted");
  });

  test("the facts moving while the user answered grant nothing", () => {
    const w = world();
    seedDiscard(w);
    const q = chatForm(w.db, "discard:T1", MERGE_DEFAULTS).question;
    const now = Date.now();
    tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_9", input: { questions: [q] }, merge: MERGE_DEFAULTS, now }));
    seedDiscard(w, facts({ head: NEW_HEAD }), now);
    const lines = tx(w.db, () =>
      postAsk(w.db, { session: w.session, toolUseId: "toolu_9", input: { questions: [q] }, response: { answers: { [q.question]: "Discard" } }, claudeSession: w.claudeSession, transcriptPath: w.transcript, merge: MERGE_DEFAULTS, now }),
    );
    expect(lines.join("\n")).toContain("its facts changed while the user answered");
  });

  test("an allow-red tap is for its check only, and its head only", () => {
    const w = world();
    setChecks(w, ["lint"]);
    const { grant } = askAndAnswer(w, "allow-red:T1", "Waive and merge");
    expect(grant).not.toBeNull();
    const ask = { session: w.session, item: "allow-red:T1", grantId: grant };
    expect(thrown(() => prepareGrant(ctx(w), { ...ask, choice: "tests", head: HEAD }, w.projects)).code).toBe("grant_mismatch");
    expect(thrown(() => prepareGrant(ctx(w), { ...ask, choice: "lint", head: NEW_HEAD }, w.projects)).message).toContain("the head is now bbbbbbbb");
    expect(prepareGrant(ctx(w), { ...ask, choice: "lint", head: HEAD }, w.projects)).toBe(grant);
  });

  test("a question that brings its own answer is denied", () => {
    const w = world();
    seedDiscard(w);
    const q = chatForm(w.db, "discard:T1", MERGE_DEFAULTS).question;
    const deny = tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_x", input: { questions: [q], answers: { [q.question]: "Discard" } }, merge: MERGE_DEFAULTS, now: Date.now() }));
    expect(deny).toContain("may not carry its own answers");
  });

  test("a reworded discard question is denied with the exact form", () => {
    const w = world();
    seedDiscard(w);
    const q = chatForm(w.db, "discard:T1", MERGE_DEFAULTS).question;
    const deny = tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_y", input: { questions: [{ ...q, question: "discard T1 · just tidy up?" }] }, merge: MERGE_DEFAULTS, now: Date.now() }));
    expect(deny).toContain("flowryn chat-question discard:T1");
  });

  test("an answer missing from Claude's transcript is refused at use", () => {
    const w = world();
    seedDiscard(w);
    const q = chatForm(w.db, "discard:T1", MERGE_DEFAULTS).question;
    const now = Date.now();
    tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_f", input: { questions: [q] }, merge: MERGE_DEFAULTS, now }));
    // The leader forges the post-tool hook; the transcript never shows the question or an answer.
    const lines = tx(w.db, () =>
      postAsk(w.db, { session: w.session, toolUseId: "toolu_f", input: { questions: [q] }, response: { answers: { [q.question]: "Discard" } }, claudeSession: w.claudeSession, transcriptPath: w.transcript, merge: MERGE_DEFAULTS, now }),
    );
    const grant = /Grant (c\d+)/.exec(lines.join("\n"))![1]!;
    const error = thrown(() => prepareGrant(ctx(w), { session: w.session, item: "discard:T1", choice: "discard", grantId: grant, discard: facts() }, w.projects));
    expect(error.code).toBe("approval_required");
    expect(error.message).toContain("Claude's transcript has no such question");
  });
});
