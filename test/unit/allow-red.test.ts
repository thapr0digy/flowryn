import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { LEADER_PERMISSIONS } from "../../src/bridges/claude/settings.ts";
import { parseArgv } from "../../src/cli/argv.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { summarize, type PullRequest } from "../../src/forge/types.ts";
import { gatedCommands, mergeWaiver } from "../../src/leader/hooks.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import type { RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { findAttempt, insertApproval, recordAttempt, voidPendingAttempts, type AttemptRow } from "../../src/policy/approvals.ts";
import { checkGate, chooseApproval, takeApproval, type ApprovalChoice, type ChoiceResult, type MergeFacts } from "../../src/policy/merge.ts";
import { POLICY_VERBS } from "../../src/policy/verbs.ts";
import { readShellWords, shellWord } from "../../src/util/shell-word.ts";

/**
 * `flowryn merge --allow-red <check>`: a red-check waiver made through the
 * leader's own approval channels (Claude's prompt, Pi's confirm). Each test
 * named "assumption: …" fails if a design assumption is wrong.
 */

let dir = "";
let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function freshDb(): Db {
  dir = mkdtempSync(join(tmpdir(), "fw-allow-red-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  return db;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return error.code;
    throw error;
  }
  return "ok";
}

function thrown(fn: () => unknown): FlowrynError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const NAME = "CI / build (ubuntu-latest, 20)";
const waiverOfLine = (line: string) => mergeWaiver(line, line.indexOf(" T1") + 3);

describe("the hook reads the waived check exactly as the shell will pass it", () => {
  test("a check name with spaces, commas and parentheses, single- or double-quoted, or after =", () => {
    expect(waiverOfLine(`flowryn merge T1 --allow-red '${NAME}'`)).toEqual({ kind: "check", check: NAME });
    expect(waiverOfLine(`flowryn merge T1 --allow-red "${NAME}" --json`)).toEqual({ kind: "check", check: NAME });
    expect(waiverOfLine(`flowryn merge T1 --allow-red='${NAME}'`)).toEqual({ kind: "check", check: NAME });
    expect(waiverOfLine("flowryn merge T1 --json --allow-red lint 2>&1")).toEqual({ kind: "check", check: "lint" });
    expect(waiverOfLine(`flowryn merge T1 --allow-red "it's \\"red\\""`)).toEqual({ kind: "check", check: `it's "red"` });
    expect(waiverOfLine("flowryn merge T1 --allow-red 'it'\\''s red'")).toEqual({ kind: "unreadable", why: expect.any(String) });
    expect(waiverOfLine("flowryn merge T1 \\\n  --allow-red lint")).toEqual({ kind: "check", check: "lint" });
    expect(waiverOfLine("flowryn merge T1 --json")).toEqual({ kind: "none" });
  });

  test("anything it cannot be sure of is unreadable, never guessed", () => {
    for (const tail of [
      "--allow-red $CHECK",
      '--allow-red "$CHECK"',
      "--allow-red `cat x`",
      "--allow-red lint*",
      "--allow-red ~lint",
      "--allow-red",
      "--allow-red ''",
      "--allow-red --json",
      "--allow-red -lint",
      "--allow-red a --allow-red b",
      "--allow-red=$X",
      "--allow-red 'unclosed",
      "--allow-red =lint",
      "$'--allow-red' lint",
      "--allow-red $'lint\\n'",
    ]) {
      expect({ tail, waiver: waiverOfLine(`flowryn merge T1 ${tail}`).kind }).toEqual({ tail, waiver: "unreadable" });
    }
    expect(waiverOfLine("flowryn merge T1 --allow-red 'a\tb'").kind).toBe("unreadable");
  });

  test("assumption: the waiver read belongs to its own merge, not a later command on the line", () => {
    expect(gatedCommands("flowryn merge T1 --json; flowryn merge T2 --allow-red lint")).toEqual([
      { action: "merge", task: "T1" },
      { action: "merge", task: "T2", allowRed: "lint" },
    ]);
    expect(gatedCommands("flowryn merge T1 && echo --allow-red lint")).toEqual([{ action: "merge", task: "T1" }]);
    expect(gatedCommands("flowryn merge T1 -- --allow-red lint")).toEqual([{ action: "merge", task: "T1" }]);
    expect(gatedCommands("flowryn merge T1 --allow-red $C")).toEqual([{ action: "merge", task: "T1", unreadable: expect.any(String) }]);
  });

  test("assumption: whatever shellWord writes, the reader gets back exactly", () => {
    const names = [NAME, "lint", "-starts-with-dash", "=eq", "it's", 'say "hi"', "a;b|c&d", "$HOME `x`", "glob*?[x]", "tab\there", "ümlaut", "a\\b", "  spaced  ", "100%", "it's done!"];
    for (const name of names) {
      const words = readShellWords(`${shellWord(name)} next`);
      expect({ name, word: words[0] }).toEqual({ name, word: { text: name, exact: true } });
    }
    for (let n = 0; n < 500; n++) {
      const name = Array.from({ length: 1 + (n % 17) }, (_, i) => String.fromCharCode(32 + ((n * 31 + i * 7) % 95))).join("");
      expect(readShellWords(shellWord(name))[0]).toEqual({ text: name, exact: true });
    }
    expect(shellWord("lint")).toBe("lint");
    expect(shellWord(NAME)).toBe(`'${NAME}'`);
    expect(shellWord(`it's "$x"`)).toBe(`"it's \\"\\$x\\""`);
  });
});

describe("the CLI and the leader settings", () => {
  test("merge takes --allow-red once, with commas kept, and refuses a repeat", () => {
    const parsed = parseArgv(["merge", "T1", "--allow-red", "a, b (c)"], POLICY_VERBS);
    expect(parsed.command?.args["allow-red"]).toBe("a, b (c)");
    expect(code(() => parseArgv(["merge", "T1", "--allow-red", "a", "--allow-red=b"], POLICY_VERBS))).toBe("bad_args");
  });

  test("assumption: a waiver prompts from Claude's own rules even if the hook's ask is lost", () => {
    expect(LEADER_PERMISSIONS.ask).toContain("Bash(flowryn merge *allow-red*)");
    expect(LEADER_PERMISSIONS.ask.some((rule) => rule.startsWith("Bash(flowryn merge *") && !rule.includes("allow-red"))).toBe(false);
  });
});

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { number: 1, url: "https://github.com/acme/web/pull/1", title: "t", state: "open", draft: false, headSha: "h1", headRef: "flowryn/t", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: null, ...over };
}

