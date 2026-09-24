import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashToken, mintToken } from "../api/auth.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { timingConfig, workersConfig } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { promptLine, workerContract } from "../harness/contract-text.ts";
import { loadExtensionSource } from "../harness/pi/adapter.ts";
import { adapterFor } from "../harness/registry.ts";
import type { RunContext } from "../harness/types.ts";
import { HerdrError } from "../runtime/herdr/client.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { PROTO } from "../version.ts";
import { getProject, type ProjectRow } from "./projects.ts";
import { failRun, getRunWithPolicy, isTerminal, type RunWithPolicy } from "./runs.ts";

export type LaunchMode = "fresh" | "resume";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LauncherDeps {
  db: Db;
  config(): FlowrynConfig;
  runtime(): HerdrRuntime | null;
  log(message: string): void;
  now(): number;
  git(args: string[], cwd?: string): Promise<GitResult>;
  flowrynBin(): Promise<string>;
  socketPath: string;
  home: string;
  /** After a launch settles either way, so the reconciler and waiters look again. */
  onSettled?(runId: string): void;
}

/**
 * Inherited Claude Code session identity reaches every pane of a Herdr server
 * started from inside a Claude session (M0 finding 1), and a Claude launched
 * there runs as that session's child. pane.split cannot unset a variable, so
 * each is blanked, which Claude treats as unset.
 */
export const BLANKED_ENV = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET"] as const;

/** Launch failures that should be retried on the next pass (Herdr down), rather than failing the run. */
export class TransientLaunchError extends Error {}

export function runDirFor(config: FlowrynConfig, runId: string): string {
  return join(config.state_dir, "runs", runId);
}

/**
 * A task's artifacts directory, `<data_dir>/<task>/`: the worker's
 * FLOWRYN_REPORT_DIR. A delivered report lands in it as report.md, because
 * tasks-axi 0.2.5 accepts a report link only as `data/<id>/report.md`.
 */
export function reportDirFor(config: FlowrynConfig, taskId: string): string {
  return join(config.data_dir, taskId);
}

/** The report link tasks-axi records for a task (its only accepted form). */
export function reportLink(taskId: string): string {
  return `data/${taskId}/report.md`;
}

/** The task text a dispatch recorded; the launcher materializes it into task.md. */
export function dispatchedBody(db: Db, runId: string): string {
  const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.dispatched' ORDER BY seq LIMIT 1").get(runId) as { payload: string } | null;
  if (!row) return "";
  return String((JSON.parse(row.payload) as { body?: unknown }).body ?? "");
}

function isTerse(config: FlowrynConfig): boolean {
  const style = config.extra.style as Record<string, unknown> | undefined;
  return style?.terse !== false;
}

/**
 * Starts and resumes workers (design section 5, lifecycle engine side): the
 * worktree with git, the run's private files, a Herdr pane split with the
 * run's environment, agent.start, and the harness identity from the process
 * table. Each step's result is recorded before the next, so a daemon crash
 * mid-launch leaves a run the reconciler can finish or fail.
 */
export class Launcher {
  private readonly deps: LauncherDeps;
  private readonly active = new Set<string>();

