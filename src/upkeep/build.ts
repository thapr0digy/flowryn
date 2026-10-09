import { closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { openItem, resolveItems } from "../attention/items.ts";
import { smokeEnv } from "../daemon/restart.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import type { GitRunner } from "../policy/landed.ts";

/**
 * The build after a Flowryn merge (spec 3, phase 3; the review chose "the
 * daemon builds it"). When origin's default branch of the Flowryn checkout
 * moves past the running build's commit, the daemon builds that tip in its
 * own clean worktree into a staging file beside the installed binary, then
 * renames it over the installed binary in one step. The build watcher
 * (src/daemon/build-watch.ts) then sees a clean build of a merged commit and
 * applies it through the restart's guards, as it would a build you made.
 * Plain code: git, `bun install`, `scripts/build.sh`, a rename; no model.
 *
 * - Which checkout: the project whose path is the running build's stamped
 *   source, the same match the watcher makes. A development daemon (no stamp)
 *   never builds.
 * - Once per commit: the last attempt is kept in `meta.upkeep_build`, so a
 *   failed commit is not retried in a loop; the next merge tries again. A
 *   failure is one `build_failed` P1 naming the log, and the installed
 *   binary is left as it was.
 * - Clean by construction: the worktree is checked out detached at the tip
 *   and cleaned (node_modules kept, so a build is not a cold install), and
 *   build.sh stamps the primary checkout as the source, so the watcher's
 *   "on origin" check and project match both hold.
 */

const META_KEY = "upkeep_build";
/** Each step's limit: an install or a compile that hangs is killed and the build fails. */
export const BUILD_STEP_TIMEOUT_MS = 15 * 60_000;
/** The staging directory beside the installed binary: the same filesystem, so the rename is atomic. */
export const STAGING_DIR = ".flowryn-build";

export interface BuildAttempt {
  commit: string;
  outcome: "built" | "failed";
  at: number;
  log: string;
  detail?: string;
}

export interface StepResult {
  exitCode: number | null;
  timedOut: boolean;
}

/** Run one build step, its output appended to the log. */
export type StepRunner = (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logPath: string; timeoutMs: number }) => Promise<StepResult>;

export const runStep: StepRunner = async (argv, opts) => {
  const fd = openSync(opts.logPath, "a", 0o600);
  let proc;
  try {
    writeSync(fd, `$ ${argv.join(" ")}\n`);
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: fd, stderr: fd });
  } catch (error) {
    writeSync(fd, `${(error as Error).message}\n`);
    closeSync(fd);
    return { exitCode: null, timedOut: false };
  }
  closeSync(fd);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, timedOut };
};

export interface MergeBuildDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now(): number;
  log(message: string): void;
  git: GitRunner;
  /** The running daemon's build and commit; a null build is a development daemon. */
  running(): { build: string | null; commit: string | null };
  /** The running build's stamped source checkout (src/build-stamp.ts), or null. */
  source(): string | null;
  /** The installed binary the supervisor starts next, or null when there is no single file to replace. */
  target(): Promise<string | null>;
  /** The bun executable (`[tools] bun`, else PATH), or null. */
  bun(): string | null;
  /** Where the daemon keeps its build worktrees (`<data_dir>/build`). */
  workDir: string;
  /** Where build logs go (`<state_dir>/logs`). */
  logDir: string;
  run?: StepRunner;
  stepTimeoutMs?: number;
}

export type BuildPass =
  | { outcome: "built"; commit: string; target: string }
  | { outcome: "failed"; commit: string; detail: string }
  | { outcome: "skipped"; reason: string };

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function readAttempt(db: Db): BuildAttempt | null {
  const raw = getMeta(db, META_KEY);
  return raw ? (JSON.parse(raw) as BuildAttempt) : null;
}

class StepFailed extends Error {}

export class MergeBuilder {
  private readonly deps: MergeBuildDeps;
  private current: { commit: string; startedAt: number } | null = null;

  constructor(deps: MergeBuildDeps) {
    this.deps = deps;
  }

