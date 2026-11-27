import { isAbsolute, resolve } from "node:path";
import type { Command } from "./shell.ts";

/**
 * Laws that hold for every project (docs/notes/2026-11-27-phase-global-laws-iq.md), refused by
 * the toolkit hook (src/policy/toolkit.ts) where the action is a shell command. Pure: each
 * verdict reads the normalized commands (src/policy/shell.ts) and, for a push, the paths its
 * commits carry, which the hook process gathers with git first (`pushSources`). No model.
 */

/** The hook rules that enforce a global law; each is one of the toolkit's rules. */
export const LAW_RULES = ["rebase", "force-push", "tags", "remember-push", "dev-port", "laws-file"] as const;
export type LawRule = (typeof LAW_RULES)[number];

/** Flowryn's built-in global laws: one row each, enforced by its hook rule, shown by `flowryn laws` and checked by verify. */
export const BUILT_IN_LAWS: readonly { rule: string; hook: LawRule }[] = [
  { rule: "Never rebase: take the base in with git merge", hook: "rebase" },
  { rule: "Never force-push", hook: "force-push" },
  { rule: "A tag never moves, is never deleted and reused, and is vMAJOR.MINOR.PATCH", hook: "tags" },
  { rule: "No .remember/ path in a push", hook: "remember-push" },
  { rule: "A worker never binds port 8081 (the user's own make dev)", hook: "dev-port" },
  { rule: "The global laws file is the user's to write", hook: "laws-file" },
];

/** Where the built-in laws are proven: Flowryn's own tests deny each rule, one through the real hook. */
export const BUILT_IN_PROOF = "Flowryn's test/unit/global-laws.test.ts and test/integration/toolkit.test.ts";

export const GUIDANCE: Record<LawRule, string> = {
  rebase: "Flowryn's global law: history is never rewritten. Take the base in with a new commit (git fetch origin, then git merge origin/<base>). git rebase --abort or --quit, to leave a rebase in progress, is allowed.",
  "force-push": "Flowryn's global law: pushed history is never rewritten. Make a new commit and push plainly; when the push is refused as not a fast-forward, git merge the remote branch first.",
  tags: "Flowryn's global law: a tag, once made, never moves and is never deleted and reused, and every tag is vMAJOR.MINOR.PATCH with all three fields (v1.2.0, never v1.2). Derive the next one from git describe --tags --abbrev=0 and bump one field; a wrong tag stays, and the user decides what follows.",
  "remember-push": "Flowryn's global law: .remember/ holds session notes and never leaves this machine. Take it out of your unpushed commits first: git reset --soft <the last pushed commit>, git rm -r --cached .remember, add .remember/ to .gitignore, and commit again.",
  "dev-port": "Flowryn's global law: port 8081 is the user's own dev instance (make dev); a worker's dev server uses another port.",
  "laws-file": "Flowryn's global law: the global laws file is the user's to write. Propose the row to your leader or the user instead.",
};

export interface LawHit {
  rule: LawRule;
  /** What was refused, for the reason. */
  what: string;
}

/** What the hook gathered about a line's pushes: every path their unpushed commits touch. */
export interface PushFacts {
  pushedPaths: readonly string[];
}

const GIT_VALUED_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--exec-path"]);

/** A git command's subcommand, the words after it, and the folder `-C` points it at. */
export function gitCall(c: Command): { sub: string; rest: string[]; dir: string | null } | null {
  if (c.name !== "git") return null;
  const args = c.argv.slice(1);
  let dir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!w.startsWith("-")) return { sub: w, rest: args.slice(i + 1), dir };
    if (w === "-C") dir = args[i + 1] ?? null;
    if (GIT_VALUED_GLOBALS.has(w)) i++;
  }
  return null;
}

/** A short-flag cluster (`-fu`) that holds `letter`, or the long flag itself. */
function hasFlag(args: readonly string[], letter: string | null, ...long: string[]): boolean {
  return args.some((a) => long.some((l) => a === l || a.startsWith(`${l}=`)) || (letter !== null && /^-[a-zA-Z]+$/.test(a) && a.includes(letter)));
}

function operands(args: readonly string[]): string[] {
  const dash = args.indexOf("--");
  const before = (dash === -1 ? args : args.slice(0, dash)).filter((a) => !a.startsWith("-"));
  return dash === -1 ? before : [...before, ...args.slice(dash + 1)];
}

const SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** `git tag` flags that list, verify or filter: such a call makes no tag. */
const TAG_READS = ["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify", "--column", "--sort", "--format"];
/** `git tag` short flags whose value is the rest of their cluster or the next word. */
const TAG_VALUED_SHORT = "mFu";
/** `git tag` long flags that take the next word as their value when no `=` gives it. */
const TAG_VALUED_LONG = new Set(["--message", "--file", "--local-user", "--cleanup", "--trailer", "--sort", "--format"]);

