import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NM_RULES, decisionsConfig, type NmRule } from "../../src/attention/decisions-policy.ts";
import { parseConfig } from "../../src/config/config.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { parseNmStatus, type NmFinding } from "../../src/policy/nomistakes.ts";
import { fileClass, findingPath, matchRules, parseHunks, parseNameStatus, readRuleFacts, type BranchDiff } from "../../src/policy/nomistakes-rules.ts";

/**
 * Settling no-mistakes ask-user findings by rule (docs/notes/2026-10-22-settle-routine-no-2r.md):
 * the file classes, the all-or-nothing match and its floors, the config, and
 * the facts read from a real git repository and a stand-in no-mistakes.
 */

function finding(id: string, severity: string, file: string, line = "", action = "ask-user", description = "something to look at"): NmFinding {
  return { id, severity, file, line, action, description, category: "" };
}

const DIFF: BranchDiff = { added: new Set(["src/new.ts", "test/new.test.ts"]), changed: new Map([["src/old.ts", [[10, 12], [40, 40]]]]) };

function verdict(step: string, findings: NmFinding[], opts: { options?: string[]; sensitive?: boolean; rules?: readonly NmRule[] } = {}) {
  return matchRules({ step, findings, diff: DIFF, worktree: "/wt", options: opts.options ?? ["approve", "fix", "skip"], sensitive: opts.sensitive ?? false }, opts.rules ?? DEFAULT_NM_RULES);
}

describe("file classes", () => {
  test("added, diff-line, touched, outside and none", () => {
    expect(fileClass("src/new.ts", "", DIFF)).toBe("added");
    expect(fileClass("src/old.ts", "11", DIFF)).toBe("diff-line");
    expect(fileClass("src/old.ts", "40", DIFF)).toBe("diff-line");
    expect(fileClass("src/old.ts", "13", DIFF)).toBe("touched");
    expect(fileClass("src/old.ts", "", DIFF)).toBe("touched");
    expect(fileClass("src/old.ts", "n/a", DIFF)).toBe("touched");
    expect(fileClass("src/other.ts", "1", DIFF)).toBe("outside");
    expect(fileClass("", "", DIFF)).toBe("none");
  });

  test("a finding's path is made repo-relative", () => {
    expect(findingPath("./src/a.ts", "/wt")).toBe("src/a.ts");
    expect(findingPath("/wt/src/a.ts", "/wt")).toBe("src/a.ts");
    expect(findingPath("/elsewhere/a.ts", "/wt")).toBe("/elsewhere/a.ts");
    expect(findingPath("  ", "/wt")).toBe("");
  });

  test("name-status: A is added; M, T and a rename's or copy's new path are changed; D is neither", () => {
    const parsed = parseNameStatus("A\tsrc/new.ts\nM\tsrc/old.ts\nR087\tsrc/was.ts\tsrc/now.ts\nC100\tsrc/a.ts\tsrc/b.ts\nD\tsrc/gone.ts\nT\tbin/x\n");
    expect([...parsed.added]).toEqual(["src/new.ts"]);
    expect([...parsed.changed].toSorted()).toEqual(["bin/x", "src/b.ts", "src/now.ts", "src/old.ts"]);
  });

  test("-U0 hunks give new-side ranges; a pure deletion adds none; a quoted path is left unread", () => {
    const text = [
      "diff --git a/src/old.ts b/src/old.ts",
      "--- a/src/old.ts",
      "+++ b/src/old.ts",
      "@@ -9,2 +10,3 @@ function f() {",
      "@@ -30 +40 @@",
      "@@ -50,4 +52,0 @@",
      "diff --git a/src/new.ts b/src/new.ts",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,5 @@",
      '+++ "b/odd\\tname.ts"',
      "@@ -1 +1 @@",
    ].join("\n");
    const ranges = parseHunks(text);
    expect(ranges.get("src/old.ts")).toEqual([[10, 12], [40, 40]]);
    expect(ranges.get("src/new.ts")).toEqual([[1, 5]]);
    expect(ranges.size).toBe(2);
  });
});

