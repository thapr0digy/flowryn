import net from "node:net";

/**
 * A client for Herdr's socket API (protocol 17, Herdr 0.7.5): one JSON line
 * `{id, method, params}` per request and one JSON line `{id, result | error}`
 * back. `events.subscribe` keeps its connection open and streams one event
 * per line after `subscription_started`.
 *
 * Only the methods in ALLOWED_METHODS can be called. Flowryn drives panes,
 * workspaces and agents; it never stops, reloads or hands off a Herdr server
 * or a session, so those methods are refused here before any byte is sent.
 */
export const ALLOWED_METHODS = new Set([
  "ping",
  "session.snapshot",
  "workspace.create",
  "workspace.get",
  "workspace.list",
  "workspace.close",
  "pane.get",
  "pane.list",
  "pane.process_info",
  "pane.read",
  "pane.send_keys",
  "pane.report_metadata",
  "pane.close",
  "agent.start",
  "agent.get",
  "events.subscribe",
  "notification.show",
]);

export class HerdrError extends Error {
  /** Herdr's own error code, or `unreachable`, `timeout`, `protocol` for transport failures. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface Subscription {
  close(): void;
}

export interface HerdrTransport {
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  subscribe(subscriptions: Record<string, unknown>[], onEvent: (event: HerdrEvent) => void, onClose: (error: HerdrError | null) => void): Promise<Subscription>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LINE = 8 * 1024 * 1024;
let nextId = 0;

/**
 * Methods only lab tooling may add (never the daemon): typing into a test
 * leader's composer is how a live bridge contract run plays you.
 */
export const LAB_ONLY_METHODS = ["pane.send_text"] as const;

export class HerdrClient implements HerdrTransport {
  readonly socketPath: string;
  private readonly labMethods: ReadonlySet<string>;

  constructor(socketPath: string, options: { labMethods?: readonly (typeof LAB_ONLY_METHODS)[number][] } = {}) {
    this.socketPath = socketPath;
    this.labMethods = new Set(options.labMethods ?? []);
  }

  private refusal(method: string): HerdrError | null {
    return ALLOWED_METHODS.has(method) || this.labMethods.has(method) ? null : new HerdrError("method_refused", `flowryn never calls Herdr ${method}`);
  }

  call(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const refused = this.refusal(method);
    if (refused) return Promise.reject(refused);
    const id = `f${++nextId}`;
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = "";
      let settled = false;
      let connected = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new HerdrError("timeout", `Herdr ${method} did not answer within ${timeoutMs} ms`))), timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        connected = true;
        socket.write(JSON.stringify({ id, method, params }) + "\n");
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE) return finish(() => reject(new HerdrError("protocol", `Herdr ${method} reply is too large`)));
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        finish(() => {
          let reply: { result?: Record<string, unknown>; error?: { code?: string; message?: string } };
          try {
            reply = JSON.parse(line);
          } catch {
            reject(new HerdrError("protocol", `Herdr ${method} reply is not JSON`));
            return;
          }
          if (reply.error) reject(new HerdrError(reply.error.code ?? "error", reply.error.message ?? `Herdr ${method} failed`));
          else resolve(reply.result ?? {});
        });
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        finish(() => reject(new HerdrError(connected ? "protocol" : "unreachable", `Herdr socket ${this.socketPath}: ${error.code ?? error.message}`)));
      });
      socket.on("close", () => finish(() => reject(new HerdrError(connected ? "protocol" : "unreachable", `Herdr closed the connection during ${method}`))));
      try {
        socket.connect(this.socketPath);
      } catch (error) {
        finish(() => reject(new HerdrError("unreachable", `Herdr socket ${this.socketPath}: ${(error as Error).message}`)));
      }
    });
  }

  subscribe(subscriptions: Record<string, unknown>[], onEvent: (event: HerdrEvent) => void, onClose: (error: HerdrError | null) => void): Promise<Subscription> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = "";
      let started = false;
      let closed = false;
      const close = (error: HerdrError | null) => {
        if (closed) return;
        closed = true;
        socket.destroy();
        if (started) onClose(error);
        else reject(error ?? new HerdrError("protocol", "Herdr closed the subscription before it started"));
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: `sub${++nextId}`, method: "events.subscribe", params: { subscriptions } }) + "\n");
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (!started) {
            const error = message.error as { code?: string; message?: string } | undefined;
            if (error) return close(new HerdrError(error.code ?? "error", error.message ?? "subscription refused"));
            started = true;
            resolve({ close: () => close(null) });
            continue;
          }
          if (typeof message.event === "string") onEvent({ event: message.event, data: (message.data as Record<string, unknown>) ?? {} });
        }
        if (buffer.length > MAX_LINE) close(new HerdrError("protocol", "Herdr event line is too large"));
      });
      socket.on("error", (error: NodeJS.ErrnoException) => close(new HerdrError(started ? "protocol" : "unreachable", `Herdr socket ${this.socketPath}: ${error.code ?? error.message}`)));
      socket.on("close", () => close(started ? new HerdrError("closed", "Herdr closed the event subscription") : null));
      try {
        socket.connect(this.socketPath);
      } catch (error) {
        close(new HerdrError("unreachable", `Herdr socket ${this.socketPath}: ${(error as Error).message}`));
      }
    });
  }
}
