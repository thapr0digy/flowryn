import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Caller, ReadCtx } from "../../src/api/verbs.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease } from "../../src/sched/pools.ts";
import { LAWS_STEP, lightVerifyConfig, REVIEW_STEP, verifyConfig } from "../../src/verify/config.ts";
import { BUILT_IN_LAWS } from "../../src/policy/global-laws.ts";
import { BUILT_IN, checkLaws, lawsSummary, parseEnforcers, parseLaws, provenCommits, readGlobalLaws, type CommandRunner } from "../../src/verify/laws.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { initialSteps, lawsStepResult, runVerification } from "../../src/verify/runner.ts";
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
    expect(parseEnforcers("the hook: `hook: force-push`; `verify: make lint`")).toEqual({
      enforcers: [
        { kind: "hook", rule: "force-push" },
        { kind: "verify", step: "make lint" },
      ],
    });
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

  test("a check stopped before every law is checked says so and is no pass", async () => {
    const r = repoWith({ "t/a.test.ts": PASSING_TEST });
    r.commit({ "AGENTS.md": table([`| One | t/a.test.ts | fails at ${r.base.slice(0, 8)} |`, `| Two | t/a.test.ts | fails at ${r.base.slice(0, 8)} |`]) });
    const stop = new AbortController();
    stop.abort();
    const out = await checkLaws({ git: gitRunner("git", 30_000), run: realRun, worktree: r.repo, base: "main", steps: [], env, deadline: Date.now() + 120_000, now: Date.now, signal: stop.signal });
    expect(out).toMatchObject({ aborted: true, laws: [], error: null });
    expect(lawsStepResult(out)).toEqual({ exit: 1, laws: undefined, summary: "laws: stopped after 0 laws checked" });
  });

  test("a check stopped mid-law records no per-law results, so `flowryn laws` never shows the cut-off law as failed", () => {
    const cut = { rule: "One", state: "failed" as const, detail: "bun test t/a.test.ts exited 125" };
    expect(lawsStepResult({ note: null, laws: [cut], error: null, log: "", aborted: true })).toEqual({ exit: 1, laws: undefined, summary: "laws: stopped after 1 law checked" });
    const held = { rule: "One", state: "passed" as const, detail: "bun test t/a.test.ts passed" };
    expect(lawsStepResult({ note: null, laws: [held], error: null, log: "", aborted: false })).toEqual({ exit: 0, laws: [held], summary: "1 law holds" });
  });

  test("a failing test enforcer fails its law, with the test's output in the log", async () => {
    const r = repoWith({});
    r.commit({ "AGENTS.md": table([`| Breaks | t/b.test.ts | fails at ${r.base.slice(0, 8)} |`]), "t/b.test.ts": FAILING_TEST });
    const out = await lawsOf(r.repo);
    expect(out.laws[0]).toMatchObject({ state: "failed", detail: "bun test t/b.test.ts exited 1" });
    expect(out.log).toContain("--- bun test t/b.test.ts exited 1");
  });

  test("a test enforcer that runs no test fails its law: an emptied test passes but proves nothing", async () => {
    const r = repoWith({});
    r.commit({ "AGENTS.md": table([`| Emptied | t/e.test.ts | fails at ${r.base.slice(0, 8)} |`, `| Kept | t/k.test.ts | fails at ${r.base.slice(0, 8)} |`]), "t/e.test.ts": "", "t/k.test.ts": PASSING_TEST });
    const out = await lawsOf(r.repo);
    expect(out.laws.map((l) => [l.state, l.detail])).toEqual([
      ["failed", "bun test t/e.test.ts ran no tests: an emptied test proves nothing"],
      ["passed", "bun test t/k.test.ts passed"],
    ]);
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

/** A project whose verify is ["true"], verified at a head of `r` the way the daemon runs it, in a Flowryn home with no global laws file of its own. */
function verifyFixture(r: Repo) {
  const dir = scratch("fl-laws-v-");
  const config = parseConfig("", dir);
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
    await runVerification({ db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root, config: () => config }, v, { prNumber: 1, headRef: "feature", binary: null, timeoutMs: 120_000, path: null, base: "main" }, env);
    return getVerification(db, v.id)!;
  };
  return { db, cfg, run, home: dir, config };
}

const GLOBALS = BUILT_IN_LAWS.length;

describe("the laws step in verify", () => {
  test("every project's verify ends with the laws step; the light check has none", () => {
    const cfg = verifyConfig(parseConfig('[projects.web]\nlanding = "batch"\nverify = ["true"]\nlight_verify = ["true"]\n', "/h"), "web")!;
    expect(initialSteps(cfg.steps, cfg.when_changed, cfg.laws).map((s) => [s.name, s.group])).toEqual([
      ["true", 0],
      [LAWS_STEP, 1],
    ]);
    expect(lightVerifyConfig(cfg)?.laws).toBeUndefined();
  });

  test("the laws step runs before a review step, so a broken table fails before the paid review", () => {
    const cfg = verifyConfig(parseConfig('[projects.web]\nverify = ["make build", { review = true }, { run = "make test", when_changed = ["src/**"] }]\n', "/h"), "web")!;
    expect(initialSteps(cfg.steps, cfg.when_changed, cfg.laws).map((s) => [s.name, s.group, s.when_changed ?? null])).toEqual([
      ["make build", 0, null],
      [LAWS_STEP, 1, null],
      [REVIEW_STEP, 2, null],
      ["make test", 3, ["src/**"]],
    ]);
  });

  test("a row pointing at a missing test fails verify; the fixed row passes, and `flowryn laws` shows each law's last result", async () => {
    const r = repoWith({});
    const at = r.base.slice(0, 8);
    const f = verifyFixture(r);
    const broken = r.commit({ "AGENTS.md": table([`| No dismiss of an open question | test/unit/dismiss.test.ts | fails at ${at} |`]) });
    const failed = await f.run(broken);
    expect(failed.state).toBe("failed");
    const step = failed.steps.find((s) => s.name === LAWS_STEP)!;
    expect(step).toMatchObject({ state: "failed", exit: 1, tests: null });
    expect(step.laws!.filter((l) => l.global)).toHaveLength(GLOBALS);
    expect(step.laws!.at(-1)).toEqual({ rule: "No dismiss of an open question", state: "failed", detail: "test/unit/dismiss.test.ts does not exist" });
    expect(failed.detail).toContain(`1 of ${GLOBALS + 1} laws failed; first: No dismiss of an open question: test/unit/dismiss.test.ts does not exist`);

    const fixed = r.commit({ "test/unit/dismiss.test.ts": PASSING_TEST });
    const passed = await f.run(fixed);
    expect(passed.state).toBe("passed");
    const held = passed.steps.find((s) => s.name === LAWS_STEP)!;
    expect(held).toMatchObject({ state: "passed", detail: `${GLOBALS + 1} laws hold` });
    expect(held.laws!.at(-1)).toEqual({ rule: "No dismiss of an open question", state: "passed", detail: "bun test test/unit/dismiss.test.ts passed" });

    const spec = VERIFY_VERBS.find((v) => v.name === "laws")!;
    const caller: Caller = { role: "human", runId: null, taskId: null };
    git(r.repo, ["checkout", "-q", "feature"]);
    const ctx: ReadCtx = { db: f.db, config: f.config, now: Date.now(), caller };
    const data = spec.read!(ctx, { project: "web" }).data as { laws: Record<string, string>[] };
    expect(data).toMatchObject({ project: "web", file: join(r.repo, "AGENTS.md"), global_file: join(f.home, "laws.md"), summary: `${GLOBALS} global and 1 project; 0 failed; last checked in ${passed.id} at ${fixed.slice(0, 8)}` });
    expect(data.laws[0]).toEqual({ scope: "global", where: BUILT_IN, rule: BUILT_IN_LAWS[0]!.rule, enforced_by: `\`hook: ${BUILT_IN_LAWS[0]!.hook}\``, proven_on: expect.stringContaining("global-laws.test.ts"), last: "passed", detail: `hook rule ${BUILT_IN_LAWS[0]!.hook}` });
    expect(data.laws.at(-1)).toEqual({ scope: "project", where: "AGENTS.md:7", rule: "No dismiss of an open question", enforced_by: "test/unit/dismiss.test.ts", proven_on: `fails at ${at}`, last: "passed", detail: "bun test test/unit/dismiss.test.ts passed" });
  });

  test("a project with no table passes verify, the step saying so", async () => {
    const r = repoWith({});
    const head = r.commit({ "src/x.ts": "export {};\n" });
    const v = await verifyFixture(r).run(head);
    expect(v.state).toBe("passed");
    expect(v.steps.find((s) => s.name === LAWS_STEP)).toMatchObject({ state: "passed", detail: `${GLOBALS} global laws hold; no laws: AGENTS.md has no ## Rules and their checks table` });
  });

  test("a global law in the home's laws.md is checked on every project: one naming no real hook rule fails verify, and `flowryn laws` shows it", async () => {
    const r = repoWith({});
    const head = r.commit({ "src/x.ts": "export {};\n" });
    const f = verifyFixture(r);
    writeFileSync(join(f.home, "laws.md"), table(["| Never push to main by hand | `hook: no-main-push` | - |"]));
    const v = await f.run(head);
    expect(v.state).toBe("failed");
    const step = v.steps.find((s) => s.name === LAWS_STEP)!;
    expect(step.laws!.at(-1)).toEqual({ rule: "Never push to main by hand", state: "failed", detail: expect.stringContaining("hook: no-main-push is not a rule of Flowryn's tool-call hook"), global: true });
    expect(v.detail).toContain(`1 of ${GLOBALS + 1} laws failed; first: global: Never push to main by hand`);

    // Named by a real rule, the same row holds.
    writeFileSync(join(f.home, "laws.md"), table(["| Never push to main by hand | `hook: force-push` | - |"]));
    expect((await f.run(head)).state).toBe("passed");

    const spec = VERIFY_VERBS.find((verb) => verb.name === "laws")!;
    const data = spec.read!({ db: f.db, config: f.config, now: Date.now(), caller: { role: "human", runId: null, taskId: null } }, { project: "web" }).data as { laws: Record<string, string>[]; summary: string };
    expect(data.laws.at(-1)).toMatchObject({ scope: "global", where: `${join(f.home, "laws.md")}:7`, rule: "Never push to main by hand", last: "passed" });
    expect(data.summary).toStartWith(`${GLOBALS + 1} global and no project laws`);
  });
});

describe("global laws", () => {
  test("the built-in rows, then the home file's; a broken home file is one failed law", () => {
    const home = scratch("fl-laws-home-");
    const file = join(home, "laws.md");
    expect(readGlobalLaws(file)).toMatchObject({ file, error: null, laws: BUILT_IN_LAWS.map((l) => ({ rule: l.rule, enforced_by: `\`hook: ${l.hook}\``, file: BUILT_IN })) });
    writeFileSync(file, "## Rules and their checks\n\n| Rule | Check |\n|---|---|\n");
    expect(readGlobalLaws(file).error).toContain("Rule | Enforced by | Proven on");
  });

  test("a global row names hook rules or verify steps only; its Proven on is not checked", async () => {
    const r = repoWith({});
    const global = {
      file: "/h/laws.md",
      error: null,
      laws: [
        { rule: "Hooked", enforced_by: "`hook: tags`", proven_on: "-", line: 7, file: "/h/laws.md" },
        { rule: "Stepped", enforced_by: "`verify: make lint`", proven_on: "-", line: 8, file: "/h/laws.md" },
        { rule: "A file", enforced_by: "test/unit/x.test.ts", proven_on: "fails at 0000000", line: 9, file: "/h/laws.md" },
        { rule: "Prose", enforced_by: "a reviewer", proven_on: "-", line: 10, file: "/h/laws.md" },
      ],
    };
    const out = await checkLaws({ git: gitRunner("git", 30_000), run: realRun, worktree: r.repo, base: "main", steps: ["make lint"], global, env, deadline: Date.now() + 60_000, now: Date.now });
    expect(out.laws.map((l) => [l.rule, l.state, l.detail])).toEqual([
      ["Hooked", "passed", "hook rule tags"],
      ["Stepped", "passed", "verify step make lint"],
      ["A file", "failed", expect.stringContaining("a file belongs in one project's AGENTS.md table")],
      ["Prose", "failed", expect.stringContaining("names nothing")],
    ]);
    expect(lawsSummary(out)).toBe("2 of 4 laws failed; first: global: A file: test/unit/x.test.ts: a global law names `hook: <rule>` or `verify: <step>`; a file belongs in one project's AGENTS.md table; no laws: AGENTS.md has no ## Rules and their checks table");
    const broken = await checkLaws({ git: gitRunner("git", 30_000), run: realRun, worktree: r.repo, base: "main", steps: [], global: { file: "/h/laws.md", error: "/h/laws.md: no table", laws: [] }, env, deadline: Date.now() + 60_000, now: Date.now });
    expect(lawsStepResult(broken).exit).toBe(1);
  });
});