describe("the rule table", () => {
  test("a lint warning in a file the branch added is settled with fix, naming the rule and the findings", () => {
    const v = verdict("lint", [finding("lint-1", "warning", "test/new.test.ts", "3"), finding("lint-2", "warning", "./src/new.ts"), finding("lint-3", "warning", "src/x.ts", "", "auto-fix")]);
    expect(v).toMatchObject({ settled: true, answer: "fix", rules: ["lint-warning-added"] });
    if (!v.settled) throw new Error("not settled");
    expect(v.findings.map((f) => f.id)).toEqual(["lint-1", "lint-2"]);
    expect(v.words).toContain("no-mistakes axi respond --action fix --findings lint-1,lint-2");
  });

  test("a review warning on a line the branch changed, or in a file it added, is settled with fix", () => {
    expect(verdict("review", [finding("r-1", "warning", "src/old.ts", "11"), finding("r-2", "warning", "src/new.ts", "7")])).toMatchObject({ settled: true, answer: "fix", rules: ["review-warning-diff"] });
  });

  test("everything else is the user's, with the reason no rule settled it", () => {
    const reason = (v: ReturnType<typeof verdict>) => (v.settled ? "settled" : v.reason);
    expect(reason(verdict("lint", [finding("lint-1", "warning", "src/old.ts", "11")]))).toBe("no rule for lint-1 (lint warning, diff-line)");
    expect(reason(verdict("review", [finding("r-1", "warning", "src/old.ts", "13")]))).toBe("no rule for r-1 (review warning, touched)");
    expect(reason(verdict("review", [finding("r-1", "warning", "src/other.ts", "1")]))).toBe("r-1 is outside the diff");
    expect(reason(verdict("test", [finding("test-1", "warning", "")]))).toBe("test-1 names no file");
    expect(reason(verdict("review", [finding("r-1", "error", "src/new.ts")]))).toBe("error finding r-1");
    expect(reason(verdict("ci", [finding("ci-1", "warning", "src/new.ts")]))).toBe("ci gate");
    expect(reason(verdict("document", [finding("doc-1", "warning", "src/new.ts")]))).toBe("no rule for doc-1 (document warning, added)");
    expect(reason(verdict("review", [finding("r-1", "warning", "src/new.ts", "", "ask-user", "Rewrite the history of this branch to drop the commit")]))).toBe("r-1 names an irreversible step");
    expect(reason(verdict("lint", [finding("lint-1", "warning", "src/new.ts")], { sensitive: true }))).toBe("sensitive task");
    expect(reason(verdict("lint", [finding("lint-1", "warning", "src/new.ts")], { options: ["accept", "live-run-first"] }))).toBe("the rules' answer fix is not one of the options");
    expect(reason(verdict("lint", [finding("lint-1", "warning", "src/new.ts", "", "auto-fix")]))).toBe("no ask-user finding at the lint gate");
  });

  test("all or nothing: one finding no rule covers keeps the whole gate for the user", () => {
    const v = verdict("review", [finding("r-1", "warning", "src/new.ts"), finding("r-2", "warning", "src/other.ts")]);
    expect(v).toEqual({ settled: false, reason: "r-2 is outside the diff" });
  });

  test("rules that disagree settle nothing; approve and skip respond without finding ids", () => {
    const rules: NmRule[] = [
      { id: "a", step: "review", severity: "warning", file: ["added"], answer: "fix" },
      { id: "b", step: "review", severity: "info", file: ["added"], answer: "approve" },
    ];
    expect(verdict("review", [finding("r-1", "warning", "src/new.ts"), finding("r-2", "info", "src/new.ts")], { rules })).toEqual({ settled: false, reason: "the rules disagree (fix, approve)" });
    const v = verdict("review", [finding("r-2", "info", "src/new.ts")], { rules });
    expect(v).toMatchObject({ settled: true, answer: "approve", rules: ["b"] });
    if (v.settled) expect(v.words).toContain("Run no-mistakes axi respond --action approve.");
  });
});

function cfg(toml: string) {
  return decisionsConfig(parseConfig(toml, "/tmp/flowryn-config.toml"));
}

