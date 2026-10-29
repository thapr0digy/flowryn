import { HerdrError, type HerdrEvent, type HerdrTransport, type Subscription } from "./client.ts";
import { PsUnavailable, psRunner, readIdentity, type ProcIdentity, type PsRunner } from "../proc.ts";

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
  /** Null while the pane has no foreground job Herdr can name (the shell-to-job handoff, M0 h02): not started yet, never gone. */
  foregroundGroup: number | null;
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

const isPid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const malformedProcessInfo = (what: string) => new HerdrError("protocol", `pane.process_info: ${what}`);

/**
 * pane.process_info's answer (M0 h02). Its essential fields are checked, not
 * defaulted: a reply without a shell pid, or with a field of the wrong type,
 * says nothing about the pane, so it is `protocol` (liveness unknown to the
 * reconciler), never an empty pane whose harness looks gone. An absent or
 * null foreground group is Herdr's reply at the shell-to-job handoff (it
 * omits the process list then too): a pane with no job yet, `null`.
 */
function parseProcesses(raw: unknown): PaneProcesses {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw malformedProcessInfo("no process_info object");
  const info = raw as Record<string, unknown>;
  if (!isPid(info.shell_pid)) throw malformedProcessInfo("shell_pid is not a pid");
  const group = info.foreground_process_group_id ?? null;
  if (group !== null && (typeof group !== "number" || !Number.isInteger(group) || group < 0)) throw malformedProcessInfo("foreground_process_group_id is not a process group");
  const list = info.foreground_processes ?? (group === null ? [] : undefined);
  if (!Array.isArray(list)) throw malformedProcessInfo("foreground_processes is not a list");
  const processes = (list as unknown[]).map((entry) => {
    if (!entry || typeof entry !== "object" || !isPid((entry as Record<string, unknown>).pid)) throw malformedProcessInfo("a foreground process has no pid");
    const p = entry as Record<string, unknown>;
    return { pid: p.pid as number, name: str(p.name), argv0: str(p.argv0), argv: Array.isArray(p.argv) ? (p.argv as unknown[]).map(String) : [], cwd: str(p.cwd) };
  });
  return { paneId: str(info.pane_id), shellPid: info.shell_pid, foregroundGroup: group, processes };
}

export class HerdrRuntime {
  readonly transport: HerdrTransport;
  private readonly ps: PsRunner;
  private readonly shellReadyMs: number;
  private readonly pollMs: number;
  private workspaceOps: Promise<unknown> = Promise.resolve();

  constructor(transport: HerdrTransport, options: RuntimeOptions = {}) {
    this.transport = transport;
    this.ps = options.ps ?? psRunner;
    this.shellReadyMs = options.shellReadyMs ?? 20_000;
    this.pollMs = options.pollMs ?? 200;
  }

  async ping(): Promise<void> {
    await this.transport.call("ping", {}, 3_000);
  }

  /**
   * A new workspace rooted at `cwd`; its root pane is a plain shell. `env`
   * reaches that shell and whatever it launches, the harness and its hooks
   * included (M0 h04, h06), so a worker workspace holds one pane.
   */
  async openWorkspace(cwd: string, label: string, env: Record<string, string> = {}): Promise<{ workspaceId: string; rootPaneId: string }> {
    // focus:false keeps the user's focus where it is (M0 h07), so a launch needs no restore.
    const result = await this.serially(() => this.transport.call("workspace.create", { cwd, label, env, focus: false }));
    const workspace = result.workspace as Record<string, unknown> | undefined;
    const root = (result.root_pane ?? result.pane) as Record<string, unknown> | undefined;
    const workspaceId = str(workspace?.workspace_id);
    const rootPaneId = str(root?.pane_id);
    if (!workspaceId || !rootPaneId) throw new HerdrError("protocol", "workspace.create returned no workspace or root pane");
    return { workspaceId, rootPaneId };
  }

  /**
   * Workspace creates and closes run one at a time, so a close's prediction
   * of where Herdr moves focus is not skewed by another create or close.
   */
  private serially<T>(op: () => Promise<T>): Promise<T> {
    const result = this.workspaceOps.then(op);
    this.workspaceOps = result.catch(() => undefined);
    return result;
  }

  /** Workspace ids in Herdr's list order, and the focused one. */
  private async workspaceFocus(timeoutMs?: number): Promise<{ order: string[]; focused: string | null }> {
    const result = await this.transport.call("workspace.list", {}, timeoutMs);
    const list = Array.isArray(result.workspaces) ? (result.workspaces as Record<string, unknown>[]) : [];
    return { order: list.map((w) => str(w.workspace_id)), focused: str(list.find((w) => w.focused === true)?.workspace_id) || null };
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

  /** The pane's foreground processes, or null when the pane no longer exists; a malformed answer throws `protocol`. */
  async processes(paneId: string): Promise<PaneProcesses | null> {
    try {
      const result = await this.transport.call("pane.process_info", { pane_id: paneId });
      return parseProcesses(result.process_info);
    } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") return null;
      throw error;
    }
  }

