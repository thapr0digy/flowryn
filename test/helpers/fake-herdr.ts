import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, openSync, closeSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";

/**
 * A stand-in for Herdr's socket API (protocol 17) for tests that cannot reach
 * a real Herdr: the methods Flowryn's runtime calls, with the reply shapes the
 * lab showed (docs/m2-notes.md). agent.start spawns the fake harness as a real
 * process in its own process group, so the daemon's process-table identity
 * checks run for real. The pane's "shell" is this test process.
 */

export const FAKE_HARNESS = resolve(import.meta.dir, "fake-harness.ts");

interface FakePane {
  paneId: string;
  workspaceId: string;
  cwd: string;
  env: Record<string, string>;
  tokens: Record<string, string>;
  title: string | null;
  revision: number;
  child: ChildProcess | null;
  kind: string | null;
  args: string[];
  starts: number;
}

interface FakeWorkspace {
  workspaceId: string;
  cwd: string;
  label: string;
  panes: string[];
  nextPane: number;
}

export interface FakeHerdrOptions {
  /** Environment every harness inherits (the test's clean env). */
  env: Record<string, string>;
  /** Where each harness's stdout and stderr go. */
  logDir: string;
}

export class FakeHerdr {
  readonly socket: string;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly workspaces = new Map<string, FakeWorkspace>();
  readonly panes = new Map<string, FakePane>();
  /** Methods made to fail with `{code}` while set (for example agent_pane_busy once). */
  readonly failNext = new Map<string, string[]>();
  /** Agent statuses to report for panes regardless of their process: Herdr's own inference, which can be stale. */
  readonly statusOverride = new Map<string, string>();
  private readonly subscribers = new Set<net.Socket>();
  private readonly server: net.Server;
  private readonly options: FakeHerdrOptions;
  private nextWorkspace = 1;

  private constructor(socket: string, options: FakeHerdrOptions) {
    this.socket = socket;
    this.options = options;
    this.server = net.createServer((conn) => this.accept(conn));
  }

  static async start(socket: string, options: FakeHerdrOptions): Promise<FakeHerdr> {
    const fake = new FakeHerdr(socket, options);
    await new Promise<void>((done, fail) => {
      fake.server.once("error", fail);
      fake.server.listen(socket, () => done());
    });
    chmodSync(socket, 0o600);
    return fake;
  }

