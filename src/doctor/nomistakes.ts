import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { stateFiles } from "../config/paths.ts";
import { upkeepConfig } from "../config/upkeep.ts";
import { openDb } from "../db/db.ts";
import { gitRunner } from "../policy/git.ts";
import type { GitRunner } from "../policy/landed.ts";
import type { Check } from "./doctor.ts";

/**
 * `flowryn doctor`'s word on no-mistakes' CI conflict repair: with
 * `auto_fix.ci` above 0 its CI monitor rebases and force-pushes a PR that
 * starts to conflict with its base, racing `[upkeep] nudge_conflicts` (which
 * sends the ship back to merge instead). The effective value is the repo's
 * `.no-mistakes.yaml` on the default branch over `$NM_HOME/config.yaml`
 * (default `~/.no-mistakes/config.yaml`) over no-mistakes' own default.
 * Read-only: it never edits either file.
 */

/** no-mistakes' default `auto_fix.ci` (its config sample, v1.84.0), when neither file sets it. */
export const NM_DEFAULT_AUTO_FIX_CI = 3;

/** One config layer's word on `auto_fix.ci`: where it was read, and what it says. */
export type AutoFixLayer = { where: string; state: "absent" } | { where: string; state: "set"; value: number } | { where: string; state: "invalid"; detail: string };

/** Read `auto_fix.ci` from one YAML file's text. */
export function readAutoFixCi(where: string, text: string | null): AutoFixLayer {
  if (text === null) return { where, state: "absent" };
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (error) {
    return { where, state: "invalid", detail: `does not parse as YAML (${(error as Error).message.split("\n")[0]})` };
  }
  const autoFix = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>).auto_fix : undefined;
  if (autoFix === undefined || autoFix === null) return { where, state: "absent" };
  if (typeof autoFix !== "object" || Array.isArray(autoFix)) return { where, state: "invalid", detail: "auto_fix is not a mapping" };
  const ci = (autoFix as Record<string, unknown>).ci;
  if (ci === undefined || ci === null) return { where, state: "absent" };
  if (typeof ci !== "number" || !Number.isInteger(ci) || ci < 0) return { where, state: "invalid", detail: `auto_fix.ci is ${JSON.stringify(ci)}, not a whole number` };
  return { where, state: "set", value: ci };
}

export interface NmProject {
  id: string;
  path: string;
  default_branch: string;
}

/** The check for one project: the repo layer over the global one over the default. */
export function autoFixCheck(project: NmProject, repo: AutoFixLayer, global: AutoFixLayer): Check {
  const check = `no-mistakes auto_fix.ci (${project.id})`;
  const fix = `add \`auto_fix: { ci: 0 }\` to .no-mistakes.yaml on ${project.default_branch}`;
  for (const layer of [repo, global]) {
    if (layer.state === "invalid") return { check, status: "warn", detail: `${layer.where} ${layer.detail}, so the effective value is unknown; ${fix}` };
  }
  const effective = repo.state === "set" ? repo : global.state === "set" ? global : null;
  const value = effective?.value ?? NM_DEFAULT_AUTO_FIX_CI;
  const from = effective ? effective.where : `no-mistakes' default; neither ${repo.where} nor ${global.where} sets it`;
  if (value === 0) return { check, status: "ok", detail: `0 (from ${from}): a conflicting PR parks for the conflict nudge` };
  const line = repo.state === "set" ? `set \`ci: 0\` under auto_fix in .no-mistakes.yaml on ${project.default_branch}` : fix;
  return {
    check,
    status: "warn",
    detail: `${value} (from ${from}) while [upkeep] nudge_conflicts is on: no-mistakes' CI monitor rebases and force-pushes a PR that conflicts, racing the nudge; ${line}`,
  };
}

/** The repo's `.no-mistakes.yaml` on its default branch: origin's, else the local branch. Null text when the file is not there. */
export async function readRepoConfig(git: GitRunner, project: NmProject): Promise<{ where: string; text: string | null } | { where: string; error: string }> {
  for (const ref of [`origin/${project.default_branch}`, project.default_branch]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], project.path)).code !== 0) continue;
    const where = `.no-mistakes.yaml on ${ref}`;
    if ((await git(["cat-file", "-e", `${ref}:.no-mistakes.yaml`], project.path)).code !== 0) return { where, text: null };
    const shown = await git(["show", `${ref}:.no-mistakes.yaml`], project.path);
    return shown.code === 0 ? { where, text: shown.stdout } : { where, error: `cannot be read (git exit ${shown.code})` };
  }
  return { where: `${project.path}`, error: `has no ${project.default_branch} or origin/${project.default_branch} to read .no-mistakes.yaml from` };
}

/** `$NM_HOME/config.yaml`, no-mistakes' global config. */
export function globalConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.NM_HOME || join(env.HOME || homedir(), ".no-mistakes"), "config.yaml");
}

function readGlobal(path: string): AutoFixLayer {
  if (!existsSync(path)) return { where: path, state: "absent" };
  try {
    return readAutoFixCi(path, readFileSync(path, "utf8"));
  } catch (error) {
    return { where: path, state: "invalid", detail: `cannot be read (${(error as Error).message})` };
  }
}

/** One check per no-mistakes project while the conflict nudge is on; none otherwise. */
export async function autoFixChecks(nudgeConflicts: boolean, projects: readonly NmProject[], globalPath: string, git: GitRunner): Promise<Check[]> {
  if (!nudgeConflicts || projects.length === 0) return [];
  const global = readGlobal(globalPath);
  const checks: Check[] = [];
  for (const project of projects) {
    const read = await readRepoConfig(git, project);
    const repo: AutoFixLayer = "error" in read ? { where: read.where, state: "invalid", detail: read.error } : readAutoFixCi(read.where, read.text);
    checks.push(autoFixCheck(project, repo, global));
  }
  return checks;
}

/** The projects that deliver through no-mistakes, from the database read-only; none when it does not exist or cannot say. */
function nmProjects(config: FlowrynConfig): NmProject[] {
  const { db: dbPath } = stateFiles(config.state_dir);
  if (!existsSync(dbPath)) return [];
  const db = openDb(dbPath, { readonly: true });
  try {
    return db.query("SELECT id, path, default_branch FROM projects WHERE delivery_mode = 'no-mistakes' ORDER BY id").all() as NmProject[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** The doctor's entry: the config's switch, the database's projects, this machine's git. */
export async function nmAutoFixChecks(config: FlowrynConfig, env: NodeJS.ProcessEnv): Promise<Check[]> {
  let nudge: boolean;
  try {
    nudge = upkeepConfig(config).nudge_conflicts;
  } catch {
    return [];
  }
  const gitPath = resolveTool(config, "git");
  if (!nudge || !gitPath) return [];
  return autoFixChecks(nudge, nmProjects(config), globalConfigPath(env), gitRunner(gitPath, 10_000));
}
