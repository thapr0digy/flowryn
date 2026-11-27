import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Caller, ReadCtx } from "../../src/api/verbs.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease } from "../../src/sched/pools.ts";
import { LAWS_STEP, lightVerifyConfig, verifyConfig } from "../../src/verify/config.ts";
import { checkLaws, parseEnforcers, parseLaws, provenCommits, type CommandRunner } from "../../src/verify/laws.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { initialSteps, runVerification } from "../../src/verify/runner.ts";
import { getVerification, insertVerification, type Verification } from "../../src/verify/store.ts";
import { VERIFY_VERBS } from "../../src/verify/verbs.ts";

/**
 * The laws (docs/notes/2026-11-27-phase-the-laws-ib.md): the AGENTS.md `## Rules and their checks`
 * table read by code, and the verify step that refuses a head whose table names an enforcer that
 * is not there, a test enforcer that fails, or a new row without the commit it fails at.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const table = (rows: string[]) => ["# Agents", "", "## Rules and their checks", "", "| Rule | Enforced by | Proven on |", "|---|---|---|", ...rows, "", "## After", ""].join("\n");

describe("the table", () => {
  test("no heading: no laws; the rows of the table under it, cells split outside code spans", () => {
    expect(parseLaws("# Agents\n\nnothing here\n")).toBeNull();
    const parsed = parseLaws(table(["| Pipes `a|b` and \\| stay | test/unit/x.test.ts | fails at abc1234 |", "| Two | `internal/db` `TestX` | - |"]));
    expect(parsed).toEqual({
      laws: [
        { rule: "Pipes `a|b` and | stay", enforced_by: "test/unit/x.test.ts", proven_on: "fails at abc1234", line: 7 },
        { rule: "Two", enforced_by: "`internal/db` `TestX`", proven_on: "-", line: 8 },
      ],
    });
  });

  test("a heading whose table lacks a column or its rule line is an error, not an empty table", () => {
    expect(parseLaws("## Rules and their checks\n\n| Rule | Check |\n|---|---|\n")).toEqual({ error: expect.stringContaining("Rule | Enforced by | Proven on") });
    expect(parseLaws("## Rules and their checks\n\n| Rule | Enforced by | Proven on |\n| a | b | c |\n")).toEqual({ error: expect.stringContaining("|---|") });
    expect(parseLaws("## Rules and their checks\n\nprose\n\n## Next\n| a |\n")).toEqual({ error: expect.stringContaining("no table") });
  });

  test("enforcers: bare paths with an extension, code-span paths with the names they hold, verify steps; prose is skipped", () => {
    expect(parseEnforcers("the hook, src/policy/toolkit.ts; test/integration/toolkit.test.ts")).toEqual({
      enforcers: [
        { kind: "path", path: "src/policy/toolkit.ts", names: [] },
        { kind: "path", path: "test/integration/toolkit.test.ts", names: [] },
      ],
    });
    expect(parseEnforcers("test: `internal/sqlcheck` `TestEveryDoorQueryRunsAsTheDoorRole`")).toEqual({ enforcers: [{ kind: "path", path: "internal/sqlcheck", names: ["TestEveryDoorQueryRunsAsTheDoorRole"] }] });
    expect(parseEnforcers("`.oxlintrc.json` `no-shadow`; `verify: npx oxlint`")).toEqual({
      enforcers: [
        { kind: "path", path: ".oxlintrc.json", names: ["no-shadow"] },
        { kind: "verify", step: "npx oxlint" },
      ],
    });
    expect(parseEnforcers("doc: `AGENTS.md` `never rebase`")).toEqual({ enforcers: [{ kind: "path", path: "AGENTS.md", names: ["never rebase"] }] });
    expect(parseEnforcers("a doc line, and/or a reviewer")).toEqual({ enforcers: [] });
    expect(parseEnforcers("`make lint` runs it")).toEqual({ error: expect.stringContaining("`make lint` is not a path") });
  });

  test("Proven on: the sha prefixes it names, with ^ or ~N", () => {
    expect(provenCommits("fails at `c6f5d36c^` (x) and `675d12edf^` (y), passes at HEAD")).toEqual(["c6f5d36c^", "675d12edf^"]);
    expect(provenCommits("fails at 2f31e53, passes at HEAD")).toEqual(["2f31e53"]);
    expect(provenCommits("fails at abcdef1~2")).toEqual(["abcdef1~2"]);
    expect(provenCommits("-")).toEqual([]);
  });
});

const PASSING_TEST = 'import { test } from "bun:test";\ntest("holds", () => {});\n';
const FAILING_TEST = 'import { expect, test } from "bun:test";\ntest("breaks", () => expect(1).toBe(2));\n';

interface Repo {
  repo: string;
  /** main's commit, also origin/main. */
  base: string;
  /** Commit `files` on the feature branch; returns the head. */
  commit(files: Record<string, string>): string;
}

