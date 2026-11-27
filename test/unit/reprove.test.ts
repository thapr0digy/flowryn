import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import { gitRunner } from "../../src/policy/git.ts";
import type { CommandRunner } from "../../src/verify/laws.ts";
import { reproveProject, setupSteps, unprovenLine, type ReproveDeps } from "../../src/verify/reprove.ts";

/**
 * Laws re-proved on a schedule (docs/notes/2026-11-27-phase-corrections-become-jx.md): each law's
 * enforcer must still pass at HEAD and still fail at its "Proven on" commit, with HEAD's enforcer
 * files laid over that commit. Real git and real `bun test`, in a fixture repository whose
 * origin/main is a local ref.
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

interface Fixture {
  repo: string;
  project: ProjectRow;
  /** The commit that made the mistake. */
  mistake: string;
  /** Commit files (null deletes) on main and move origin/main there. */
  land(files: Record<string, string | null>): string;
}

const BAD_SUM = "export const sum = (a: number, b: number) => a - b;\n";
const GOOD_SUM = "export const sum = (a: number, b: number) => a + b;\n";
const SUM_TEST = 'import { expect, test } from "bun:test";\nimport { sum } from "../src/sum.ts";\ntest("sum adds", () => expect(sum(1, 2)).toBe(3));\n';

/** The law's test, needing a file the setup makes and git ignores. */
const READY_TEST = 'import { existsSync } from "node:fs";\nimport { expect, test } from "bun:test";\nimport { sum } from "../src/sum.ts";\ntest("sum adds", () => {\n  expect(existsSync(".ready")).toBe(true);\n  expect(sum(1, 2)).toBe(3);\n});\n';

const agents = (mistake: string) =>
  [
    "# Agents",
    "",
    "## Rules and their checks",
    "",
    "| Rule | Enforced by | Proven on |",
    "|---|---|---|",
    `| sum adds | test/sum.test.ts | fails at ${mistake.slice(0, 8)}, passes at HEAD |`,
    "| The readme names the fixture | `README.md` `fixture` | - |",
    "| Lint runs | `verify: make lint` | - |",
    "",
  ].join("\n");

/** main: the mistake, then its fix with the law's test and the AGENTS.md row; origin/main at the fix. */
function fixture(): Fixture {
  const repo = join(scratch("fl-reprove-"), "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  const land = (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(repo, path);
      if (text === null) unlinkSync(full);
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "change"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return git(repo, ["rev-parse", "HEAD"]);
  };
  const mistake = land({ "README.md": "fixture\n", "src/sum.ts": BAD_SUM });
  land({ "src/sum.ts": GOOD_SUM, "test/sum.test.ts": SUM_TEST, "AGENTS.md": agents(mistake) });
  return { repo, project: { id: "web", path: repo, default_branch: "main" } as ProjectRow, mistake, land };
}

const realRun: CommandRunner = async (argv, opts) => {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, env: opts.env });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

function deps(f: Fixture, run: CommandRunner = realRun): ReproveDeps {
  return { git: gitRunner("git", 30_000), run, dir: join(dirname(f.repo), "reprove"), env: { PATH: process.env.PATH!, HOME: process.env.HOME! }, steps: ["make lint"], setup: [], teardown: [], log: () => {}, timeoutMs: 60_000 };
}