  /** The build under way, for the restart's guard: launchd's restart would kill it mid-build. */
  building(): { commit: string; startedAt: number }[] {
    return this.current ? [this.current] : [];
  }

  /** The Flowryn project: the one whose path is the running build's stamped source. */
  project(): ProjectRow | null {
    const source = this.deps.source();
    if (!source) return null;
    const want = real(source);
    const projects = this.deps.db.query("SELECT * FROM projects").all() as ProjectRow[];
    return projects.find((p) => real(p.path) === want) ?? null;
  }

  /** One look: build origin's default branch when it moved past the running build and was not tried yet. */
  async pass(): Promise<BuildPass> {
    if (this.current) return { outcome: "skipped", reason: "a build is under way" };
    const running = this.deps.running();
    if (running.build === null) return { outcome: "skipped", reason: "a development daemon has no build to replace" };
    const project = this.project();
    if (!project) return { outcome: "skipped", reason: "no project is the running build's source checkout" };
    const { git } = this.deps;
    const branch = project.default_branch;
    const fetched = await git(["fetch", "--quiet", "origin", branch], project.path);
    if (fetched.code !== 0) return { outcome: "skipped", reason: `git fetch origin ${branch} failed: ${fetched.stderr.trim().split("\n")[0] ?? ""}` };
    const tip = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], project.path)).stdout.trim();
    if (!tip) return { outcome: "skipped", reason: `cannot resolve origin/${branch}` };
    if (tip === running.commit) return { outcome: "skipped", reason: "the daemon runs this commit" };
    if (readAttempt(this.deps.db)?.commit === tip) return { outcome: "skipped", reason: `${tip.slice(0, 8)} was tried already` };
    const target = await this.deps.target();
    if (!target) return { outcome: "skipped", reason: "the supervisor's target is not a single installed binary" };
    const bun = this.deps.bun();
    if (!bun) return { outcome: "skipped", reason: "bun is not found ([tools] bun)" };
    this.current = { commit: tip, startedAt: this.deps.now() };
    try {
      return await this.build(project, tip, target, bun);
    } finally {
      this.current = null;
    }
  }

  private async build(project: ProjectRow, commit: string, target: string, bun: string): Promise<BuildPass> {
    const { db } = this.deps;
    mkdirSync(this.deps.logDir, { recursive: true });
    const logPath = join(this.deps.logDir, `build-${commit.slice(0, 12)}.log`);
    const startedAt = this.deps.now();
    this.deps.log(`upkeep build: building ${commit.slice(0, 8)} of ${project.id} for ${target} (log ${logPath})`);
    tx(db, () => appendEvent(db, { source: "daemon", kind: "upkeep.build_started", payload: { project: project.id, commit, target, log: logPath }, ts: startedAt }));
    const run = this.deps.run ?? runStep;
    const timeoutMs = this.deps.stepTimeoutMs ?? BUILD_STEP_TIMEOUT_MS;
    // build.sh stamps the commit and the clean tree itself; only the source is the primary checkout, not this worktree.
    const env: NodeJS.ProcessEnv = { ...smokeEnv(this.deps.env), PATH: `${dirname(bun)}:${this.deps.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`, FLOWRYN_BUILD_SOURCE: project.path };
    delete env.FLOWRYN_BUILD_COMMIT;
    delete env.FLOWRYN_BUILD_DIRTY;
    const staging = join(dirname(target), STAGING_DIR);
    const step = async (what: string, argv: string[], cwd: string) => {
      const result = await run(argv, { cwd, env, logPath, timeoutMs });
      if (result.timedOut) throw new StepFailed(`${what} did not finish within ${Math.round(timeoutMs / 60_000)} min`);
      if (result.exitCode !== 0) throw new StepFailed(`${what} exited ${result.exitCode ?? "on a signal"}`);
    };
    try {
      const worktree = await this.checkout(project, commit, logPath);
      if (existsSync(join(worktree, "package.json"))) await step("bun install", [bun, "install", "--frozen-lockfile"], worktree);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const staged = join(staging, basename(target));
      await step("scripts/build.sh", ["/bin/bash", join(worktree, "scripts", "build.sh"), staged], worktree);
      if (!existsSync(staged) || statSync(staged).size === 0) throw new StepFailed(`scripts/build.sh left no binary at ${staged}`);
      // The build watcher sees one complete file appear: the rename is the only change to the installed path.
      renameSync(staged, target);
    } catch (error) {
      const detail = error instanceof StepFailed ? error.message : `${(error as Error).message}`;
      this.recordFailure(project, commit, logPath, detail);
      return { outcome: "failed", commit, detail };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const now = this.deps.now();
    tx(db, () => {
      resolveItems(db, "build_failed", null, `built ${commit.slice(0, 8)}`, now);
      setMeta(db, META_KEY, JSON.stringify({ commit, outcome: "built", at: now, log: logPath } satisfies BuildAttempt));
      appendEvent(db, { source: "daemon", kind: "upkeep.built", payload: { project: project.id, commit, target, log: logPath, ms: now - startedAt }, ts: now });
    });
    this.deps.log(`upkeep build: ${commit.slice(0, 8)} installed at ${target}; the build watcher applies it`);
    return { outcome: "built", commit, target };
  }

  /** The daemon's worktree, detached at the commit and clean (node_modules kept). Throws StepFailed. */
  private async checkout(project: ProjectRow, commit: string, logPath: string): Promise<string> {
    const { git } = this.deps;
    const worktree = join(this.deps.workDir, project.id);
    const note = (line: string) => {
      const fd = openSync(logPath, "a", 0o600);
      writeSync(fd, `${line}\n`);
      closeSync(fd);
    };
    const must = async (args: string[], cwd: string) => {
      const result = await git(args, cwd);
      note(`$ git ${args.join(" ")}\n${result.stdout}${result.stderr}`);
      if (result.code !== 0) throw new StepFailed(`git ${args[0]} failed: ${result.stderr.trim().split("\n")[0] ?? ""}`);
      return result.stdout.trim();
    };
    const registered = existsSync(join(worktree, ".git")) && (await git(["rev-parse", "--show-toplevel"], worktree)).code === 0;
    if (registered) {
      await must(["checkout", "--detach", "--force", commit], worktree);
      await must(["clean", "-ffdx", "-e", "node_modules"], worktree);
    } else {
      // Only ever remove a directory under the daemon's own build root.
      if (existsSync(worktree)) {
        if (!inside(real(worktree), real(this.deps.workDir))) throw new StepFailed(`${worktree} is outside ${this.deps.workDir}`);
        rmSync(worktree, { recursive: true, force: true });
      }
      mkdirSync(this.deps.workDir, { recursive: true });
      await must(["worktree", "prune"], project.path);
      await must(["worktree", "add", "--detach", worktree, commit], project.path);
    }
    const head = await must(["rev-parse", "HEAD"], worktree);
    if (head !== commit) throw new StepFailed(`the build worktree is at ${head.slice(0, 8)}, not ${commit.slice(0, 8)}`);
    const status = await must(["status", "--porcelain"], worktree);
    if (status !== "") throw new StepFailed("the build worktree is not clean after checkout");
    return worktree;
  }

  private recordFailure(project: ProjectRow, commit: string, logPath: string, detail: string): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const line = `Build after merge failed for ${project.id} at ${commit.slice(0, 8)}: ${detail}; the installed binary is unchanged. Log: ${logPath}`;
    tx(db, () => {
      resolveItems(db, "build_failed", null, `superseded by ${commit.slice(0, 8)}`, now);
      setMeta(db, META_KEY, JSON.stringify({ commit, outcome: "failed", at: now, log: logPath, detail } satisfies BuildAttempt));
      const event = appendEvent(db, { source: "daemon", kind: "upkeep.build_failed", payload: { project: project.id, commit, log: logPath, detail }, ts: now });
      openItem(db, { kind: "build_failed", eventSeq: event.seq, line, now });
    });
    this.deps.log(`upkeep build: ${line}`);
  }
}