/** A tag's name is vMAJOR.MINOR.PATCH, with an optional pre-release or build. */
export function isReleaseTag(name: string): boolean {
  return SEMVER.test(name);
}

/** A ref a push names that is a tag: `refs/tags/…`, a release tag, or a bare version such as `1.2`. */
function isTagRef(ref: string): boolean {
  return /^refs\/tags\/./.test(ref) || /^v?\d+(?:\.\d+)*$/.test(ref) || isReleaseTag(ref);
}

/** `git tag`'s words as git reads them: the flags it sees (short as `-x`, long without `=…`) and its first operand. */
function readTagArgs(rest: readonly string[]): { flags: Set<string>; name: string | null } {
  const flags = new Set<string>();
  let name: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      name ??= rest[i + 1] ?? null;
      break;
    }
    if (a.startsWith("--")) {
      const long = a.split("=")[0]!;
      flags.add(long);
      if (!a.includes("=") && TAG_VALUED_LONG.has(long)) i++;
    } else if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j]!;
        flags.add(`-${letter}`);
        if (letter === "n") break;
        if (TAG_VALUED_SHORT.includes(letter)) {
          if (j === a.length - 1) i++;
          break;
        }
      }
    } else name ??= a;
  }
  return { flags, name };
}

function rebaseHit(git: { sub: string; rest: string[] }): string | null {
  if (git.sub === "rebase") return git.rest.some((a) => a === "--abort" || a === "--quit" || a === "--show-current-patch") ? null : `\`git rebase${git.rest[0] ? ` ${git.rest[0]}` : ""}\``;
  if (git.sub === "pull") {
    const off = git.rest.some((a) => a === "--no-rebase" || a === "--rebase=false");
    if (!off && (git.rest.includes("-r") || git.rest.some((a) => a === "--rebase" || a.startsWith("--rebase=")))) return "`git pull --rebase`";
  }
  return null;
}

function forcePushHit(git: { sub: string; rest: string[] }): string | null {
  if (git.sub !== "push") return null;
  if (hasFlag(git.rest, "f", "--force", "--force-with-lease", "--force-if-includes", "--mirror")) return "`git push --force`";
  const plus = operands(git.rest).slice(1).find((r) => r.startsWith("+"));
  return plus ? `\`git push\` of the forced refspec ${plus}` : null;
}

function tagHit(c: Command, git: { sub: string; rest: string[] } | null): string | null {
  if (c.name === "gh-axi" && c.argv[1] === "release" && c.argv[2] === "create") {
    const tag = operands(c.argv.slice(3))[0];
    return tag !== undefined && !isReleaseTag(tag) ? `the release tag ${tag}` : null;
  }
  if (!git) return null;
  if (git.sub === "push") {
    const refs = operands(git.rest).slice(1);
    const deleting = hasFlag(git.rest, "d", "--delete") ? refs.find(isTagRef) : undefined;
    const emptied = refs.find((r) => r.startsWith(":") && isTagRef(r.slice(1)));
    const gone = deleting ?? emptied;
    return gone ? `deleting the tag ${gone.replace(/^:/, "")} on the remote` : null;
  }
  if (git.sub !== "tag") return null;
  const { flags, name } = readTagArgs(git.rest);
  if (flags.has("-f") || flags.has("--force")) return "`git tag --force` (moving a tag)";
  if (flags.has("-d") || flags.has("--delete")) return "`git tag --delete`";
  if (TAG_READS.some((r) => flags.has(r))) return null;
  return name !== null && !isReleaseTag(name) ? `the tag ${name}` : null;
}

/** Commands that read, reach or search for a port rather than serve on it. */
const PORT_READERS = new Set([
  ...["curl", "wget", "http", "https", "httpie", "xh", "xhs", "curlie", "grpcurl", "websocat", "open", "chrome-devtools-axi"],
  ...["lsof", "netstat", "ss", "nc", "ncat", "telnet", "ssh", "scp", "sftp", "kill"],
  ...["grep", "egrep", "fgrep", "rg", "ag", "ack", "git", "echo", "printf", "sed", "awk", "jq", "yq", "cat", "head", "tail"],
]);
const PORT = "8081";
const BIND = /^(?:(?:127\.0\.0\.1|0\.0\.0\.0|localhost|\*|\[::1?\])?:)8081(?::\d+(?:\/\w+)?)?$/;
const PUBLISH = /^8081:\d+(?:\/\w+)?$/;
const PORT_FLAGS = new Set(["-p", "--port", "--publish", "--listen", "--bind", "--addr", "--address", "--http"]);

