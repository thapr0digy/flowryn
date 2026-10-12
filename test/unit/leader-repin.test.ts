import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { MIGRATIONS } from "../../src/db/schema.ts";
import { claim, openSession } from "../../src/lease/lease.ts";
import { applyRepin, pinHistory, planRepin, processCwd, repinCandidates } from "../../src/lease/repin.ts";
import { createStandaloneDecision } from "../../src/lifecycle/decisions.ts";
import { chatForm } from "../../src/policy/chat-questions.ts";
import { claudeProjectSlug, getGrant, postAsk, preAsk, prepareGrant, REPIN_FIX, takeGrant } from "../../src/policy/grants.ts";
import { lsofPath } from "../../src/policy/locks.ts";
import { readIdentity } from "../../src/runtime/proc.ts";

/**
 * `flowryn leader repin` (docs/notes/2026-10-11-flowryn-leader-repin-xv.md): the target comes from
 * the transcript's own cwd fields, the repin is bound to what you were shown, and nothing from
 * before it can authorise anything.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  db: Db;
  root: string;
  projects: string;
  /** Where `flowryn lead` pinned the session. */
  pinned: string;
  /** Where its Claude really runs: the transcript is in this directory's folder. */
  real: string;
  session: string;
  claudeSession: string;
  transcript: string;
  decision: string;
}

const CLAUDE_SESSION = "3f1c0f0e-1111-4222-8333-944445555666";

/** A leading Claude session pinned to one directory whose transcript sits in another's folder (the 2026-10-10 drift). */
function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flowryn-repin-")));
  dirs.push(root);
  const db = openDb(join(root, "flowryn.db"));
  migrate(db);
  const pinned = join(root, "projects", "flowryn");
  const real = join(root, "projects");
  mkdirSync(pinned, { recursive: true });
  const projects = join(root, "claude-projects");
  mkdirSync(join(projects, claudeProjectSlug(real)), { recursive: true });
  const transcript = join(projects, claudeProjectSlug(real), `${CLAUDE_SESSION}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, cwd: real, timestamp: new Date(1_000).toISOString(), message: { content: "hi" } })}\n`);
  const { session } = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p2", cwd: pinned, now: 1_000 }));
  tx(db, () => claim(db, session, "test", 1_000));
  db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(session, transcript);
  const made = tx(db, () => createStandaloneDecision(db, { key: "rotate", question: "Rotate the key?", options: ["yes", "no"], recommendation: "yes", origin: "leader", reservedReason: "security", now: 1_000 }));
  return { db, root, projects, pinned, real, session, claudeSession: CLAUDE_SESSION, transcript, decision: made.id };
}

function plan(w: World, dir: string | null = null) {
  return planRepin(w.db, { dir, projectsDir: w.projects });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return "no error";
}

function repin(w: World, now: number): { voided: number } {
  const p = plan(w);
  return tx(w.db, () => applyRepin(w.db, { session: p.session, oldCwd: p.oldCwd, newCwd: p.newCwd, transcript: p.transcript, actor: "tester", now }));
}

/** Ask and answer the decision's binding question through both hooks; Claude's transcript lines at `answeredAt`. */
function ask(w: World, toolUseId: string, now: number, answeredAt = now): string[] {
  const q = chatForm(w.db, w.decision).question;
  expect(tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId, input: { questions: [q] }, now }))).toBeNull();
  const result = { questions: [q], answers: { [q.question]: "yes (Recommended)" }, annotations: {} };
  const lines = tx(w.db, () => postAsk(w.db, { session: w.session, toolUseId, input: result, response: result, claudeSession: w.claudeSession, transcriptPath: w.transcript, now }));
  const at = new Date(answeredAt).toISOString();
  appendFileSync(w.transcript, `${JSON.stringify({ type: "assistant", sessionId: w.claudeSession, cwd: w.real, timestamp: at, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: [q] } }] } })}\n`);
  appendFileSync(w.transcript, `${JSON.stringify({ type: "user", sessionId: w.claudeSession, cwd: w.real, timestamp: at, toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "answered" }] } })}\n`);
  return lines;
}

function grantIn(lines: string[]): string {
  const id = /Grant (c\d+)/.exec(lines.join("\n"))?.[1];
  if (!id) throw new Error(`no grant in ${JSON.stringify(lines)}`);
  return id;
}