const oneRed = summarize([
  { name: "ci", state: "green", detail: "success" },
  { name: NAME, state: "red", detail: "failure" },
]);

function facts(over: Partial<MergeFacts> = {}, sensitive = 0): MergeFacts {
  const run = { id: "r1", task_id: "t", sensitive, branch: "flowryn/t", state: "ready" } as unknown as RunWithPolicy;
  const project = { id: "web", path: "/p", default_branch: "main" } as unknown as ProjectRow;
  return {
    run,
    project,
    delivered: { kind: "pr", ref: "https://github.com/acme/web/pull/1", head: "h1", at: 0 },
    ref: "https://github.com/acme/web/pull/1",
    head: "h1",
    title: "t",
    pr: pr(),
    checks: oneRed,
    remote: "h1",
    primaryBranch: null,
    primaryDirty: false,
    fastForward: false,
    ...over,
  };
}

const attempt = (allowRed: string | null): ApprovalChoice => ({ kind: "attempt", attempt: { id: "x", allow_red_check: allowRed, head_sha: "h1" } as AttemptRow, session: "L1" });
const key = (allowRed: string | null): ApprovalChoice => ({ kind: "key", session: "L1", allowRed });
const asked = (choice: ApprovalChoice | null, allowRed: string | null, why = ""): ChoiceResult => ({ choice, why, allowRed });

describe("the merge gate with a waiver from the leader's channels", () => {
  test("a Claude prompt or a Pi confirm that named the one failing check waives it", () => {
    expect(checkGate(facts(), asked(attempt(NAME), NAME)).waived).toBe(NAME);
    expect(checkGate(facts(), asked(key(NAME), NAME)).waived).toBe(NAME);
  });

  test("assumption: yolo never waives, even when the merge asks for it", () => {
    expect(code(() => checkGate(facts(), asked({ kind: "yolo" }, NAME)))).toBe("red_checks");
  });

  test("a waiver for the one failing check with no approval asks for one, carrying why", () => {
    const refused = thrown(() => checkGate(facts(), asked(null, NAME, "the approval key is not this lease's; waiving needs your word")));
    expect(refused.code).toBe("approval_required");
    expect(refused.message).toContain("the approval key is not this lease's");
    expect(refused.help).toContain(`flowryn approve t --allow-red '${NAME}'`);
  });

  test("the named check must be the only one failing now", () => {
    const green = summarize([{ name: "ci", state: "green", detail: "success" }]);
    expect(thrown(() => checkGate(facts({ checks: green }), asked(attempt(NAME), NAME))).message).toContain("no check is failing");
    expect(code(() => checkGate(facts(), asked(attempt("ci"), "ci")))).toBe("red_checks");
    const twoRed = summarize([
      { name: "ci", state: "red", detail: "failure" },
      { name: NAME, state: "red", detail: "failure" },
    ]);
    expect(code(() => checkGate(facts({ checks: twoRed }), asked(attempt(NAME), NAME)))).toBe("red_checks");
    const local = { delivered: { kind: "local" as const, ref: "flowryn/t", head: "h1", at: 0 }, ref: "local:flowryn/t", pr: null, checks: null, remote: null, primaryBranch: "main", fastForward: true };
    expect(thrown(() => checkGate(facts(local), asked(attempt(NAME), NAME))).message).toContain("no checks to waive");
  });

  test("the refusal's hint quotes the check for the shell and names the leader's way first", () => {
    const refused = thrown(() => checkGate(facts(), asked(attempt(null), null)));
    expect(refused.code).toBe("red_checks");
    expect(refused.help).toContain(`flowryn merge t --allow-red '${NAME}'`);
    expect(refused.help).toContain(`flowryn approve t --allow-red '${NAME}'`);
  });
});