/** A repository whose main (and origin/main) holds `baseFiles`, with a feature branch checked out. */
function repoWith(baseFiles: Record<string, string>): Repo {
  const repo = join(scratch("fl-laws-"), "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "change"]);
    return git(repo, ["rev-parse", "HEAD"]);
  };
  const base = write({ "README.md": "fixture\n", ...baseFiles });
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(repo, ["checkout", "-q", "-b", "feature"]);
  return { repo, base, commit: write };
}

const env = { PATH: process.env.PATH!, HOME: process.env.HOME! };

const realRun: CommandRunner = async (argv, opts) => {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, env: opts.env });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

function lawsOf(repo: string, run: CommandRunner = realRun, extraEnv: Record<string, string> = {}) {
  return checkLaws({ git: gitRunner("git", 30_000), run, worktree: repo, base: "main", steps: ["make lint"], env: { ...env, ...extraEnv }, deadline: Date.now() + 120_000, now: Date.now });
}

describe("checking the laws", () => {
  test("a project with no table passes with a note", async () => {
    const r = repoWith({});
    const out = await lawsOf(r.repo);
    expect(out).toMatchObject({ note: "no laws: AGENTS.md has no ## Rules and their checks table", laws: [], error: null });
  });

  test("a row recorded before laws holds without a commit; a new one without its commit is refused", async () => {
    const r = repoWith({ "AGENTS.md": table(["| Old rule | t/a.test.ts | - |"]), "t/a.test.ts": PASSING_TEST });
    r.commit({ "AGENTS.md": table(["| Old rule | t/a.test.ts | - |", "| New rule | t/a.test.ts | - |"]) });
    const out = await lawsOf(r.repo);
    expect(out.laws).toEqual([
      { rule: "Old rule", state: "passed", detail: "bun test t/a.test.ts passed" },
      { rule: "New rule", state: "failed", detail: "a new law needs Proven on: the commit its enforcer fails at" },
    ]);
  });

  test("Proven on must name a commit of the repository", async () => {
    const r = repoWith({ "t/a.test.ts": PASSING_TEST });
    r.commit({ "AGENTS.md": table([`| Real | t/a.test.ts | fails at ${r.base.slice(0, 8)}^ |`, "| Prose | t/a.test.ts | yesterday |", "| Unknown | t/a.test.ts | fails at deadbee |"]) });
    const out = await lawsOf(r.repo);
    expect(out.laws.map((l) => [l.rule, l.state, l.detail])).toEqual([
      ["Real", "failed", `Proven on names ${r.base.slice(0, 8)}^, which is not a commit of this repository`],
      ["Prose", "failed", "Proven on names no commit: write the commit the enforcer fails at, such as `fails at 2f31e53`"],
      ["Unknown", "failed", "Proven on names deadbee, which is not a commit of this repository"],
    ]);
    // The base is the repository's root commit: it has no parent, so "^" names nothing. Its own sha does.
    r.commit({ "AGENTS.md": table([`| Real | t/a.test.ts | fails at ${r.base.slice(0, 8)} |`]) });
    expect((await lawsOf(r.repo)).laws[0]!.state).toBe("passed");
  });

  test("a failing test enforcer fails its law, with the test's output in the log", async () => {
    const r = repoWith({});
    r.commit({ "AGENTS.md": table([`| Breaks | t/b.test.ts | fails at ${r.base.slice(0, 8)} |`]), "t/b.test.ts": FAILING_TEST });
    const out = await lawsOf(r.repo);
    expect(out.laws[0]).toMatchObject({ state: "failed", detail: "bun test t/b.test.ts exited 1" });
    expect(out.log).toContain("--- bun test t/b.test.ts exited 1");
  });

  test("files that hold the rule are confirmed by the names in them; verify: names a configured step", async () => {
    const r = repoWith({});
    const at = r.base.slice(0, 8);
    r.commit({
      ".oxlintrc.json": '{ "rules": { "no-shadow": "error" } }\n',
      "AGENTS.md": table([`| Lint | \`.oxlintrc.json\` \`no-shadow\`; \`verify: make lint\` | fails at ${at} |`, `| Missing name | \`.oxlintrc.json\` \`no-console\` | fails at ${at} |`, `| Wrong step | \`verify: make vet\` | fails at ${at} |`, `| Prose only | a reviewer reads it | fails at ${at} |`, `| Outside | \`../etc/passwd.txt\` | fails at ${at} |`]),
    });
    const out = await lawsOf(r.repo);
    expect(out.laws.map((l) => [l.rule, l.state, l.detail])).toEqual([
      ["Lint", "passed", ".oxlintrc.json is there and names no-shadow; verify step make lint"],
      ["Missing name", "failed", ".oxlintrc.json has no no-console"],
      ["Wrong step", "failed", "verify: make vet is not one of the project's verify steps"],
      ["Prose only", "failed", "Enforced by names nothing verify can run or confirm: a test file, a file holding the rule (`path` `name`), or `verify: <step>`"],
      ["Outside", "failed", "../etc/passwd.txt is not a path inside the repository"],
    ]);
  });

  test("a Go package with test names runs go test -run on exactly those tests, as an argument list", async () => {
    const r = repoWith({});
    const at = r.base.slice(0, 8);
    r.commit({ "internal/db/db_test.go": "package db\n\nfunc TestGrant(t *testing.T) {}\n", "AGENTS.md": table([`| Grants | test: \`internal/db\` \`TestGrant\` | fails at ${at} |`, `| Typo | \`internal/db\` \`TestGrnat\` | fails at ${at} |`]) });
    const bin = scratch("fl-laws-bin-");
    writeFileSync(join(bin, "go"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "go"), 0o755);
    const calls: string[][] = [];
    const out = await lawsOf(r.repo, async (argv) => (calls.push(argv), { code: 0, stdout: "", stderr: "" }), { PATH: `${bin}:${env.PATH}` });
    expect(calls).toEqual([[join(bin, "go"), "test", "-count=1", "-run", "^(TestGrant)$", "./internal/db"]]);
    expect(out.laws.map((l) => [l.state, l.detail])).toEqual([
      ["passed", "go test ./internal/db -run TestGrant passed"],
      ["failed", "internal/db has no test func TestGrnat"],
    ]);
  });
});

