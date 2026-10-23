/**
 * Releases (docs/notes/2026-10-22-remove-conflict-hotspots-24.md): feature PRs
 * never change the version, so its two lines stop being a conflict every
 * parallel PR touches. A release is its own PR from main that changes only
 * `src/version.ts` and package.json. `PROTO` is not a release field: a PR that
 * changes the wire format still bumps it.
 *
 *   bun run release <major|minor|patch>  bump VERSION and package.json together; print what merged since
 *   bun run release check [<base>]       exit 1 naming each commit that mixes a version change with other files
 *
 * `bun test` runs the check on this checkout (test/unit/release.test.ts), so
 * the local verify enforces it as well as CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const VERSION_FILE = "src/version.ts";
export const PACKAGE_FILE = "package.json";
/** The only files a commit that changes the version may touch. */
export const RELEASE_FILES: readonly string[] = [VERSION_FILE, PACKAGE_FILE];

const VERSION_LINE = /^export const VERSION = "([^"]*)";$/m;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
export const FIELDS = ["major", "minor", "patch"] as const;
export type Field = (typeof FIELDS)[number];

/** The next version: one field up, the lower ones reset to 0. */
export function bumpVersion(version: string, field: Field): string {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`version "${version}" is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (field === "major") return `${major + 1}.0.0`;
  if (field === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function versionOfSource(text: string): string | null {
  return VERSION_LINE.exec(text)?.[1] ?? null;
}

export function versionOfPackage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function git(repo: string, args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

function gitOk(repo: string, args: string[]): string {
  const r = git(repo, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err || `exit ${r.code}`}`);
  return r.out;
}

/** A file's text at a revision, or null when it does not exist there. */
function showAt(repo: string, rev: string, path: string): string | null {
  const r = git(repo, ["show", `${rev}:${path}`]);
  return r.code === 0 ? r.out : null;
}

/** The default branch's remote ref (origin/HEAD, else origin/main), or null when the checkout has neither. */
export function defaultBase(repo: string): string | null {
  const head = git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  return git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).code === 0 ? "refs/remotes/origin/main" : null;
}

interface Snapshot {
  version: string | null;
  pkg: string | null;
}

function snapshotAt(repo: string, rev: string): Snapshot {
  const source = showAt(repo, rev, VERSION_FILE);
  const pkg = showAt(repo, rev, PACKAGE_FILE);
  return { version: source === null ? null : versionOfSource(source), pkg: pkg === null ? null : versionOfPackage(pkg) };
}

function snapshotOfTree(repo: string): Snapshot {
  const read = (path: string) => {
    try {
      return readFileSync(join(repo, path), "utf8");
    } catch {
      return null;
    }
  };
  const source = read(VERSION_FILE);
  const pkg = read(PACKAGE_FILE);
  return { version: source === null ? null : versionOfSource(source), pkg: pkg === null ? null : versionOfPackage(pkg) };
}

/** One change's problem, or null: a version change may touch only the release files. */
function judge(label: string, before: Snapshot, after: Snapshot, files: readonly string[]): string | null {
  const changed = before.version !== after.version || before.pkg !== after.pkg;
  if (!changed) return null;
  const others = files.filter((f) => !RELEASE_FILES.includes(f));
  if (others.length === 0) return null;
  const shown = others.slice(0, 5).join(", ") + (others.length > 5 ? `, and ${others.length - 5} more` : "");
  return `${label}: the version changes (${before.version ?? "none"} → ${after.version ?? "none"}) together with ${shown}; a feature PR never changes the version: revert those lines, in this commit or a later one (a release is its own PR, bun run release <major|minor|patch>)`;
}

/**
 * When the version at HEAD differs from the merge-base with `base`: every commit in `base..HEAD`
 * (merges excepted: they bring main's own commits, each judged on main) that changes the version
 * alongside other files. A bump a later commit reverts leaves the net version alone, so it passes.
 * The uncommitted tracked changes are judged the same way either way. A release commit on main
 * passes by construction, so a stale `base` never fails a feature branch.
 */