function seed(d: Db, yolo: number, harness: "claude" | "pi" = "claude"): void {
  tx(d, () => {
    d.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', 'x', '/p', 'main', 'direct-PR', ?1)").run(yolo);
    d.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t', 'web', 'ship', 'direct-PR', ?1, 'fix', 0)").run(yolo);
    d.query("INSERT INTO leader_sessions (session_id, harness, token_hash) VALUES ('L1', ?1, 'x')").run(harness);
  });
}

const leader = { role: "leader" as const, runId: null, taskId: null, session: "L1" };

const record = (d: Db, allowRed: string | null, now: number, mode = "auto") =>
  tx(d, () => recordAttempt(d, { session: "L1", toolUseId: "t1", action: "merge", task: "t", permissionMode: mode, prUrl: facts().ref, head: "h1", allowRed, now }));

describe("choosing and recording the approval", () => {
  test("assumption: a plain-merge prompt is never a waiver, and a waiver prompt is never a plain merge", () => {
    const d = freshDb();
    seed(d, 0);
    const now = 7_000_000;
    record(d, null, now);
    expect(chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", now).choice).toBeNull();
    tx(d, () => voidPendingAttempts(d, "L1", now));
    record(d, NAME, now);
    expect(chooseApproval(d, facts(), { caller: leader }, "merge", now).choice).toBeNull();
    expect(findAttempt(d, { session: "L1", action: "merge", task: "t", now, allowRed: "ci" })).toBeNull();
    const chosen = chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", now);
    expect(chosen.choice?.kind).toBe("attempt");
    expect(chosen.allowRed).toBe(NAME);
    expect(checkGate(facts(), chosen).waived).toBe(NAME);
  });

  test("a waiver prompt under bypassPermissions never counts", () => {
    const d = freshDb();
    seed(d, 0);
    record(d, NAME, 7_000_000, "bypassPermissions");
    expect(chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", 7_000_000).choice).toBeNull();
  });

  test("on a yolo project a waiver still needs your word: no yolo choice", () => {
    const d = freshDb();
    seed(d, 1);
    const chosen = chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", 7_000_000);
    expect(chosen.choice).toBeNull();
    expect(chosen.why).toContain("yolo never waives");
    expect(chooseApproval(d, facts(), { caller: leader }, "merge", 7_000_000).choice?.kind).toBe("yolo");
  });

  test("a standing shell record is used for a waiver only if it waives that same check", () => {
    const d = freshDb();
    seed(d, 0);
    const now = 7_000_000;
    tx(d, () => insertApproval(d, { task: "t", ref: facts().ref, head: "h1", channel: "cli-tty", actor: "me", action: "merge", now }));
    expect(chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", now).choice).toBeNull();
    tx(d, () => insertApproval(d, { task: "t", ref: facts().ref, head: "h1", channel: "cli-tty", actor: "me", action: "merge", allowRed: NAME, now: now + 1 }));
    const chosen = chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", now + 2);
    expect(chosen.choice?.kind).toBe("row");
    expect(checkGate(facts(), chosen).waived).toBe(NAME);
  });

  test("the merge records a single-use claude-ask approval carrying the waiver, bound to the head, expiring in 24 h", () => {
    const d = freshDb();
    seed(d, 0);
    const now = 7_000_000;
    record(d, NAME, now);
    const chosen = chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", now);
    const id = tx(d, () => takeApproval(d, facts(), chosen.choice!, "merge", now));
    const row = d.query("SELECT channel, allow_red_check, head_sha, consumed_at, expires_at FROM approvals WHERE id = ?1").get(id);
    expect(row).toEqual({ channel: "claude-ask", allow_red_check: NAME, head_sha: "h1", consumed_at: now, expires_at: now + 24 * 60 * 60 * 1000 });
    expect(code(() => tx(d, () => takeApproval(d, facts(), chosen.choice!, "merge", now)))).toBe("approval_required");
    expect(chooseApproval(d, facts(), { caller: leader, allowRed: NAME }, "merge", now).choice).toBeNull();
  });

  test("a Pi confirm's waiver is recorded as pi-confirm", () => {
    const d = freshDb();
    seed(d, 0, "pi");
    const id = tx(d, () => takeApproval(d, facts(), key(NAME), "merge", 7_000_000));
    expect(d.query("SELECT channel, allow_red_check FROM approvals WHERE id = ?1").get(id)).toEqual({ channel: "pi-confirm", allow_red_check: NAME });
  });
});
