import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PretrustMode } from "../../config/workers.ts";
import type { Trust } from "../types.ts";

/**
 * Claude Code's workspace trust (design section 5, preTrust), ported from
 * the previous orchestrator's bin/fm-claude-trust.sh. Claude gates a folder it has never seen
 * behind an interactive trust dialog that --permission-mode does not skip, and
 * Flowryn never answers a dialog with keys. So trust is checked, and in
 * `register` mode written, before launch.
 *
 * The previous orchestrator's disassembly (2026-09-06) found Claude reads the canonical project
 * entry first, and canonicalizes a linked worktree to its PRIMARY CHECKOUT;
 * the external-CLAUDE.md-imports check reads only that canonical entry. A
 * linked worktree of a checkout that is already trusted therefore needs no
 * write at all (confirmed live for M2 on Claude Code 2.1.281).
 *
 * The scope test is structural: the worktree must be a linked git worktree
 * root sharing the project's common dir. Only the launching user's own store
 * is written, keyed by paths git just proved, fingerprint-and-refuse against a
 * concurrent write by Claude itself, never granting import consent the human
 * did not already give.
 */

const TRUST_FLAG = "hasTrustDialogAccepted";
const IMPORT_APPROVED = "hasClaudeMdExternalIncludesApproved";
const IMPORT_SHOWN = "hasClaudeMdExternalIncludesWarningShown";

export interface TrustRequest {
  worktree: string;
  project: string;
  /** Directory holding .claude.json: CLAUDE_CONFIG_DIR, else HOME. */
  storeDir: string;
  mode: PretrustMode;
  git?: (args: string[], cwd: string) => { code: number; out: string };
}

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : (env.HOME ?? "");
}

const SCRUBBED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_INDEX_FILE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
];

/** git with the overrides cleared: the scope test must answer from the filesystem, never an inherited GIT_DIR. */
function realGit(args: string[], cwd: string): { code: number; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUBBED_GIT_ENV.includes(k)) env[k] = v;
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}

function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

class Refusal extends Error {}

/** The canonical project path Claude keys trust by: the primary checkout of the worktree's repository. */
export function canonicalProject(worktree: string, project: string, git = realGit): { worktree: string; canonical: string } {
  const wt = realDir(worktree);
  if (!wt) throw new Refusal(`${worktree} is not an accessible directory`);
  const proj = realDir(project);
  if (!proj) throw new Refusal(`project ${project} is not an accessible directory`);
  const top = git(["rev-parse", "--show-toplevel"], wt);
  if (top.code !== 0 || realDir(top.out) !== wt) throw new Refusal(`${wt} is not a worktree root`);
  const commonOf = (dir: string): string | null => {
    const common = git(["rev-parse", "--git-common-dir"], dir);
    if (common.code !== 0) return null;
    return realDir(common.out.startsWith("/") ? common.out : join(dir, common.out));
  };
  const gitDirOf = (dir: string): string | null => {
    const gd = git(["rev-parse", "--absolute-git-dir"], dir);
    return gd.code === 0 ? realDir(gd.out) : null;
  };
  const wtCommon = commonOf(wt);
  const wtGitDir = gitDirOf(wt);
  if (!wtCommon || !wtGitDir) throw new Refusal(`${wt} has no resolvable git directory`);
  if (wtGitDir === wtCommon) throw new Refusal(`${wt} is a primary checkout, not an isolated worktree`);
  const projCommon = commonOf(proj);
  if (!projCommon || projCommon !== wtCommon) throw new Refusal(`${wt} is not a worktree of project ${proj}`);
  const projGitDir = gitDirOf(proj);
  if (projGitDir === projCommon) return { worktree: wt, canonical: proj };
  const candidate = realDir(dirname(projCommon));
  if (!candidate || gitDirOf(candidate) !== projCommon) throw new Refusal(`project ${proj} is a linked worktree whose primary checkout cannot be resolved`);
  return { worktree: wt, canonical: candidate };
}

type Entry = Record<string, unknown>;
type Store = { projects?: Record<string, Entry> } & Record<string, unknown>;

