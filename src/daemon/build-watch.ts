import { realpathSync, statSync } from "node:fs";
import type { DaemonInfo } from "../api/verbs.ts";
import { FlowrynError } from "../api/errors.ts";
import { findOpenItem, openItem, resolveItems, type ItemKind } from "../attention/items.ts";
import type { DaemonConfig } from "../config/daemon.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { LATEST_SCHEMA_VERSION } from "../db/schema.ts";
import { buildIdOf, commandOf, smokeCheck, type RestartController, type SmokeResult, type Supervisor } from "./restart.ts";

/**
 * The build watcher: the daemon applies a new installed build by itself.
 * Everything is plain code: a stat of the launchd target every
 * `[daemon] build_poll_ms`, a hash only when it changed and then held still
 * for `build_settle_ms` (a build writes the file, then signs it), the binary
 * check `daemon restart` already runs, and git refs. A build is applied (an
 * automatic `--when-idle` restart, by "auto", through the restart
 * controller's guards) only when it is a clean build of a commit on the
 * remote's default branch, and not older than the running daemon. Each build
 * is judged once and the verdict kept in `meta.build_watch`, so a restart, or
 * a dropped request, never asks again for the same build.
 */

/** How often the launchd target (the installed plist, read through plutil) is read again. */
export const TARGET_REFRESH_MS = 300_000;

const META_KEY = "build_watch";

export type Verdict =
  | { verdict: "apply" }
  | { verdict: "held"; reason: "unstamped" | "dirty" | "unmerged"; detail: string }
  | { verdict: "refused"; reason: "downgrade" | "broken"; detail: string };

/** The verdict on one build, as `meta.build_watch` keeps it. */
export interface Judged {
  build: string;
  commit: string | null;
  verdict: Verdict["verdict"];
  reason?: string;
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BuildWatchDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now(): number;
  log(message: string): void;
  config(): DaemonConfig;
  info(): DaemonInfo;
  supervisor(): Supervisor;
  restart: RestartController;
  git(args: string[], cwd: string): Promise<GitResult>;
  smoke?: (command: readonly string[], env: NodeJS.ProcessEnv) => Promise<SmokeResult>;
  /** A key that changes whenever the file does; null when it cannot be read. */
  stat?: (path: string) => string | null;
  hash?: (command: readonly string[]) => string | null;
  /** The newest migration the running daemon knows. */
  schema?: number;
}