function bindsPort(word: string): boolean {
  return BIND.test(word) || PUBLISH.test(word);
}

/** A worker's command that serves on 8081: `--port 8081`, `-p 8081:80`, `0.0.0.0:8081`, `PORT=8081 make dev`. */
function devPortHit(c: Command): string | null {
  if (PORT_READERS.has(c.name)) return null;
  for (const [key, value] of Object.entries(c.assignments)) {
    if ((/(?:^|_)PORT$/i.test(key) && value === PORT) || (/ADDR|LISTEN|BIND/i.test(key) && bindsPort(value))) return `${key}=${value}`;
  }
  const args = c.argv.slice(1);
  // python's http.server takes its port as a bare operand.
  if (args.includes("http.server") && args.includes(PORT)) return `\`${c.argv[0]} -m http.server ${PORT}\``;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const [flag, value] = a.startsWith("-") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    if (value !== null && PORT_FLAGS.has(flag) && (value === PORT || bindsPort(value))) return `\`${a}\``;
    if (value === null && PORT_FLAGS.has(a) && (args[i + 1] === PORT || bindsPort(args[i + 1] ?? ""))) return `\`${a} ${args[i + 1]}\``;
    if (!a.startsWith("-") && !a.includes("://") && bindsPort(a)) return `\`${c.argv[0]} … ${a}\``;
  }
  return null;
}

/** A path under `.remember/`, at the root or deeper. */
export function isRememberPath(path: string): boolean {
  return path === ".remember" || path.startsWith(".remember/") || path.includes("/.remember/");
}

/** The first global law a line's commands break, or null. `role` gates the worker-only laws. */
export function globalLawHit(commands: readonly Command[], role: "worker" | "leader", facts: PushFacts | null): LawHit | null {
  for (const c of commands) {
    const git = gitCall(c);
    const rebase = git ? rebaseHit(git) : null;
    if (rebase) return { rule: "rebase", what: rebase };
    const force = git ? forcePushHit(git) : null;
    if (force) return { rule: "force-push", what: force };
    const tag = tagHit(c, git);
    if (tag) return { rule: "tags", what: tag };
    if (git?.sub === "push" && facts) {
      const carried = facts.pushedPaths.find(isRememberPath);
      if (carried) return { rule: "remember-push", what: `a push carrying ${carried}` };
    }
    const port = role === "worker" ? devPortHit(c) : null;
    if (port) return { rule: "dev-port", what: `binding port 8081 with ${port}` };
  }
  return null;
}

/**
 * The pushes of a line, for the hook to read before it judges: each push's folder (the line's
 * `cd`s and `git -C` applied to `cwd`) and the revisions it sends (`HEAD` when it names none).
 * A dry run and a delete send nothing. A revision that starts with `-` is dropped, so none can
 * become an option of the git that reads it.
 */
export function pushSources(commands: readonly Command[], cwd: string | null, home: string): { dir: string; revs: string[] }[] {
  const out: { dir: string; revs: string[] }[] = [];
  let at = cwd;
  const here = (path: string, base: string | null) => (path === "~" || path.startsWith("~/") ? home + path.slice(1) : isAbsolute(path) ? resolve(path) : base ? resolve(base, path) : path);
  for (const c of commands) {
    if (c.name === "cd" || c.name === "pushd") {
      const dest = c.argv.slice(1).find((a) => !a.startsWith("-"));
      at = dest ? here(dest, at) : home;
      continue;
    }
    const git = gitCall(c);
    if (git?.sub !== "push" || hasFlag(git.rest, "n", "--dry-run", "--delete") || hasFlag(git.rest, "d")) continue;
    const dir = git.dir ? here(git.dir, at) : at;
    if (!dir) continue;
    let revs: string[];
    if (hasFlag(git.rest, null, "--all", "--branches", "--mirror")) revs = ["--branches"];
    else {
      revs = operands(git.rest)
        .slice(1)
        .map((r) => r.replace(/^\+/, "").split(":")[0]!)
        .filter((r) => r.length > 0 && !r.startsWith("-"));
      if (revs.length === 0) revs = ["HEAD"];
    }
    if (hasFlag(git.rest, null, "--tags")) revs.push("--tags");
    out.push({ dir, revs });
  }
  return out;
}

/** The git argv that lists the paths a push's unpushed commits touch (merges add none of their own). */
export function pushedPathsArgv(push: { dir: string; revs: string[] }): string[] {
  return ["git", "-C", push.dir, "log", "--format=", "--name-only", "--no-renames", "--diff-filter=d", ...push.revs, "--not", "--remotes", "--"];
}