/** A project whose verify is ["true"], verified at a head of `r` the way the daemon runs it. */
function verifyFixture(r: Repo) {
  const dir = scratch("fl-laws-v-");
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  db.exec(`INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', '${r.repo}', 'main', 'direct-PR')`);
  const root = join(dir, "state", "verify");
  const cfg = verifyConfig(parseConfig('[projects.web]\nverify = ["true"]\n', "/h"), "web")!;
  const run = async (head: string): Promise<Verification> => {
    const v = tx(db, () => {
      const row = insertVerification(db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/1", task_id: null, head_sha: head, steps: initialSteps(cfg.steps, cfg.when_changed, cfg.laws), policy_id: verifyPolicyId(cfg), dir: (id) => join(root, id), worktree: (id) => join(root, id, "wt"), project_path: r.repo, source: "cli", now: Date.now() });
      grantJobLease(db, { kind: "verify", id: row.id, taskId: null }, "validation", { validation: 5 }, Date.now());
      return row;
    });
    await runVerification({ db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root }, v, { prNumber: 1, headRef: "feature", binary: null, timeoutMs: 120_000, path: null, base: "main" }, env);
    return getVerification(db, v.id)!;
  };
  return { db, cfg, run };
}

describe("the laws step in verify", () => {
  test("every project's verify ends with the laws step; the light check has none", () => {
    const cfg = verifyConfig(parseConfig('[projects.web]\nlanding = "batch"\nverify = ["true"]\nlight_verify = ["true"]\n', "/h"), "web")!;
    expect(initialSteps(cfg.steps, cfg.when_changed, cfg.laws).map((s) => [s.name, s.group])).toEqual([
      ["true", 0],
      [LAWS_STEP, 1],
    ]);
    expect(lightVerifyConfig(cfg)?.laws).toBeUndefined();
  });

  test("a row pointing at a missing test fails verify; the fixed row passes, and `flowryn laws` shows each law's last result", async () => {
    const r = repoWith({});
    const at = r.base.slice(0, 8);
    const f = verifyFixture(r);
    const broken = r.commit({ "AGENTS.md": table([`| No dismiss of an open question | test/unit/dismiss.test.ts | fails at ${at} |`]) });
    const failed = await f.run(broken);
    expect(failed.state).toBe("failed");
    const step = failed.steps.find((s) => s.name === LAWS_STEP)!;
    expect(step).toMatchObject({ state: "failed", exit: 1, tests: null, laws: [{ rule: "No dismiss of an open question", state: "failed", detail: "test/unit/dismiss.test.ts does not exist" }] });
    expect(failed.detail).toContain("1 of 1 laws failed; first: No dismiss of an open question: test/unit/dismiss.test.ts does not exist");

    const fixed = r.commit({ "test/unit/dismiss.test.ts": PASSING_TEST });
    const passed = await f.run(fixed);
    expect(passed.state).toBe("passed");
    expect(passed.steps.find((s) => s.name === LAWS_STEP)).toMatchObject({ state: "passed", detail: "1 law holds", laws: [{ state: "passed", detail: "bun test test/unit/dismiss.test.ts passed" }] });

    const spec = VERIFY_VERBS.find((v) => v.name === "laws")!;
    const caller: Caller = { role: "human", runId: null, taskId: null };
    git(r.repo, ["checkout", "-q", "feature"]);
    const ctx: ReadCtx = { db: f.db, config: parseConfig("", "/h"), now: Date.now(), caller };
    expect(spec.read!(ctx, { project: "web" }).data).toEqual({
      project: "web",
      file: join(r.repo, "AGENTS.md"),
      laws: [{ rule: "No dismiss of an open question", enforced_by: "test/unit/dismiss.test.ts", proven_on: `fails at ${at}`, last: "passed", detail: "bun test test/unit/dismiss.test.ts passed" }],
      summary: `1 law, 0 failed; last checked in ${passed.id} at ${fixed.slice(0, 8)}`,
    });
  });

  test("a project with no table passes verify, the step saying so", async () => {
    const r = repoWith({});
    const head = r.commit({ "src/x.ts": "export {};\n" });
    const v = await verifyFixture(r).run(head);
    expect(v.state).toBe("passed");
    expect(v.steps.find((s) => s.name === LAWS_STEP)).toMatchObject({ state: "passed", detail: "no laws: AGENTS.md has no ## Rules and their checks table", laws: [] });
  });
});