export function versionMixProblems(repo: string, base: string): string[] {
  const problems: string[] = [];
  const mergeBase = gitOk(repo, ["merge-base", base, "HEAD"]).trim();
  const before = snapshotAt(repo, mergeBase);
  const head = snapshotAt(repo, "HEAD");
  const netChanged = before.version !== head.version || before.pkg !== head.pkg;
  const commits = netChanged ? gitOk(repo, ["rev-list", "--no-merges", "--reverse", `${base}..HEAD`]).split("\n").filter(Boolean) : [];
  for (const commit of commits) {
    const files = gitOk(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit]).split("\n").filter(Boolean);
    if (!files.some((f) => RELEASE_FILES.includes(f))) continue;
    const parent = git(repo, ["rev-parse", "--verify", "--quiet", `${commit}^`]);
    const before = parent.code === 0 ? snapshotAt(repo, parent.out.trim()) : { version: null, pkg: null };
    const subject = gitOk(repo, ["log", "-1", "--format=%s", commit]).trim();
    const problem = judge(`commit ${commit.slice(0, 8)} ("${subject}")`, before, snapshotAt(repo, commit), files);
    if (problem) problems.push(problem);
  }
  const dirty = gitOk(repo, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  if (dirty.some((f) => RELEASE_FILES.includes(f))) {
    const problem = judge("uncommitted changes", snapshotAt(repo, "HEAD"), snapshotOfTree(repo), dirty);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** Write the bumped version into both files; returns the old and new versions. */
export function writeRelease(repo: string, field: Field): { from: string; to: string } {
  const sourcePath = join(repo, VERSION_FILE);
  const pkgPath = join(repo, PACKAGE_FILE);
  const source = readFileSync(sourcePath, "utf8");
  const pkg = readFileSync(pkgPath, "utf8");
  const from = versionOfSource(source);
  if (from === null) throw new Error(`${VERSION_FILE} has no VERSION line`);
  if (versionOfPackage(pkg) !== from) throw new Error(`${PACKAGE_FILE}'s version (${versionOfPackage(pkg)}) is not ${VERSION_FILE}'s (${from})`);
  const to = bumpVersion(from, field);
  writeFileSync(sourcePath, source.replace(VERSION_LINE, `export const VERSION = "${to}";`));
  writeFileSync(pkgPath, pkg.replace(/("version":\s*)"[^"]*"/, `$1"${to}"`));
  return { from, to };
}

/** Subjects merged since the last commit that changed the version file, to choose the field from. */
function mergedSince(repo: string): string[] {
  const last = gitOk(repo, ["log", "-1", "--format=%H", "-G", "export const VERSION = ", "--", VERSION_FILE]).trim();
  const range = last ? `${last}..HEAD` : "HEAD";
  return gitOk(repo, ["log", "--first-parent", "--format=%h %s", range]).split("\n").filter(Boolean);
}

function main(argv: string[]): number {
  const repo = resolve(import.meta.dir, "..");
  const [verb, arg] = argv;
  if (verb === "check") {
    const base = arg ?? defaultBase(repo);
    if (!base) {
      console.error("no base: pass one (bun run release check origin/main), or fetch origin");
      return 2;
    }
    const problems = versionMixProblems(repo, base);
    for (const p of problems) console.error(p);
    if (problems.length === 0) console.log(`ok: no commit since ${base} mixes a version change with other files`);
    return problems.length === 0 ? 0 : 1;
  }
  if (verb && (FIELDS as readonly string[]).includes(verb)) {
    const merged = mergedSince(repo);
    const { from, to } = writeRelease(repo, verb as Field);
    console.log(`${from} → ${to} in ${VERSION_FILE} and ${PACKAGE_FILE}; land it as its own PR`);
    if (merged.length > 0) console.log(`merged since the last version change:\n${merged.map((s) => `  ${s}`).join("\n")}`);
    return 0;
  }
  console.error("usage: bun run release <major|minor|patch> | bun run release check [<base>]");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