function ruleToml(fields: string): string {
  return `[decisions]\nnomistakes_rules = [{ ${fields} }]\n`;
}

describe("[decisions] nomistakes_rules", () => {
  test("absent: the user's two default rules; [] turns rules off", () => {
    expect(cfg("").nomistakes_rules.map((r) => r.id)).toEqual(["lint-warning-added", "review-warning-diff"]);
    expect(cfg("[decisions]\nnomistakes_rules = []\n").nomistakes_rules).toEqual([]);
  });

  test("a rule reads from inline tables; a single file class may be a string", () => {
    const rules = cfg('[decisions]\nnomistakes_rules = [{ id = "doc-warning-added", step = "document", severity = "warning", file = "added", answer = "fix" }]\n').nomistakes_rules;
    expect(rules).toEqual([{ id: "doc-warning-added", step: "document", severity: "warning", file: ["added"], answer: "fix" }]);
  });

  test("the floors are refused, never silently dropped", () => {
    const base = { id: '"x"', step: '"lint"', severity: '"warning"', file: '["added"]', answer: '"fix"' };
    const make = (over: Partial<typeof base>) => ruleToml(Object.entries({ ...base, ...over }).map(([k, v]) => `${k} = ${v}`).join(", "));
    expect(() => cfg(make({ step: '"ci"' }))).toThrow("always the user's");
    expect(() => cfg(make({ severity: '"error"' }))).toThrow("always the user's");
    expect(() => cfg(make({ file: '["added", "outside"]' }))).toThrow("outside the branch's diff");
    expect(() => cfg(make({ file: '["none"]' }))).toThrow("outside the branch's diff");
    expect(() => cfg(make({ file: '["elsewhere"]' }))).toThrow("file must list classes");
    expect(() => cfg(make({ answer: '"merge"' }))).toThrow("answer must be one of");
    expect(() => cfg(make({ id: '"Bad Id"' }))).toThrow("id must be");
    expect(() => cfg(ruleToml('id = "x", step = "lint", severity = "warning", file = ["added"], answer = "fix", when = "always"'))).toThrow("when is not one of");
    expect(() => cfg(`[decisions]\nnomistakes_rules = [{ id = "x", step = "lint", severity = "warning", file = ["added"], answer = "fix" }, { id = "x", step = "review", severity = "warning", file = ["added"], answer = "fix" }]\n`)).toThrow("used twice");
    expect(() => cfg('[decisions]\nnomistakes_rules = "fix everything"\n')).toThrow("must be a list");
  });
});

describe("assumption: no-mistakes v1.84.0 prints severity, file and line in a parked gate's findings", () => {
  test("the nested gate shape reads step and the full finding rows", () => {
    const text = [
      "run:",
      '  id: "01NMRULES"',
      "  branch: fm/x",
      "  status: awaiting_approval",
      "  head: abcdef12",
      "gate:",
      "  step: lint",
      "  status: awaiting_approval",
      "  findings[2]{id,severity,file,line,action,description}:",
      '    lint-1,warning,test/new.test.ts,12,ask-user,"unused import, only the lint pass may not edit tests"',
      '    lint-2,info,"",,auto-fix,"format"',
      "help[1]:",
      "  Run `no-mistakes axi respond --action fix` to fix",
      "",
    ].join("\n");
    const run = parseNmStatus(text)!;
    expect(run.gateStep).toBe("lint");
    expect(run.findings).toEqual([
      { id: "lint-1", severity: "warning", file: "test/new.test.ts", line: "12", action: "ask-user", description: "unused import, only the lint pass may not edit tests", category: "" },
      { id: "lint-2", severity: "info", file: "", line: "", action: "auto-fix", description: "format", category: "" },
    ]);
  });
});

function status(head: string, step: string, rows: string[], branch = "fm/x"): string {
  return ["run:", '  id: "01NMRULES"', `  branch: ${branch}`, "  status: awaiting_approval", `  head: ${head.slice(0, 8)}`, `  head_sha: ${head}`, "gate:", `  step: ${step}`, "  status: awaiting_approval", `  findings[${rows.length}]{id,severity,file,line,action,description}:`, ...rows.map((r) => `    ${r}`), ""].join("\n");
}