  constructor(deps: LauncherDeps) {
    this.deps = deps;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Launch in the background; failures are recorded on the run, never thrown. */
  start(runId: string, mode: LaunchMode = "fresh"): void {
    void this.launch(runId, mode);
  }

  async launch(runId: string, mode: LaunchMode = "fresh"): Promise<"launched" | "skipped" | "failed" | "deferred"> {
    if (this.active.has(runId)) return "skipped";
    this.active.add(runId);
    try {
      return (await this.run(runId, mode)) ? "launched" : "skipped";
    } catch (error) {
      const { db, log, now } = this.deps;
      if (error instanceof TransientLaunchError || (error instanceof HerdrError && (error.code === "unreachable" || error.code === "timeout"))) {
        log(`launch ${runId}: deferred: ${(error as Error).message}`);
        tx(db, () => appendEvent(db, { source: "daemon", kind: "run.launch_deferred", runId, payload: { mode, reason: (error as Error).message }, ts: now() }));
        return "deferred";
      }
      log(`launch ${runId}: failed: ${(error as Error).stack ?? String(error)}`);
      tx(db, () => {
        const run = getRunWithPolicy(db, runId);
        if (run) failRun(db, run, `${mode === "resume" ? "resume" : "launch"} failed: ${(error as Error).message}`, "daemon", now());
      });
      return "failed";
    } finally {
      this.active.delete(runId);
      this.deps.onSettled?.(runId);
    }
  }

  private async run(runId: string, mode: LaunchMode): Promise<boolean> {
    const { db, now } = this.deps;
    const run = getRunWithPolicy(db, runId);
    if (!run || isTerminal(run.state)) return false;
    // A fresh launch happens once; a replayed dispatch or a second kick must not start another worker.
    if (mode === "fresh" && (run.state !== "launching" || run.proc_pid !== null)) return false;
    const project = getProject(db, run.project_id);
    if (!project) throw new Error(`project ${run.project_id} is gone`);
    const config = this.deps.config();
    const workers = workersConfig(config);
    const timing = timingConfig(config);
    const runtime = this.deps.runtime();
    if (!runtime) throw new TransientLaunchError("Herdr is not reachable");
    const adapter = adapterFor(run.harness);
    const binary = resolveTool(config, run.harness);
    if (!binary) throw new Error(`${run.harness} is not installed or not in [tools]`);

    const worktree = await this.ensureWorktree(run, project);
    const runDir = runDirFor(config, run.id);
    ensureDir(dirname(runDir), 0o700);
    ensureDir(runDir, 0o700);
    const reportDir = reportDirFor(config, run.task_id);
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const token = this.tokenFor(run, runDir);
    const instructionsFile = join(runDir, "task.md");
    const contractFile = join(runDir, "contract.md");
    const body = dispatchedBody(db, run.id);
    writeFileAtomic(instructionsFile, body.endsWith("\n") ? body : `${body}\n`, 0o600);
    writeFileAtomic(contractFile, workerContract(run.harness, isTerse(config)), 0o600);
    if (run.harness === "pi") await loadExtensionSource();

    const flowrynBin = await this.deps.flowrynBin();
    const context: RunContext = {
      runId: run.id,
      taskId: run.task_id,
      kind: run.kind,
      worktree,
      projectPath: project.path,
      runDir,
      sessionId: run.agent_session ?? "",
      instructionsFile,
      contractFile,
      promptLine: promptLine(run.kind, run.task_id, body, instructionsFile),
      flowrynBin,
      binary,
    };
    if (!context.sessionId) throw new Error("the run has no agent session id");
    const trust = await adapter.preTrust(context, workers);
    if (!trust.ok) throw new Error(`workspace trust: ${trust.detail}`);
    // A worker that died before its session started has no session to resume; start it fresh under the same id.
    const plan = mode === "resume" && run.worker_started_at !== null ? adapter.resume(context, workers) : adapter.launch(context, workers);
    for (const file of plan.files) writeFileAtomic(file.path, file.content, file.mode ?? 0o600);

    const env: Record<string, string> = {
      ...Object.fromEntries(BLANKED_ENV.map((k) => [k, ""])),
      ...plan.env,
      FLOWRYN_RUN: run.id,
      FLOWRYN_TASK: run.task_id,
      FLOWRYN_TOKEN: token,
      FLOWRYN_BIN: flowrynBin,
      FLOWRYN_SOCK: this.deps.socketPath,
      FLOWRYN_PROTO: String(PROTO),
      FLOWRYN_HOME: this.deps.home,
      FLOWRYN_WORKTREE: worktree,
      FLOWRYN_REPORT_DIR: reportDir,
      PATH: `${this.shimDir(config, run.harness, binary)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };

    const paneId = await this.ensurePane(runtime, run, worktree, env);
    tx(db, () => {
      db.query("UPDATE runs SET launched_at = ?2, liveness = 'starting', busy_until = NULL, idle_since = NULL, updated_at = ?2 WHERE id = ?1").run(run.id, now());
      appendEvent(db, { source: "daemon", kind: "run.launching", runId: run.id, taskId: run.task_id, payload: { mode, pane: paneId, trust: trust.detail, args: plan.args.length } });
    });
    await runtime.startAgent(paneId, { kind: plan.kind, name: `flowryn-${run.id.slice(-8).toLowerCase()}-${now().toString(36)}`, args: plan.args });
    const harness = await runtime.harnessProcess(paneId, (p) => adapter.matchesProcess(p, binary), timing.launch_timeout_ms);
    if (!harness) throw new Error(`the ${run.harness} process did not appear in pane ${paneId} within ${timing.launch_timeout_ms} ms`);
    tx(db, () => {
      const current = getRunWithPolicy(db, run.id);
      if (!current || isTerminal(current.state)) return;
      db.query(
        `UPDATE runs SET proc_pid = ?2, proc_start = ?3, proc_exe = ?4, state = CASE WHEN state = 'launching' THEN 'running' ELSE state END, updated_at = ?5 WHERE id = ?1`,
      ).run(run.id, harness.identity.pid, harness.identity.start, harness.identity.exe, now());
      appendEvent(db, {
        source: "daemon",
        kind: "run.launched",
        runId: run.id,
        taskId: run.task_id,
        payload: { mode, pane: paneId, pid: harness.identity.pid, exe: harness.identity.exe, argv0: harness.process.argv0 },
      });
    });
    return true;
  }

  /** git is the ground truth for worktrees; a relaunch reuses the run's own worktree. */
  private async ensureWorktree(run: RunWithPolicy, project: ProjectRow): Promise<string> {
    const path = run.worktree_path;
    if (existsSync(path)) {
      const top = await this.deps.git(["-C", path, "rev-parse", "--show-toplevel"]);
      const branch = await this.deps.git(["-C", path, "branch", "--show-current"]);
      if (top.exitCode !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(path)) throw new Error(`${path} exists but is not a git worktree root`);
      if (branch.stdout.trim() !== run.branch) throw new Error(`${path} is on ${branch.stdout.trim() || "a detached HEAD"}, not ${run.branch}`);
      return realpathSync(path);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const exists = await this.deps.git(["-C", project.path, "rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`]);
    const args = exists.exitCode === 0 ? ["worktree", "add", path, run.branch] : ["worktree", "add", "-b", run.branch, path, run.base_sha];
    const added = await this.deps.git(["-C", project.path, ...args]);
    if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
    return realpathSync(path);
  }