function prepare(w: World, now: number): string | null {
  return prepareGrant({ db: w.db, now: () => now }, { session: w.session, item: w.decision, choice: "yes", grantId: null }, w.projects);
}

describe("the target", () => {
  test("assumption: Claude's transcript entries carry cwd and sessionId, so the target comes from them", () => {
    const w = world();
    expect(repinCandidates(w.transcript, w.claudeSession, claudeProjectSlug(w.real))).toEqual([w.real]);
    expect(plan(w)).toMatchObject({ session: w.session, pane: "w1:p2", oldCwd: w.pinned, newCwd: w.real, from: "transcript", folder: claudeProjectSlug(w.real), claudeSession: CLAUDE_SESSION, liveGrants: 0 });
  });

  test("entries of another Claude session, or naming a directory of another folder or none, are not candidates", () => {
    const w = world();
    appendFileSync(w.transcript, `${JSON.stringify({ type: "user", sessionId: "other", cwd: w.pinned })}\n`);
    appendFileSync(w.transcript, `${JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, cwd: w.pinned })}\n`);
    appendFileSync(w.transcript, `${JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, cwd: join(w.root, "gone") })}\n`);
    appendFileSync(w.transcript, "not json\n");
    expect(repinCandidates(w.transcript, w.claudeSession, claudeProjectSlug(w.real))).toEqual([w.real]);
  });

  test("a transcript that names no directory for its folder needs one named; one you name must be that folder's", () => {
    const w = world();
    writeFileSync(w.transcript, `${JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, message: { content: "no cwd" } })}\n`);
    expect(codeOf(() => plan(w))).toContain("bad_args: L1's transcript names no existing directory");
    expect(codeOf(() => plan(w, join(w.root, "projects", "flowryn")))).toContain("bad_args: ");
    expect(codeOf(() => plan(w, join(w.root, "projects", "flowryn")))).toContain("would not fix it");
    expect(codeOf(() => plan(w, join(w.root, "nowhere")))).toContain("is not a directory");
    expect(plan(w, w.real)).toMatchObject({ newCwd: w.real, from: "argument" });
  });

  test("assumption: the folder name cannot be inverted; two directories that share it are refused, not guessed", () => {
    const w = world();
    // `<root>/projects` and `<root>-projects`... the same folder: every non-alphanumeric becomes '-'.
    const twin = `${w.root}-projects`;
    mkdirSync(twin, { recursive: true });
    dirs.push(twin);
    expect(claudeProjectSlug(twin)).toBe(claudeProjectSlug(w.real));
    appendFileSync(w.transcript, `${JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, cwd: twin })}\n`);
    expect(codeOf(() => plan(w))).toContain(`names several directories for its folder ${claudeProjectSlug(w.real)}: ${[twin, w.real].toSorted().join(", ")}`);
    expect(plan(w, twin)).toMatchObject({ newCwd: twin, from: "argument" });
  });

  test("refusals: already pinned, a Pi leader, no lease, no transcript, a transcript outside Claude's projects directory", () => {
    const w = world();
    w.db.query("UPDATE leader_sessions SET cwd = ?2 WHERE session_id = ?1").run(w.session, w.real);
    expect(codeOf(() => plan(w))).toContain("no_change: L1 is already pinned");
    w.db.query("UPDATE leader_sessions SET cwd = ?2 WHERE session_id = ?1").run(w.session, w.pinned);
    expect(codeOf(() => planRepin(w.db, { dir: null, projectsDir: join(w.root, "elsewhere") }))).toContain("not in a folder of Claude's projects directory");
    w.db.query("UPDATE leader_sessions SET transcript_path = NULL WHERE session_id = ?1").run(w.session);
    expect(codeOf(() => plan(w))).toContain("not_found: L1 has no Claude transcript recorded yet");
    w.db.query("UPDATE leader_sessions SET harness = 'pi' WHERE session_id = ?1").run(w.session);
    expect(codeOf(() => plan(w))).toContain("bad_args: L1 is a pi leader");
    w.db.query("UPDATE leader_lease SET session_id = NULL WHERE id = 1").run();
    expect(codeOf(() => plan(w))).toContain("not_found: no leader session holds the lease");
  });
});

