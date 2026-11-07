import type { GitRunner } from "../policy/landed.ts";

/**
 * A verify step's `when_changed` globs (docs/notes/2026-11-06-fast-tests-parallel-36.md):
 * the step runs only when a file changed against the PR's base matches one of
 * them. Globs are plain code, compiled here to an anchored RegExp and never
 * handed to a shell. Supported: `**` (any number of path segments), `*` and `?`
 * (within one segment), `[...]` classes and `{a,b}` alternation (not nested).
 * A malformed glob throws at config load.
 */

const MAX_GLOB = 256;

function escapeRe(ch: string): string {
  return /[.+^$()|\\/]/.test(ch) ? `\\${ch}` : ch;
}

/** The anchored RegExp a glob matches a repository-relative path with; throws an Error saying why a glob is malformed. */
export function compileGlob(glob: string): RegExp {
  if (glob.length === 0) throw new Error("is empty");
  if (glob.length > MAX_GLOB) throw new Error(`is longer than ${MAX_GLOB} characters`);
  if (glob.includes("\0") || /[\r\n]/.test(glob)) throw new Error("contains a control character");
  if (glob.startsWith("/")) throw new Error("is absolute: globs match paths relative to the repository root");
  if (glob.split("/").some((part) => part === "..")) throw new Error("has a .. segment");
  let re = "";
  let inBraces = false;
  let braceItems = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (!atStart || !atEnd) throw new Error("uses ** inside a path segment: write it as a whole segment, such as src/**/x.ts");
        if (i + 2 === glob.length) re += ".*";
        else {
          re += "(?:[^/]+/)*";
          i++; // the "/" after ** is part of the group
        }
        i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) throw new Error("has an unclosed [");
      let body = glob.slice(i + 1, close);
      if (body.includes("/")) throw new Error("has a / inside [...]");
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else if (ch === "]") throw new Error("has a ] without its [");
    else if (ch === "{") {
      if (inBraces) throw new Error("nests {...}");
      inBraces = true;
      braceItems = 1;
      re += "(?:";
    } else if (ch === "}") {
      if (!inBraces) throw new Error("has a } without its {");
      if (braceItems < 2) throw new Error("has a {...} with a single choice");
      inBraces = false;
      re += ")";
    } else if (ch === "," && inBraces) {
      braceItems++;
      re += "|";
    } else if (ch === "\\") throw new Error("contains a backslash");
    else re += escapeRe(ch);
  }
  if (inBraces) throw new Error("has an unclosed {");
  return new RegExp(`^${re}$`);
}

/** Whether any path matches any glob. */
export function anyMatches(globs: readonly string[], paths: readonly string[]): boolean {
  const compiled = globs.map(compileGlob);
  return paths.some((path) => compiled.some((re) => re.test(path)));
}

export type ChangedFiles = { files: string[]; base: string } | { error: string };

/** The base ref a diff starts from: origin's copy of the PR's base, else origin's default branch, else origin/main. */
async function baseRef(git: GitRunner, cwd: string, base: string | null): Promise<string> {
  if (base) return `refs/remotes/origin/${base}`;
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  const ref = head.stdout.trim();
  return head.code === 0 && ref.startsWith("refs/remotes/origin/") ? ref : "refs/remotes/origin/main";
}

/**
 * The files the head changed since it left its base (the merge base of the two),
 * renames listed as a deletion and an addition so both paths count. Read once per
 * verification, in its worktree. Why not, when git cannot say.
 */
export async function changedSinceBase(git: GitRunner, cwd: string, base: string | null): Promise<ChangedFiles> {
  const ref = await baseRef(git, cwd, base);
  const shown = ref.replace(/^refs\/remotes\//, "");
  const mergeBase = await git(["merge-base", ref, "HEAD"], cwd);
  if (mergeBase.code !== 0) return { error: `no merge base with ${shown}: ${mergeBase.stderr.trim() || `exit ${mergeBase.code}`}` };
  const diff = await git(["diff", "--name-only", "--no-renames", "-z", mergeBase.stdout.trim(), "HEAD"], cwd);
  if (diff.code !== 0) return { error: `git diff against ${shown} failed: ${diff.stderr.trim() || `exit ${diff.code}`}` };
  return { files: diff.stdout.split("\0").filter((f) => f.length > 0), base: shown };
}
