import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bumpVersion, defaultBase, versionMixProblems, writeRelease } from "../../scripts/release.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function source(version: string, proto = 6): string {
  return `export const VERSION = "${version}";\n\nexport const PROTO = ${proto};\n`;
}

function pkg(version: string, extra = ""): string {
  return `{\n  "name": "flowryn",\n  "version": "${version}",\n  "private": true${extra}\n}\n`;
}

/** A scratch repository on main at 1.2.0, with origin/main pointing at that first commit. */
function scratchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fw-release-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, { "src/version.ts": source("1.2.0"), "package.json": pkg("1.2.0"), "README.md": "hi\n" });
  commit(repo, "init");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    Bun.spawnSync(["mkdir", "-p", join(repo, path, "..")]);
    writeFileSync(join(repo, path), text);
  }
}

function commit(repo: string, subject: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", subject);
}

describe("bumpVersion", () => {
  test("bumps one field and resets the lower ones", () => {
    expect(bumpVersion("0.24.3", "patch")).toBe("0.24.4");
    expect(bumpVersion("0.24.3", "minor")).toBe("0.25.0");
    expect(bumpVersion("0.24.3", "major")).toBe("1.0.0");
  });

  test("refuses a version that is not MAJOR.MINOR.PATCH", () => {
    expect(() => bumpVersion("0.24", "patch")).toThrow("not MAJOR.MINOR.PATCH");
  });
});

describe("writeRelease", () => {
  test("writes the same new version into src/version.ts and package.json, leaving PROTO", () => {
    const repo = scratchRepo();
    expect(writeRelease(repo, "minor")).toEqual({ from: "1.2.0", to: "1.3.0" });
    expect(readFileSync(join(repo, "src/version.ts"), "utf8")).toBe(source("1.3.0"));
    expect(readFileSync(join(repo, "package.json"), "utf8")).toBe(pkg("1.3.0"));
  });

  test("refuses when the two files disagree", () => {
    const repo = scratchRepo();
    write(repo, { "package.json": pkg("1.1.0") });
    expect(() => writeRelease(repo, "patch")).toThrow("is not");
  });
});

describe("versionMixProblems", () => {
  test("a release commit that changes only the version files passes", () => {
    const repo = scratchRepo();
    writeRelease(repo, "minor");
    commit(repo, "Release 1.3.0");
    expect(versionMixProblems(repo, "origin/main")).toEqual([]);
  });

  test("a feature commit that also bumps the version fails, naming the commit and the other files", () => {
    const repo = scratchRepo();
    write(repo, { "src/version.ts": source("1.3.0"), "package.json": pkg("1.3.0"), "src/feature.ts": "export {};\n" });
    commit(repo, "Add a feature");
    const problems = versionMixProblems(repo, "origin/main");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('("Add a feature"): the version changes (1.2.0 → 1.3.0) together with src/feature.ts');
  });

  test("a bump in package.json alone, with other files, fails too", () => {
    const repo = scratchRepo();
    write(repo, { "package.json": pkg("1.3.0"), "README.md": "changed\n" });
    commit(repo, "Bump package only");
    expect(versionMixProblems(repo, "origin/main")).toHaveLength(1);
  });

  test("a feature commit that bumps the version, followed by a commit that reverts the bump, passes", () => {
    const repo = scratchRepo();
    write(repo, { "src/version.ts": source("1.3.0"), "package.json": pkg("1.3.0"), "src/feature.ts": "export {};\n" });
    commit(repo, "Add a feature");
    expect(versionMixProblems(repo, "origin/main")).toHaveLength(1);
    write(repo, { "src/version.ts": source("1.2.0"), "package.json": pkg("1.2.0") });
    commit(repo, "Revert the version bump");
    expect(versionMixProblems(repo, "origin/main")).toEqual([]);
  });

  test("feature commits that leave the version alone pass, a PROTO bump and a dependency change included", () => {
    const repo = scratchRepo();
    write(repo, { "src/version.ts": source("1.2.0", 7), "package.json": pkg("1.2.0", ',\n  "dependencies": {}'), "src/feature.ts": "export {};\n" });
    commit(repo, "Change the wire format");
    expect(versionMixProblems(repo, "origin/main")).toEqual([]);
  });

  test("a stale base: main's release commit, merged into the branch, is not the branch's mix", () => {
    const repo = scratchRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, { "src/feature.ts": "export {};\n" });
    commit(repo, "Add a feature");
    git(repo, "checkout", "-q", "main");
    writeRelease(repo, "patch");
    commit(repo, "Release 1.2.1");
    git(repo, "checkout", "-q", "feature");
    git(repo, "-c", "user.name=t", "merge", "-q", "--no-edit", "main");
    // origin/main still points at the first commit, so the release is inside base..HEAD.
    expect(versionMixProblems(repo, "origin/main")).toEqual([]);
  });

  test("uncommitted changes that bump the version beside other files are named", () => {
    const repo = scratchRepo();
    write(repo, { "src/version.ts": source("1.3.0"), "README.md": "changed\n" });
    const problems = versionMixProblems(repo, "origin/main");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("uncommitted changes: the version changes (1.2.0 → 1.3.0) together with README.md");
  });
});

const checkout = resolve(import.meta.dir, "../..");
const base = defaultBase(checkout);

// Needs the default branch's remote ref: a shallow clone or a copy outside git has none to compare with.
test.skipIf(base === null)("this checkout: no commit since the default branch mixes a version change with other files", () => {
  expect(versionMixProblems(checkout, base!)).toEqual([]);
});