function worktrees(repo: string): number {
  return git(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length;
}

describe("re-proving a project's laws", () => {
  test("a law whose test fails at its commit and passes at HEAD is proven; one with nothing to run, or no commit recorded, holds; the checkout is removed after", async () => {
    const f = fixture();
    const out = await reproveProject(deps(f), f.project);
    expect(out.skipped).toBeNull();
    expect(out.head).toBe(git(f.repo, ["rev-parse", "origin/main"]));
    expect(out.laws).toEqual([
      { rule: "sum adds", state: "proven", detail: `fails at ${f.mistake.slice(0, 8)}, passes at HEAD` },
      { rule: "The readme names the fixture", state: "holds", detail: "README.md is there and names fixture at HEAD; nothing runs to re-prove at a commit" },
      { rule: "Lint runs", state: "holds", detail: "verify step make lint at HEAD; nothing runs to re-prove at a commit" },
    ]);
    expect(unprovenLine(out)).toBeNull();
    expect(worktrees(f.repo)).toBe(1);
    expect(existsSync(join(deps(f).dir, "web"))).toBe(false);
  });

  test("a law whose test was emptied is reported by the next re-prove", async () => {
    const f = fixture();
    f.land({ "test/sum.test.ts": "" });
    const out = await reproveProject(deps(f), f.project);
    expect(out.laws[0]).toEqual({ rule: "sum adds", state: "unproven", detail: "at HEAD: bun test test/sum.test.ts ran no tests" });
    expect(unprovenLine(out)).toStartWith(`Laws no longer proven in web (1 of 3, re-proved at ${out.head!.slice(0, 8)}): sum adds: at HEAD: bun test test/sum.test.ts ran no tests`);
  });

  test("a law whose test was weakened, so it passes at the mistake's commit too, is reported", async () => {
    const f = fixture();
    f.land({ "test/sum.test.ts": 'import { expect, test } from "bun:test";\nimport { sum } from "../src/sum.ts";\ntest("sum adds", () => expect(typeof sum(1, 2)).toBe("number"));\n' });
    const out = await reproveProject(deps(f), f.project);
    expect(out.laws[0]).toEqual({ rule: "sum adds", state: "unproven", detail: `bun test test/sum.test.ts passes at ${f.mistake.slice(0, 8)}: it no longer fails where the mistake was` });
  });

  test("a law whose enforcer vanished, or whose verify step is gone, is reported", async () => {
    const f = fixture();
    f.land({ "test/sum.test.ts": null });
    const out = await reproveProject({ ...deps(f), steps: [] }, f.project);
    expect(out.laws.map((l) => [l.state, l.detail])).toEqual([
      ["unproven", "at HEAD: test/sum.test.ts does not exist"],
      ["holds", "README.md is there and names fixture at HEAD; nothing runs to re-prove at a commit"],
      ["unproven", "at HEAD: verify: make lint is not one of the project's verify steps"],
    ]);
  });

  test("a Go package's test files from HEAD are laid over the old commit, and its tests run there", async () => {
    const f = fixture();
    const fixed = f.land({ "AGENTS.md": agents(f.mistake).replace("test/sum.test.ts", "`internal/x` `TestX`"), "internal/x/x.go": "package x\n", "internal/x/x_test.go": "package x\nfunc TestX(t *testing.T) {}\n" });
    const seen: { argv: string[]; hasTest: boolean; hasCode: boolean }[] = [];
    const run: CommandRunner = async (argv, opts) => {
      const hasCode = existsSync(join(opts.cwd, "internal/x/x.go"));
      seen.push({ argv: argv.slice(1), hasTest: existsSync(join(opts.cwd, "internal/x/x_test.go")), hasCode });
      return { code: hasCode ? 0 : 1, stdout: "ok", stderr: "" };
    };
    // The command must resolve on the verify PATH; the runner above stands in for it.
    const bin = scratch("fl-reprove-bin-");
    writeFileSync(join(bin, "go"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const out = await reproveProject({ ...deps(f, run), env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME! } }, f.project);
    expect(out.laws[0]).toEqual({ rule: "sum adds", state: "proven", detail: `fails at ${f.mistake.slice(0, 8)}, passes at HEAD` });
    expect(seen).toEqual([
      { argv: ["test", "-count=1", "-run", "^(TestX)$", "./internal/x"], hasTest: true, hasCode: true },
      { argv: ["test", "-count=1", "-run", "^(TestX)$", "./internal/x"], hasTest: true, hasCode: false },
    ]);
    expect(fixed).toBe(out.head!);
  });

  test("the laws run after the project's verify steps, as verify's laws step does: what the setup leaves (ignored files) is there at HEAD and kept across checkouts; the teardown runs after", async () => {
    const f = fixture();
    // The law's test needs what the setup makes, as appsec-signal's need make pg-test-up's server.
    f.land({ ".gitignore": ".ready\n", "test/sum.test.ts": READY_TEST });
    const released = join(scratch("fl-reprove-release-"), "released");
    const lines: string[] = [];
    const without = await reproveProject(deps(f), f.project);
    expect(without.laws[0]!.state).toBe("unproven");
    const out = await reproveProject({ ...deps(f), setup: ["printf ok > .ready", "test -s .ready"], teardown: [["touch", released]], log: (l) => lines.push(l) }, f.project);
    expect(out.laws[0]).toEqual({ rule: "sum adds", state: "proven", detail: `fails at ${f.mistake.slice(0, 8)}, passes at HEAD` });
    expect(existsSync(released)).toBe(true);
    expect(lines).toEqual([`reprove web: release touch ${released} done`]);
    expect(existsSync(join(deps(f).dir, "web"))).toBe(false);
  });

  test("when the setup fails, a law with a command to run could not run, with why, and is never reported as no longer proven; the teardown still runs", async () => {
    const f = fixture();
    const released = join(scratch("fl-reprove-release-"), "released");
    const out = await reproveProject({ ...deps(f), setup: ["echo 'test database unreachable (run make pg-test-up)' >&2; exit 2", "touch never"], teardown: [["touch", released]] }, f.project);
    expect(out.laws).toEqual([
      { rule: "sum adds", state: "unrun", detail: "could not run: verify step echo 'test database unreachable (run make pg-test-up)' >&2; exit 2 failed (exit 2): test database unreachable (run make pg-test-up)" },
      { rule: "The readme names the fixture", state: "holds", detail: "README.md is there and names fixture at HEAD; nothing runs to re-prove at a commit" },
      { rule: "Lint runs", state: "holds", detail: "verify step make lint at HEAD; nothing runs to re-prove at a commit" },
    ]);
    expect(unprovenLine(out)).toBeNull();
    expect(existsSync(released)).toBe(true);
  });

  test("the setup is the verify steps but the review and the when_changed steps, which a verify of HEAD against itself skips", () => {
    expect(setupSteps(null)).toEqual([]);
    expect(setupSteps({ steps: ["bun install", ["bun run typecheck", "npx oxlint"], "./dist/flowryn doctor", "flowryn:review", "bun test"], when_changed: [null, null, null, ["src/**"], null, null] })).toEqual(["bun install", "bun run typecheck", "npx oxlint", "bun test"]);
  });

  test("a project whose origin branch or AGENTS.md table is missing is skipped with why", async () => {
    const f = fixture();
    expect((await reproveProject(deps(f), { ...f.project, default_branch: "trunk" })).skipped).toBe(`origin/trunk cannot be read in ${f.repo}`);
    f.land({ "AGENTS.md": null });
    expect((await reproveProject(deps(f), f.project)).skipped).toBe("no AGENTS.md");
    f.land({ "AGENTS.md": "# Agents\n" });
    expect((await reproveProject(deps(f), f.project)).skipped).toBe("no ## Rules and their checks table");
  });
});