  /**
   * The harness running in a pane: the leader of the foreground process group
   * when that is not the shell and `matches` accepts it, with its start time
   * from ps (Herdr does not report one). Polls up to `waitMs`, through reads
   * with no foreground group yet, and through a ps that cannot answer: one
   * still failing at the deadline is thrown, never read as no process.
   */
  async harnessProcess(paneId: string, matches: (p: PaneProcess) => boolean, waitMs = 0): Promise<HarnessProcess | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const info = await this.processes(paneId);
      if (!info) return null;
      let psFailure: PsUnavailable | null = null;
      if (info.foregroundGroup !== null && info.foregroundGroup !== 0 && info.foregroundGroup !== info.shellPid) {
        const leader = info.processes.find((p) => p.pid === info.foregroundGroup);
        if (leader && matches(leader)) {
          try {
            const identity = await readIdentity(leader.pid, this.ps);
            if (identity) return { identity, process: leader };
          } catch (error) {
            if (!(error instanceof PsUnavailable)) throw error;
            psFailure = error;
          }
        }
      }
      if (Date.now() >= deadline) {
        if (psFailure) throw psFailure;
        return null;
      }
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

  /**
   * The pane's recent text, ANSI stripped (Herdr pane.read). Requests
   * source "recent_unwrapped" rather than "recent": a secret can fall
   * across a soft-wrapped terminal line, and redactSecrets only catches it
   * whole when the line arrives unwrapped. Null when the pane is gone.
   * `ansi` keeps the escape codes, for a reader that needs the styling
   * (the leader rewake tells Claude's dim placeholder from a typed draft).
   */
  async readPane(paneId: string, lines: number, opts: { ansi?: boolean } = {}): Promise<string | null> {
    try {
      const result = await this.transport.call("pane.read", { pane_id: paneId, source: "recent_unwrapped", lines, strip_ansi: opts.ansi !== true });
      const read = result.read as Record<string, unknown> | undefined;
      return typeof read?.text === "string" ? read.text : null;
    } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") return null;
      throw error;
    }
  }

  /** A Herdr notification, for P0 and batched attention (design section 9). */
  async notify(title: string, body: string): Promise<void> {
    await this.transport.call("notification.show", { title, body });
  }

  /** The interrupt key (design section 5). */
  async sendInterrupt(paneId: string): Promise<void> {
    await this.transport.call("pane.send_keys", { pane_id: paneId, keys: ["Escape"] });
  }

  /**
   * Type one line into an idle harness's composer and submit it: the
   * idle-carry fallback for a Claude worker whose waiter is gone
   * (src/lifecycle/idle-carry.ts decides when). The line is Flowryn's own
   * fixed steer pointer, never a steer body; control characters are refused.
   */
  async typeLine(paneId: string, line: string): Promise<void> {
    // oxlint-disable-next-line no-control-regex -- one line of plain text, nothing the terminal would interpret
    if (/[\u0000-\u001f\u007f]/.test(line)) throw new HerdrError("invalid_params", "typeLine takes one line of plain text");
    await this.transport.call("pane.send_text", { pane_id: paneId, text: line });
    await this.transport.call("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  }

  async closePane(paneId: string): Promise<void> {
    try {
      await this.transport.call("pane.close", { pane_id: paneId });
    } catch (error) {
      if (!(error instanceof HerdrError && error.code === "pane_not_found")) throw error;
    }
  }

  /**
   * Close a workspace without taking the user's focus with it. Herdr moves
   * focus on any workspace.close, even of an unfocused workspace, to the one
   * that takes the closed one's slot (M0 h07). When the focus lands exactly
   * there, it goes back to the workspace that had it; focus anywhere else
   * means the user moved it meanwhile, and it stays. Nothing focused, or
   * closing the focused workspace itself, leaves focus to Herdr. Once the
   * close has succeeded, the restore is best effort and never fails it.
   */
  async closeWorkspace(workspaceId: string, timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const left = () => (deadline === undefined ? undefined : Math.max(0, deadline - Date.now()));
    await this.serially(async () => {
      // An unreadable list means an unreachable Herdr, which the close reports itself.
      const before = await this.workspaceFocus(left()).catch(() => null);
      try {
        await this.transport.call("workspace.close", { workspace_id: workspaceId }, left());
      } catch (error) {
        if (error instanceof HerdrError && error.code === "workspace_not_found") return;
        throw error;
      }
      if (before) await this.restoreFocus(before, workspaceId, left).catch(() => undefined);
    });
  }

  /** Put focus back on the workspace that had it, if Herdr's close moved it exactly to the closed one's slot. */
  private async restoreFocus(before: { order: string[]; focused: string | null }, closed: string, left: () => number | undefined): Promise<void> {
    const index = before.order.indexOf(closed);
    const previous = before.focused;
    if (index === -1 || previous === null || previous === closed || left() === 0) return;
    const remaining = before.order.filter((id) => id !== closed);
    const landing = remaining[Math.min(index, remaining.length - 1)];
    const after = await this.workspaceFocus(left());
    if (after.focused === landing && after.focused !== previous && after.order.includes(previous) && left() !== 0) {
      await this.transport.call("workspace.focus", { workspace_id: previous }, left());
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