function statKey(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** -1, 0 or 1 for two x.y.z versions; anything unparsable compares equal. */
function semver(v: string): number[] | null {
  return /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
}

export function compareVersions(a: string, b: string): number {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** Why a target is older than the running daemon, or null when it is not. */
export function downgradeOf(target: SmokeResult, running: { version: string; proto: number; schema: number }): string | null {
  if (target.proto < running.proto) return `it speaks protocol ${target.proto}, the running daemon ${running.proto}`;
  if (compareVersions(target.version, running.version) < 0) return `it is version ${target.version}, the running daemon ${running.version}`;
  if (target.schema !== null && target.schema < running.schema) return `it knows schema ${target.schema}, the database is at ${running.schema}`;
  return null;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function short(commit: string | null): string {
  return commit ? commit.slice(0, 7) : "no commit";
}

export function readJudged(db: Db): Judged | null {
  const raw = getMeta(db, META_KEY);
  return raw ? (JSON.parse(raw) as Judged) : null;
}

export class BuildWatcher {
  private readonly deps: BuildWatchDeps;
  private program: string[] | null = null;
  private programReadAt = 0;
  private lastKey: string | null = null;
  private changedAt = 0;
  private judgedKey: string | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: BuildWatchDeps) {
    this.deps = deps;
  }

  start(): void {
    const loop = () => {
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((error: unknown) => this.deps.log(`build watch: ${(error as Error).message}`))
          .finally(() => {
            if (this.timer) loop();
          });
      }, this.deps.config().build_poll_ms);
    };
    loop();
  }

  /** No new look after this; resolves when the look under way, if any, has ended (the daemon closes the database after). */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One look at the installed binary; judges it once it is new and settled. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.look().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async target(now: number): Promise<string[] | null> {
    if (this.program && now - this.programReadAt < TARGET_REFRESH_MS) return this.program;
    const supervisor = this.deps.supervisor();
    if (await supervisor.supervised()) return null;
    const target = await supervisor.target();
    if ("refusal" in target) return null;
    this.program = commandOf(target.program);
    this.programReadAt = now;
    return this.program;
  }

  private async look(): Promise<void> {
    const { db } = this.deps;
    const config = this.deps.config();
    if (config.auto_restart === "off" || this.deps.restart.inProgress) return;
    const running = this.deps.info().build ?? null;
    // A development daemon has no build to compare with: you restart it yourself.
    if (running === null) return;
    const now = this.deps.now();
    const command = await this.target(now);
    if (!command || command.length !== 1) return;
    const key = (this.deps.stat ?? statKey)(command[0]!);
    if (key === null) return;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.changedAt = now;
      return;
    }
    if (now - this.changedAt < config.build_settle_ms || this.judgedKey === key) return;
    const build = (this.deps.hash ?? buildIdOf)(command);
    if (build === null) return;
    this.judgedKey = key;
    if (build === running) {
      this.settle("the daemon runs this build");
      return;
    }
    if (readJudged(db)?.build !== build) await this.judge(command, build);
  }

  /** The installed build is the running one: close what the watcher opened, and forget the verdict. */
  private settle(why: string): void {
    const { db } = this.deps;
    const now = this.deps.now();
    tx(db, () => {
      for (const kind of ["build_held", "build_refused"] as const) resolveItems(db, kind, null, why, now);
      if (readJudged(db)) db.query("DELETE FROM meta WHERE key = ?1").run(META_KEY);
    });
  }

  private async judge(command: readonly string[], build: string): Promise<void> {
    const info = this.deps.info();
    let target: SmokeResult;
    try {
      target = await (this.deps.smoke ?? smokeCheck)(command, this.deps.env);
    } catch (error) {
      const detail = error instanceof FlowrynError ? error.message : String(error);
      this.record({ build, commit: null, verdict: "refused", reason: "broken" }, `Installed build ${build} failed its binary check, so the daemon stays on ${info.build}: ${detail}`);
      return;
    }
    const older = downgradeOf(target, { version: info.version, proto: info.proto, schema: this.deps.schema ?? LATEST_SCHEMA_VERSION });
    if (older) {
      this.record({ build, commit: target.commit, verdict: "refused", reason: "downgrade" }, `Installed build ${build} (${short(target.commit)}) is older than the running daemon: ${older}. Not applied; rebuild from the default branch`);
      return;
    }
    if (!target.commit || !target.source) {
      this.record({ build, commit: null, verdict: "held", reason: "unstamped" }, `Installed build ${build} carries no build stamp (an older build.sh?), so it is not applied by itself; flowryn daemon restart applies it`);
      return;
    }
    if (target.dirty !== false) {
      this.record({ build, commit: target.commit, verdict: "held", reason: "dirty" }, `Installed build ${build} (${short(target.commit)}) was built from a tree with uncommitted changes, so it is not applied by itself; flowryn daemon restart applies it`);
      return;
    }
    const branch = this.defaultBranch(target.source);
    if (!(await this.onBranch(target.source, target.commit, branch))) {
      this.record(
        { build, commit: target.commit, verdict: "held", reason: "unmerged" },
        `Installed build ${build} (${short(target.commit)}) is not on origin/${branch}, so it is never applied by itself; after merging, rebuild from the default branch, or flowryn daemon restart applies it now`,
      );
      return;
    }
    this.apply(build, target.commit);
  }

  /** The Flowryn checkout's default branch, from its project when it is one; else main. */
  private defaultBranch(source: string): string {
    const want = real(source);
    const projects = this.deps.db.query("SELECT path, default_branch FROM projects").all() as { path: string; default_branch: string }[];
    return projects.find((p) => real(p.path) === want)?.default_branch ?? "main";
  }

  /** Is the commit on the remote's default branch? One fetch of that branch when the local ref does not have it yet. */
  private async onBranch(source: string, commit: string, branch: string): Promise<boolean> {
    const check = async () => (await this.deps.git(["-C", source, "merge-base", "--is-ancestor", commit, `refs/remotes/origin/${branch}`], source)).exitCode === 0;
    if (await check()) return true;
    const fetched = await this.deps.git(["-C", source, "fetch", "--quiet", "origin", branch], source);
    if (fetched.exitCode !== 0) this.deps.log(`build watch: git fetch origin ${branch} in ${source} failed: ${fetched.stderr.trim().split("\n")[0] ?? ""}`);
    return check();
  }

  private apply(build: string, commit: string | null): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const outcome = tx(db, () => {
      for (const kind of ["build_held", "build_refused"] as const) resolveItems(db, kind, null, `build ${build} applies`, now);
      setMeta(db, META_KEY, JSON.stringify({ build, commit, verdict: "apply" } satisfies Judged));
      appendEvent(db, { source: "daemon", kind: "daemon.build_seen", payload: { build, commit, verdict: "apply" }, ts: now });
      return this.deps.restart.requestAuto({ build, commit });
    });
    this.deps.log(`build watch: ${build} (${short(commit)}) ${outcome === "parked" ? "restarts once the guards clear" : "is left to the restart already asked for"}`);
  }

  /** A build not applied: keep the verdict, record it, and say so once, replacing the line about an earlier build. */
  private record(judged: Judged, line: string): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const kind: ItemKind = judged.verdict === "refused" ? "build_refused" : "build_held";
    tx(db, () => {
      for (const k of ["build_held", "build_refused"] as const) resolveItems(db, k, null, `superseded by build ${judged.build}`, now);
      setMeta(db, META_KEY, JSON.stringify(judged));
      const { seq } = appendEvent(db, { source: "daemon", kind: "daemon.build_seen", payload: { ...judged, line }, ts: now });
      if (!findOpenItem(db, kind, null)) openItem(db, { kind, eventSeq: seq, line, now });
    });
    this.deps.log(`build watch: ${line}`);
  }
}