  async stop(): Promise<void> {
    for (const pane of this.panes.values()) this.killChild(pane, "SIGKILL");
    for (const sub of this.subscribers) sub.destroy();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  /** The harness process in a pane, if any is alive. */
  harnessPid(paneId: string): number | null {
    const child = this.panes.get(paneId)?.child;
    return child && child.exitCode === null && child.signalCode === null ? (child.pid ?? null) : null;
  }

  /** Kill a pane's harness the way a crash would, leaving the pane as a husk. */
  killHarness(paneId: string, signal: NodeJS.Signals = "SIGKILL"): void {
    const pane = this.panes.get(paneId);
    if (pane) this.killChild(pane, signal);
  }

  /** Every pane with a harness in it. */
  livePanes(): string[] {
    return [...this.panes.values()].filter((p) => this.harnessPid(p.paneId) !== null).map((p) => p.paneId);
  }

  /** A pane for a process this fake did not start (a leader in your terminal), reporting `status`. */
  addPaneWithStatus(cwd: string, status: string): string {
    const ws = this.createWorkspace(cwd, "leader");
    const paneId = ws.panes[0]!;
    this.statusOverride.set(paneId, status);
    return paneId;
  }

  /** Add a pane Flowryn did not create, carrying a run's label, to exercise the orphan scan. */
  addForeignPane(tokens: Record<string, string>, cwd: string): string {
    const ws = this.createWorkspace(cwd, "foreign");
    const pane = this.panes.get(ws.panes[0]!)!;
    pane.tokens = { ...tokens };
    return pane.paneId;
  }

  private killChild(pane: FakePane, signal: NodeJS.Signals): void {
    const pid = this.harnessPid(pane.paneId);
    if (pid === null) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  }

  private accept(conn: net.Socket): void {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("error", () => conn.destroy());
    conn.on("close", () => this.subscribers.delete(conn));
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: { id?: string; method?: string; params?: Record<string, unknown> };
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        const method = String(request.method ?? "");
        const params = request.params ?? {};
        this.calls.push({ method, params });
        if (method === "events.subscribe") {
          this.subscribers.add(conn);
          conn.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
          continue;
        }
        let reply: Record<string, unknown>;
        const injected = this.failNext.get(method)?.shift();
        if (injected) reply = { id: request.id, error: { code: injected, message: `injected ${injected}` } };
        else {
          try {
            reply = { id: request.id, result: this.handle(method, params) };
          } catch (error) {
            const e = error as { code?: string; message?: string };
            reply = { id: request.id, error: { code: e.code ?? "error", message: e.message ?? String(error) } };
          }
        }
        conn.write(JSON.stringify(reply) + "\n");
      }
    });
  }

  private emit(event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ event, data }) + "\n";
    for (const sub of this.subscribers) sub.write(line);
  }

  private paneView(pane: FakePane): Record<string, unknown> {
    const alive = this.harnessPid(pane.paneId) !== null;
    return {
      pane_id: pane.paneId,
      workspace_id: pane.workspaceId,
      cwd: pane.cwd,
      foreground_cwd: pane.cwd,
      agent: alive ? pane.kind : undefined,
      agent_status: this.statusOverride.get(pane.paneId) ?? (alive ? "working" : "unknown"),
      tokens: pane.tokens,
      title: pane.title,
      revision: pane.revision,
    };
  }

  private need(paneId: unknown): FakePane {
    const pane = this.panes.get(String(paneId));
    if (!pane) throw Object.assign(new Error(`pane ${String(paneId)} not found`), { code: "pane_not_found" });
    return pane;
  }

  private createWorkspace(cwd: string, label: string): FakeWorkspace {
    const workspaceId = `w${this.nextWorkspace++}`;
    const ws: FakeWorkspace = { workspaceId, cwd, label, panes: [], nextPane: 1 };
    this.workspaces.set(workspaceId, ws);
    this.addPane(ws, cwd, {});
    return ws;
  }

  private addPane(ws: FakeWorkspace, cwd: string, env: Record<string, string>): FakePane {
    const pane: FakePane = { paneId: `${ws.workspaceId}:p${ws.nextPane++}`, workspaceId: ws.workspaceId, cwd, env, tokens: {}, title: null, revision: 0, child: null, kind: null, args: [], starts: 0 };
    this.panes.set(pane.paneId, pane);
    ws.panes.push(pane.paneId);
    return pane;
  }

  private closePane(pane: FakePane): void {
    this.killChild(pane, "SIGKILL");
    this.panes.delete(pane.paneId);
    const ws = this.workspaces.get(pane.workspaceId);
    if (ws) ws.panes = ws.panes.filter((p) => p !== pane.paneId);
    this.emit("pane_closed", { pane_id: pane.paneId });
  }

  private startHarness(pane: FakePane, kind: string, args: string[]): void {
    const log = openSync(join(this.options.logDir, `${pane.paneId.replace(":", "-")}-${++pane.starts}.log`), "a");
    const child = spawn("bun", [FAKE_HARNESS, kind, ...args], {
      cwd: pane.cwd,
      env: { ...this.options.env, ...pane.env },
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    pane.child = child;
    pane.kind = kind;
    pane.args = args;
    pane.revision++;
    child.on("exit", () => {
      pane.revision++;
      this.emit("pane.agent_status_changed", { pane_id: pane.paneId, agent_status: "unknown" });
    });
    this.emit("pane_updated", { pane: this.paneView(pane) });
  }

  private handle(method: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "ping":
        return { type: "pong" };
      case "workspace.create": {
        const ws = this.createWorkspace(String(params.cwd ?? "/"), String(params.label ?? ""));
        return { type: "workspace_created", workspace: { workspace_id: ws.workspaceId }, root_pane: this.paneView(this.panes.get(ws.panes[0]!)!) };
      }
      case "workspace.close": {
        const ws = this.workspaces.get(String(params.workspace_id));
        if (!ws) throw Object.assign(new Error("workspace not found"), { code: "workspace_not_found" });
        for (const id of ws.panes) this.closePane(this.panes.get(id)!);
        this.workspaces.delete(ws.workspaceId);
        return { type: "ok" };
      }
      case "pane.split": {
        const target = this.need(params.target_pane_id);
        const ws = this.workspaces.get(target.workspaceId)!;
        const pane = this.addPane(ws, String(params.cwd ?? target.cwd), (params.env as Record<string, string>) ?? {});
        return { type: "pane_info", pane: this.paneView(pane) };
      }
      case "agent.start": {
        const pane = this.need(params.pane_id);
        if (this.harnessPid(pane.paneId) !== null) throw Object.assign(new Error(`agent target pane ${pane.paneId} is not an available shell`), { code: "agent_pane_busy" });
        const args = (params.args as string[]) ?? [];
        // oxlint-disable-next-line no-control-regex -- Herdr refuses control characters in agent arguments
        if (args.some((a) => /[\u0000-\u001f]/.test(a))) throw Object.assign(new Error("agent arguments cannot be encoded safely"), { code: "invalid_agent_argument" });
        this.startHarness(pane, String(params.kind), args);
        return { type: "agent_started", agent: { pane_id: pane.paneId, launch_pending: true } };
      }
      case "pane.process_info": {
        const pane = this.need(params.pane_id);
        const pid = this.harnessPid(pane.paneId);
        const shell = { pid: process.pid, name: "zsh", argv0: "-zsh", argv: ["-zsh"], cmdline: "-zsh", cwd: pane.cwd };
        const harness = pid === null ? null : { pid, name: pane.kind, argv0: pane.kind, argv: [pane.kind, ...pane.args], cmdline: pane.kind, cwd: pane.cwd };
        return {
          type: "pane_process_info",
          process_info: { pane_id: pane.paneId, shell_pid: process.pid, foreground_process_group_id: pid ?? process.pid, foreground_processes: harness ? [harness] : [shell] },
        };
      }
      case "pane.get":
        return { type: "pane_info", pane: this.paneView(this.need(params.pane_id)) };
      case "agent.get": {
        const pane = this.need(params.target);
        const override = this.statusOverride.get(pane.paneId);
        if (override) return { type: "agent_info", agent: { pane_id: pane.paneId, agent_status: override, revision: pane.revision } };
        if (this.harnessPid(pane.paneId) === null) throw Object.assign(new Error("agent not found"), { code: "agent_not_found" });
        return { type: "agent_info", agent: { pane_id: pane.paneId, agent_status: "working", revision: pane.revision } };
      }
      case "pane.send_keys": {
        const pane = this.need(params.pane_id);
        const pid = this.harnessPid(pane.paneId);
        if (pid !== null && (params.keys as string[]).includes("Escape")) process.kill(pid, "SIGINT");
        return { type: "ok" };
      }
      case "pane.report_metadata": {
        const pane = this.need(params.pane_id);
        pane.tokens = { ...pane.tokens, ...(params.tokens as Record<string, string> | undefined) };
        if (typeof params.title === "string") pane.title = params.title;
        return { type: "ok" };
      }
      case "pane.close":
        this.closePane(this.need(params.pane_id));
        return { type: "ok" };
      case "notification.show":
        return { type: "ok" };
      case "session.snapshot":
        return { type: "session_snapshot", snapshot: { panes: [...this.panes.values()].map((p) => this.paneView(p)), agents: [] } };
      default:
        throw Object.assign(new Error(`fake Herdr does not implement ${method}`), { code: "unknown_method" });
    }
  }
}
