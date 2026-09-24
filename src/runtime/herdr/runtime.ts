import { HerdrError, type HerdrEvent, type HerdrTransport, type Subscription } from "./client.ts";
import { psRunner, readIdentity, type ProcIdentity, type PsRunner } from "../proc.ts";

/**
 * The Herdr runtime (design section 4, src/runtime/herdr): workspace, pane and
 * agent operations over the socket API. It holds no state of its own; Herdr's
 * state is external and only ever a hint to the reconciler (rank 5).
 *
 * Worktrees are created with git by the launcher, not with Herdr's
 * worktree.create: Herdr 0.7.5 refuses a linked worktree as the source
 * ("linked_worktree_source"), and git is the ground truth the cleanup guard
 * reads anyway (docs/m2-notes.md).
 */

export interface PaneProcess {
  pid: number;
  name: string;
  argv0: string;
  argv: string[];
  cwd: string;
}

export interface PaneProcesses {
  paneId: string;
  shellPid: number;
  foregroundGroup: number;
  processes: PaneProcess[];
}

export interface PaneInfo {
  paneId: string;
  workspaceId: string;
  cwd: string;
  foregroundCwd: string;
  agent: string | null;
  agentStatus: string | null;
  revision: number | null;
  tokens: Record<string, string>;
}

export interface HarnessProcess {
  identity: ProcIdentity;
  process: PaneProcess;
}

export interface AgentLaunch {
  kind: "claude" | "pi";
  name: string;
  args: string[];
}

/** The metadata token that names a pane's run. A correlator only: a run is never adopted by label (section 6). */
export const RUN_TOKEN = "flowryn_run";

export interface RuntimeOptions {
  ps?: PsRunner;
  /** How long agent.start keeps retrying while the pane's shell is still starting. */
  shellReadyMs?: number;
  pollMs?: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parsePane(raw: Record<string, unknown>): PaneInfo {
  const tokens: Record<string, string> = {};
  const rawTokens = raw.tokens;
  if (rawTokens && typeof rawTokens === "object") {
    for (const [k, v] of Object.entries(rawTokens as Record<string, unknown>)) if (typeof v === "string") tokens[k] = v;
  }
  return {
    paneId: str(raw.pane_id),
    workspaceId: str(raw.workspace_id),
    cwd: str(raw.cwd),
    foregroundCwd: str(raw.foreground_cwd),
    agent: typeof raw.agent === "string" ? raw.agent : null,
    agentStatus: typeof raw.agent_status === "string" ? raw.agent_status : null,
    revision: typeof raw.revision === "number" ? raw.revision : null,
    tokens,
  };
}

function parseProcesses(raw: Record<string, unknown>): PaneProcesses {
  const list = Array.isArray(raw.foreground_processes) ? (raw.foreground_processes as Record<string, unknown>[]) : [];
  return {
    paneId: str(raw.pane_id),
    shellPid: Number(raw.shell_pid ?? 0),
    foregroundGroup: Number(raw.foreground_process_group_id ?? 0),
    processes: list.map((p) => ({
      pid: Number(p.pid ?? 0),
      name: str(p.name),
      argv0: str(p.argv0),
      argv: Array.isArray(p.argv) ? (p.argv as unknown[]).map(String) : [],
      cwd: str(p.cwd),
    })),
  };
}

export class HerdrRuntime {
  readonly transport: HerdrTransport;
  private readonly ps: PsRunner;
  private readonly shellReadyMs: number;
  private readonly pollMs: number;

  constructor(transport: HerdrTransport, options: RuntimeOptions = {}) {
    this.transport = transport;
    this.ps = options.ps ?? psRunner;
    this.shellReadyMs = options.shellReadyMs ?? 20_000;
    this.pollMs = options.pollMs ?? 200;
  }

  async ping(): Promise<void> {
    await this.transport.call("ping", {}, 3_000);
  }

  /** A new workspace rooted at `cwd`; its root pane is a plain shell. */
  async openWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; rootPaneId: string }> {
    const result = await this.transport.call("workspace.create", { cwd, label, focus: false });
    const workspace = result.workspace as Record<string, unknown> | undefined;
    const root = (result.root_pane ?? result.pane) as Record<string, unknown> | undefined;
    const workspaceId = str(workspace?.workspace_id);
    const rootPaneId = str(root?.pane_id);
    if (!workspaceId || !rootPaneId) throw new HerdrError("protocol", "workspace.create returned no workspace or root pane");
    return { workspaceId, rootPaneId };
  }

  /** Split a pane; `env` reaches the harness and its hooks (M0 h04). */
  async splitPane(targetPaneId: string, cwd: string, env: Record<string, string>): Promise<string> {
    const result = await this.transport.call("pane.split", { target_pane_id: targetPaneId, direction: "right", cwd, env, focus: false });
    const paneId = str((result.pane as Record<string, unknown> | undefined)?.pane_id);
    if (!paneId) throw new HerdrError("protocol", "pane.split returned no pane");
    return paneId;
  }