describe("the repin", () => {
  test("database: migration 19 adds leader_sessions.pinned_at", () => {
    const w = world();
    expect(MIGRATIONS.find((m) => m.name === "leader-repin")?.version).toBe(19);
    expect((w.db.query("PRAGMA table_info(leader_sessions)").all() as { name: string }[]).map((c) => c.name)).toContain("pinned_at");
  });

  test("moves the pin, voids live grants and records who, old, new and when; show lists the history", () => {
    const w = world();
    const grant = grantIn(ask(w, "toolu_before", 2_000));
    expect(plan(w).liveGrants).toBe(1);
    expect(repin(w, 3_000)).toEqual({ voided: 1 });
    expect(w.db.query("SELECT cwd, pinned_at FROM leader_sessions WHERE session_id = ?1").get(w.session)).toEqual({ cwd: w.real, pinned_at: 3_000 });
    expect(getGrant(w.db, grant)).toMatchObject({ void_reason: "the leader was repinned", voided_at: 3_000 });
    const event = w.db.query("SELECT ts, source, payload FROM events WHERE kind = 'leader.repinned'").get() as { ts: number; source: string; payload: string };
    expect(event).toMatchObject({ ts: 3_000, source: "cli" });
    expect(JSON.parse(event.payload)).toEqual({ session: w.session, by: "tester", channel: "cli-tty", old_cwd: w.pinned, new_cwd: w.real, transcript: w.transcript, grants_voided: 1 });
    expect(pinHistory(w.db, w.session, { cwd: w.real, startedAt: 1_000 })).toEqual([
      `${new Date(1_000).toISOString()} opened at ${w.pinned}`,
      `${new Date(3_000).toISOString()} repinned by tester: ${w.pinned} → ${w.real} (1 grant voided)`,
    ]);
  });

  test("the live grants shown are the ones voided, an expired but unvoided grant included", () => {
    const w = world();
    const expired = grantIn(ask(w, "toolu_expired", 2_000));
    w.db.query("UPDATE captain_grants SET expires_at = 2_001 WHERE id = ?1").run(expired);
    const shown = plan(w).liveGrants;
    expect(shown).toBe(1);
    expect(repin(w, 900_000)).toEqual({ voided: shown });
    expect(getGrant(w.db, expired)).toMatchObject({ void_reason: "the leader was repinned", voided_at: 900_000 });
  });

  test("bound to what you were shown: a changed pin or transcript, a moved lease or an ended session refuses it", () => {
    const w = world();
    const p = plan(w);
    const apply = () => tx(w.db, () => applyRepin(w.db, { session: p.session, oldCwd: p.oldCwd, newCwd: p.newCwd, transcript: p.transcript, actor: "tester", now: 3_000 }));
    w.db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(w.session, `${w.transcript}.x`);
    expect(codeOf(apply)).toContain("challenge_failed: the pin or transcript of L1 changed");
    w.db.query("UPDATE leader_sessions SET transcript_path = ?2 WHERE session_id = ?1").run(w.session, w.transcript);
    const other = tx(w.db, () => openSession(w.db, { harness: "claude", pane: null, cwd: w.real, now: 2_000 }));
    tx(w.db, () => claim(w.db, other.session, "test", 2_000));
    expect(codeOf(apply)).toContain("challenge_failed: L1 no longer holds the lease");
    w.db.query("UPDATE leader_sessions SET ended_at = 2_500 WHERE session_id = ?1").run(w.session);
    expect(codeOf(apply)).toContain("challenge_failed: leader session L1 ended");
    expect(w.db.query("SELECT cwd, pinned_at FROM leader_sessions WHERE session_id = ?1").get(w.session)).toEqual({ cwd: w.pinned, pinned_at: null });
  });

  test("a session opened before its open event carried cwd shows the first repin's old directory", () => {
    const w = world();
    // Events are append-only: an older session's open event, as it was written then.
    tx(w.db, () => {
      appendEvent(w.db, { source: "cli", kind: "leader.session_opened", payload: { session: "L9", harness: "claude", pane: null }, ts: 500 });
      appendEvent(w.db, { source: "cli", kind: "leader.repinned", payload: { session: "L9", by: "tester", old_cwd: "/old", new_cwd: "/new", grants_voided: 2 }, ts: 900 });
    });
    expect(pinHistory(w.db, "L9", { cwd: "/new", startedAt: 500 })).toEqual([`${new Date(500).toISOString()} opened at /old`, `${new Date(900).toISOString()} repinned by tester: /old → /new (2 grants voided)`]);
    expect(pinHistory(w.db, "L10", { cwd: "/here", startedAt: null })).toEqual(["? opened at /here"]);
  });
});