describe("the facts, from a real git repository and a stand-in no-mistakes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = gitRunner(Bun.which("git") ?? "git");
  async function run(cwd: string, ...args: string[]): Promise<string> {
    const r = await git(["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** main has src/old.ts; the branch fm/x adds test/new.test.ts and changes line 3 of src/old.ts. */
  async function repo(): Promise<{ wt: string; head: string; nm: string; statusFile: string }> {
    const root = mkdtempSync(join(tmpdir(), "nm-rules-"));
    dirs.push(root);
    const wt = join(root, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    await run(root, "init", "-q", "-b", "main", wt);
    writeFileSync(join(wt, "src/old.ts"), "a\nb\nc\nd\ne\n");
    await run(wt, "add", ".");
    await run(wt, "commit", "-qm", "base");
    await run(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
    await run(wt, "checkout", "-qb", "fm/x");
    mkdirSync(join(wt, "test"));
    writeFileSync(join(wt, "test/new.test.ts"), "x\n");
    writeFileSync(join(wt, "src/old.ts"), "a\nb\nC\nd\ne\n");
    await run(wt, "add", ".");
    await run(wt, "commit", "-qm", "work");
    const head = await run(wt, "rev-parse", "HEAD");
    const statusFile = join(root, "nm-status");
    const nm = join(root, "no-mistakes");
    writeFileSync(nm, `#!/bin/sh\n[ "$1 $2" = "axi status" ] && cat ${JSON.stringify(statusFile)}\nexit 0\n`);
    chmodSync(nm, 0o755);
    return { wt, head, nm, statusFile };
  }


  test("the gate, the added file and the changed line read from no-mistakes and git", async () => {
    const r = await repo();
    writeFileSync(r.statusFile, status(r.head, "review", ['r-1,warning,src/old.ts,3,ask-user,"tighten this"', 'r-2,warning,src/old.ts,5,ask-user,"and this"']));
    const facts = await readRuleFacts({ noMistakes: r.nm, git, timeoutMs: 5_000 }, r.wt, "main");
    if (!facts.ok) throw new Error(facts.reason);
    expect(facts.step).toBe("review");
    expect([...facts.diff.added]).toEqual(["test/new.test.ts"]);
    expect(facts.diff.changed.get("src/old.ts")).toEqual([[3, 3]]);
    expect(fileClass("src/old.ts", "3", facts.diff)).toBe("diff-line");
    expect(fileClass("src/old.ts", "5", facts.diff)).toBe("touched");
  });

  test("another branch's run, a missing base and an unreadable status each say why", async () => {
    const r = await repo();
    writeFileSync(r.statusFile, status(r.head, "lint", ['lint-1,warning,test/new.test.ts,1,ask-user,"x"'], "someone/else"));
    expect(await readRuleFacts({ noMistakes: r.nm, git, timeoutMs: 5_000 }, r.wt, "main")).toEqual({ ok: false, reason: "no parked gate of this worktree's run" });
    writeFileSync(r.statusFile, status(r.head, "lint", ['lint-1,warning,test/new.test.ts,1,ask-user,"x"']));
    expect(await readRuleFacts({ noMistakes: r.nm, git, timeoutMs: 5_000 }, r.wt, "trunk")).toEqual({ ok: false, reason: "no merge base with origin/trunk" });
    expect(await readRuleFacts({ noMistakes: null, git, timeoutMs: 5_000 }, r.wt, "main")).toEqual({ ok: false, reason: "no-mistakes is not installed" });
    const failing = join(r.wt, "..", "nm-fail");
    writeFileSync(failing, "#!/bin/sh\nexit 2\n");
    chmodSync(failing, 0o755);
    expect(await readRuleFacts({ noMistakes: failing, git, timeoutMs: 5_000 }, r.wt, "main")).toEqual({ ok: false, reason: "no-mistakes status unreadable" });
  });
});