  /**
   * agent.start types the harness command into the pane's shell, so the shell
   * must be at its prompt; a fresh pane answers agent_pane_busy until it is.
   * Arguments must be single-line: Herdr refuses control characters
   * (invalid_agent_argument), which is why instructions travel in files.
   */
  async startAgent(paneId: string, launch: AgentLaunch): Promise<void> {
    const deadline = Date.now() + this.shellReadyMs;
    for (;;) {
      try {
        await this.transport.call("agent.start", { name: launch.name, kind: launch.kind, pane_id: paneId, args: launch.args, timeout_ms: 30_000 }, 40_000);
        return;
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy" || Date.now() > deadline) throw error;
        await Bun.sleep(this.pollMs * 2);
      }
    }
  }

  /** The pane's foreground processes, or null when the pane no longer exists. */
  async processes(paneId: string): Promise<PaneProcesses | null> {
    try {
      const result = await this.transport.call("pane.process_info", { pane_id: paneId });
      return parseProcesses((result.process_info as Record<string, unknown>) ?? {});
    } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") return null;
      throw error;
    }
  }

  /**
   * The harness running in a pane: the leader of the foreground process group
   * when that is not the shell and `matches` accepts it, with its start time
   * from ps (Herdr does not report one). Polls up to `waitMs`.
   */
  async harnessProcess(paneId: string, matches: (p: PaneProcess) => boolean, waitMs = 0): Promise<HarnessProcess | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const info = await this.processes(paneId);
      if (!info) return null;
      if (info.foregroundGroup !== 0 && info.foregroundGroup !== info.shellPid) {
        const leader = info.processes.find((p) => p.pid === info.foregroundGroup);
        if (leader && matches(leader)) {
          const identity = await readIdentity(leader.pid, this.ps);
          if (identity) return { identity, process: leader };
        }
      }
      if (Date.now() >= deadline) return null;
      await Bun.sleep(this.pollMs);
    }
  }

  async pane(paneId: string): Promise<PaneInfo | null> {
    try {
      const result = await this.transport.call("pane.get", { pane_id: paneId });
      return parsePane((result.pane as Record<string, unknown>) ?? {});
    } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") return null;
      throw error;
    }
  }

  /** Herdr's own agent status for a pane: rank-5 evidence, a hint only. */
  async agentStatus(paneId: string): Promise<string | null> {
    try {
      const result = await this.transport.call("agent.get", { target: paneId });
      const agent = result.agent as Record<string, unknown> | undefined;
      return typeof agent?.agent_status === "string" ? agent.agent_status : null;
    } catch (error) {
      if (error instanceof HerdrError && (error.code === "agent_not_found" || error.code === "pane_not_found")) return null;
      throw error;
    }
  }

  /** A Herdr notification, for P0 and batched attention (design section 9). */
  async notify(title: string, body: string): Promise<void> {
    await this.transport.call("notification.show", { title, body });
  }

  /** The only keystroke v1 sends is the interrupt key (design section 5). */
  async sendInterrupt(paneId: string): Promise<void> {
    await this.transport.call("pane.send_keys", { pane_id: paneId, keys: ["Escape"] });
  }

  async closePane(paneId: string): Promise<void> {
    try {
      await this.transport.call("pane.close", { pane_id: paneId });
    } catch (error) {
      if (!(error instanceof HerdrError && error.code === "pane_not_found")) throw error;
    }
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.transport.call("workspace.close", { workspace_id: workspaceId });
    } catch (error) {
      if (!(error instanceof HerdrError && error.code === "workspace_not_found")) throw error;
    }
  }

  /** Name the pane's run in its metadata, with no TTL (M0 h03), so the reconciler can find candidates. */
  async tagPane(paneId: string, runId: string, title: string): Promise<void> {
    await this.transport.call("pane.report_metadata", { pane_id: paneId, source: "flowryn", tokens: { [RUN_TOKEN]: runId }, title });
  }

  async snapshotPanes(): Promise<PaneInfo[]> {
    const result = await this.transport.call("session.snapshot", {});
    const snapshot = (result.snapshot as Record<string, unknown>) ?? result;
    const panes = Array.isArray(snapshot.panes) ? (snapshot.panes as Record<string, unknown>[]) : [];
    return panes.map(parsePane);
  }

  /**
   * Subscribe to pane events. They carry no revision (M0 h01), so they only
   * name panes to re-read; the reconciler never applies an event's contents.
   */
  subscribe(onEvent: (event: HerdrEvent) => void, onClose: (error: HerdrError | null) => void): Promise<Subscription> {
    return this.transport.subscribe(
      [{ type: "pane.updated" }, { type: "pane.exited" }, { type: "pane.closed" }, { type: "pane.agent_detected" }],
      onEvent,
      onClose,
    );
  }
}

/** The pane an event names, if any. */
export function eventPaneId(event: HerdrEvent): string | null {
  const data = event.data;
  if (typeof data.pane_id === "string") return data.pane_id;
  const pane = data.pane as Record<string, unknown> | undefined;
  return typeof pane?.pane_id === "string" ? pane.pane_id : null;
}