  /**
   * The run token lives in the private run directory (0600 in a 0700 tree), so
   * a relaunch or resume gives the worker the same token and its spooled calls
   * stay valid. The database holds only its hash.
   */
  private tokenFor(run: RunWithPolicy, runDir: string): string {
    const path = join(runDir, "token");
    if (existsSync(path)) {
      const token = readFileSync(path, "utf8").trim();
      if (hashToken(token) === run.token_hash) return token;
    }
    const token = mintToken("run");
    writeFileAtomic(path, token, 0o600);
    const { db, now } = this.deps;
    tx(db, () => {
      db.query("UPDATE runs SET token_hash = ?2, updated_at = ?3 WHERE id = ?1").run(run.id, hashToken(token), now());
      appendEvent(db, { source: "daemon", kind: "run.token_minted", runId: run.id, taskId: run.task_id, payload: {} });
    });
    return token;
  }

  /**
   * Herdr's agent.start types the harness's canonical name (`claude`, `pi`)
   * into the pane shell. A shim directory first on PATH maps that name to the
   * binary Flowryn resolved, so the worker runs the version the contract gate
   * checked even when the shell has no alias for it.
   */
  private shimDir(config: FlowrynConfig, harness: string, binary: string): string {
    const dir = join(config.state_dir, "shims");
    ensureDir(dir, 0o700);
    const link = join(dir, harness);
    const script = `#!/bin/sh\nexec ${JSON.stringify(binary)} "$@"\n`;
    if (!existsSync(link) || readFileSync(link, "utf8") !== script) writeFileSync(link, script, { mode: 0o700 });
    return dir;
  }

  /** Reuse the run's pane when its shell is idle at the prompt; otherwise open a new workspace and split it. */
  private async ensurePane(runtime: HerdrRuntime, run: RunWithPolicy, worktree: string, env: Record<string, string>): Promise<string> {
    const { db, now } = this.deps;
    if (run.pane_id) {
      const info = await runtime.processes(run.pane_id);
      if (info && info.foregroundGroup === info.shellPid) return run.pane_id;
    }
    const workspace = await runtime.openWorkspace(worktree, `flowryn ${run.task_id}`);
    const paneId = await runtime.splitPane(workspace.rootPaneId, worktree, env);
    await runtime.tagPane(paneId, run.id, `flowryn ${run.task_id}`);
    tx(db, () => {
      db.query("UPDATE runs SET pane_id = ?2, workspace_id = ?3, herdr_session = ?4, updated_at = ?5 WHERE id = ?1").run(
        run.id,
        paneId,
        workspace.workspaceId,
        (runtime.transport as { socketPath?: string }).socketPath ?? null,
        now(),
      );
      appendEvent(db, { source: "daemon", kind: "run.pane", runId: run.id, taskId: run.task_id, payload: { pane: paneId, workspace: workspace.workspaceId, previous: run.pane_id } });
    });
    return paneId;
  }
}