describe("grants around a repin", () => {
  test("before: refused, naming the fix; after: a fresh answer works", () => {
    const w = world();
    grantIn(ask(w, "toolu_drifted", 2_000));
    let refusal: FlowrynError | null = null;
    try {
      prepare(w, 2_100);
    } catch (error) {
      refusal = error as FlowrynError;
    }
    expect(refusal?.message).toContain(`the transcript is not in Claude's project folder for the leader's directory (${w.pinned}); ${REPIN_FIX}`);
    expect(refusal?.help).toBe("the user runs: flowryn leader repin (in their own terminal, not the leader's)");

    repin(w, 3_000);
    const fresh = grantIn(ask(w, "toolu_fresh", 4_000));
    expect(prepare(w, 4_100)).toBe(fresh);
    expect(tx(w.db, () => takeGrant(w.db, fresh, "decide", 4_200))).toMatchObject({ id: fresh, consumed_by: "decide" });
  });

  test("a question asked before the repin and answered after it grants nothing", () => {
    const w = world();
    const q = chatForm(w.db, w.decision).question;
    expect(tx(w.db, () => preAsk(w.db, { session: w.session, toolUseId: "toolu_span", input: { questions: [q] }, now: 2_000 }))).toBeNull();
    repin(w, 3_000);
    const result = { questions: [q], answers: { [q.question]: "yes (Recommended)" }, annotations: {} };
    const lines = tx(w.db, () => postAsk(w.db, { session: w.session, toolUseId: "toolu_span", input: result, response: result, claudeSession: w.claudeSession, transcriptPath: w.transcript, now: 4_000 }));
    expect(lines).toEqual(["Flowryn: this answer grants nothing (it was asked before the leader was repinned; ask again)."]);
  });

  test("replay: an answer line from before the repin never verifies, even inside the skew allowance", () => {
    const w = world();
    repin(w, 100_000);
    // A forged pre- and post-tool pair after the repin, for an answer Claude recorded 30 s before it.
    grantIn(ask(w, "toolu_replayed", 101_000, 70_000));
    expect(() => prepare(w, 101_100)).toThrow("Claude's transcript has no such answer from the user");
  });

  test("a grant made before the repin is refused at use even if it was never voided", () => {
    const w = world();
    const old = grantIn(ask(w, "toolu_old", 2_000));
    w.db.query("UPDATE leader_sessions SET cwd = ?2 WHERE session_id = ?1").run(w.session, w.real);
    expect(prepare(w, 2_100)).toBe(old);
    w.db.query("UPDATE leader_sessions SET pinned_at = 3_000 WHERE session_id = ?1").run(w.session);
    expect(codeOf(() => tx(w.db, () => takeGrant(w.db, old, "decide", 3_100)))).toBe(`approval_required: grant ${old} was made before the leader was repinned`);
  });
});

test("assumption: the Claude process's cwd can be read (lsof on macOS, /proc on Linux); a gone process reads as unknown", async () => {
  const self = await readIdentity(process.pid);
  expect(self).not.toBeNull();
  const cwd = await processCwd(self, lsofPath());
  expect(cwd === null ? null : realpathSync(cwd)).toBe(realpathSync(process.cwd()));
  expect(await processCwd({ ...self!, start: self!.start - 3_600_000 }, lsofPath())).toBeNull();
  expect(await processCwd(null, lsofPath())).toBeNull();
});

// The daemon's lsof path is the one used, not whatever `lsof` launchd's PATH finds; /proc needs none.
test.skipIf(process.platform !== "darwin")("macOS: the process cwd is read with the lsof path the daemon resolved, and reads as unknown without one", async () => {
  const self = await readIdentity(process.pid);
  const bin = mkdtempSync(join(tmpdir(), "flowryn-lsof-"));
  const fake = join(bin, "lsof");
  writeFileSync(fake, "#!/bin/sh\necho p$3\necho n/from/the/resolved/lsof\n");
  chmodSync(fake, 0o755);
  expect(await processCwd(self, fake)).toBe("/from/the/resolved/lsof");
  expect(await processCwd(self, null)).toBeNull();
  expect(await processCwd(self, join(bin, "missing"))).toBeNull();
});