function storePath(storeDir: string): string {
  const path = join(storeDir, ".claude.json");
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path);
  } catch {
    // absent: written fresh below
  }
  return path;
}

function readStore(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseStore(raw: Buffer | null, path: string): Store {
  if (raw === null || raw.toString("utf8").trim() === "") return {};
  const parsed = JSON.parse(raw.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Refusal(`${path} is not a JSON object`);
  const store = parsed as Store;
  if (store.projects !== undefined && (store.projects === null || typeof store.projects !== "object" || Array.isArray(store.projects))) {
    throw new Refusal(`${path} has a non-object "projects" value`);
  }
  return store;
}

const fingerprint = (buf: Buffer | null) => (buf === null ? "absent" : createHash("sha256").update(buf).digest("hex"));

/** Trusted when the canonical entry (Claude's first look) or the worktree's own entry says so. */
function isTrusted(store: Store, canonical: string, worktree: string): boolean {
  const projects = store.projects ?? {};
  return projects[canonical]?.[TRUST_FLAG] === true || projects[worktree]?.[TRUST_FLAG] === true;
}

function declinedImports(store: Store, canonical: string): boolean {
  const entry = store.projects?.[canonical];
  return entry?.[IMPORT_APPROVED] === false && entry?.[IMPORT_SHOWN] === true;
}

export function checkOrRegisterTrust(request: TrustRequest): Promise<Trust> {
  try {
    return Promise.resolve(trustSync(request));
  } catch (error) {
    if (error instanceof Refusal) return Promise.resolve({ ok: false, wrote: false, detail: error.message });
    return Promise.resolve({ ok: false, wrote: false, detail: `cannot check Claude trust: ${(error as Error).message}` });
  }
}

function trustSync(request: TrustRequest): Trust {
  if (!request.storeDir || !request.storeDir.startsWith("/")) throw new Refusal("the Claude config directory must be an absolute path");
  const { worktree, canonical } = canonicalProject(request.worktree, request.project, request.git);
  const path = storePath(request.storeDir);
  if (existsSync(path)) {
    const st = statSync(path);
    if (!st.isFile()) throw new Refusal(`${path} is not a regular file`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Refusal(`${path} is not owned by this user`);
  }
  const current = parseStore(readStore(path), path);
  if (declinedImports(current, canonical)) {
    throw new Refusal(`the project entry for ${canonical} declined external CLAUDE.md imports; refusing to override that consent`);
  }
  if (isTrusted(current, canonical, worktree)) return { ok: true, wrote: false, detail: `trusted through ${canonical}` };
  if (request.mode === "check") {
    return { ok: false, wrote: false, detail: `Claude does not trust ${worktree} or ${canonical}; pretrust = "check" never writes .claude.json` };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const original = readStore(path);
    const before = fingerprint(original);
    const store = parseStore(original, path);
    const projects = (store.projects ??= {});
    const carryImports = projects[canonical]?.[IMPORT_APPROVED] === true;
    const flags = carryImports ? [TRUST_FLAG, IMPORT_APPROVED, IMPORT_SHOWN] : [TRUST_FLAG];
    for (const key of [worktree, canonical]) {
      const entry = projects[key] && typeof projects[key] === "object" && !Array.isArray(projects[key]) ? projects[key]! : {};
      for (const flag of flags) entry[flag] = true;
      projects[key] = entry;
    }
    // Two-space pretty JSON, the format Claude itself writes; an exclusive, unpredictable temp name.
    const tmp = join(dirname(path), `.claude.json.flowryn-trust.${process.pid}.${randomBytes(8).toString("hex")}`);
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    let renamed = false;
    try {
      if (fingerprint(readStore(path)) !== before) continue;
      renameSync(tmp, path);
      renamed = true;
    } finally {
      if (!renamed) rmSync(tmp, { force: true });
    }
    const back = parseStore(readStore(path), path);
    if (isTrusted(back, canonical, worktree) && back.projects?.[worktree]?.[TRUST_FLAG] === true) {
      return { ok: true, wrote: true, detail: `registered trust for ${worktree} and ${canonical}` };
    }
  }
  throw new Refusal(`${path} kept changing while trust was recorded; refusing to overwrite it`);
}
