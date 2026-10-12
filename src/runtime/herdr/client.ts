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
  "pane.send_text",
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
/** How long events.subscribe may take to be acknowledged: an ordinary request's deadline, unless `[herdr] handshake_ms` says otherwise. */
export const DEFAULT_HANDSHAKE_MS = DEFAULT_TIMEOUT_MS;
const MAX_LINE = 8 * 1024 * 1024;
let nextId = 0;

/**
 * Methods only lab tooling may add. pane.send_text is also allowed now (the
 * idle-carry fallback, HerdrRuntime.typeLine); the lab scripts still name it.
 */
export const LAB_ONLY_METHODS = ["pane.send_text"] as const;

export class HerdrClient implements HerdrTransport {
  readonly socketPath: string;
  readonly handshakeMs: number;
  private readonly labMethods: ReadonlySet<string>;

  constructor(socketPath: string, options: { labMethods?: readonly (typeof LAB_ONLY_METHODS)[number][]; handshakeMs?: number } = {}) {
    this.socketPath = socketPath;
    this.labMethods = new Set(options.labMethods ?? []);
    this.handshakeMs = options.handshakeMs ?? DEFAULT_HANDSHAKE_MS;
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

  /**
   * Open the event stream. The handshake has the same kind of deadline as a
   * request (`handshakeMs`, from the start, so a hung connect counts): a peer
   * that never acknowledges fails as `timeout`. Only `{id, result: {type:
   * "subscription_started"}}` for this request is an acknowledgement; any
   * other first line is `protocol`. After it, a line that is not an event
   * closes the stream with `protocol` rather than being dropped, since an
   * event only names a pane to re-read and the caller's reconnect re-reads
   * every one.
   */
  subscribe(subscriptions: Record<string, unknown>[], onEvent: (event: HerdrEvent) => void, onClose: (error: HerdrError | null) => void): Promise<Subscription> {
    const id = `sub${++nextId}`;
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = "";
      let connected = false;
      let started = false;
      let closed = false;
      const close = (error: HerdrError | null) => {
        if (closed) return;
        closed = true;
        clearTimeout(handshake);
        socket.destroy();
        if (started) onClose(error);
        else reject(error ?? new HerdrError("protocol", "Herdr closed the subscription before it started"));
      };
      const handshake = setTimeout(() => close(new HerdrError("timeout", `Herdr did not acknowledge events.subscribe within ${this.handshakeMs} ms`)), this.handshakeMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        connected = true;
        socket.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          if (!started) {
            const refusal = acknowledgementProblem(line, id);
            if (refusal) return close(refusal);
            started = true;
            clearTimeout(handshake);
            resolve({ close: () => close(null) });
            continue;
          }
          const event = parseEvent(line);
          if (!event) return close(new HerdrError("protocol", `Herdr sent a line that is not an event: ${line.slice(0, 120)}`));
          onEvent(event);
          // The caller may close the stream from its handler.
          if (closed) return;
        }
        if (buffer.length > MAX_LINE) close(new HerdrError("protocol", started ? "Herdr event line is too large" : "Herdr's events.subscribe reply is too large"));
      });
      socket.on("error", (error: NodeJS.ErrnoException) => close(new HerdrError(connected ? "protocol" : "unreachable", `Herdr socket ${this.socketPath}: ${error.code ?? error.message}`)));
      socket.on("close", () =>
        close(started ? new HerdrError("closed", "Herdr closed the event subscription") : new HerdrError(connected ? "protocol" : "unreachable", "Herdr closed the subscription before it started")),
      );
      try {
        socket.connect(this.socketPath);
      } catch (error) {
        close(new HerdrError("unreachable", `Herdr socket ${this.socketPath}: ${(error as Error).message}`));
      }
    });
  }
}

function jsonObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why the first line of a subscription is not its acknowledgement: Herdr's refusal with its own code, or `protocol`; null when it is one. */
function acknowledgementProblem(line: string, id: string): HerdrError | null {
  const message = jsonObject(line);
  if (!message) return new HerdrError("protocol", "Herdr's events.subscribe reply is not a JSON object");
  const error = message.error as { code?: unknown; message?: unknown } | undefined;
  if (error && typeof error === "object") {
    return new HerdrError(typeof error.code === "string" ? error.code : "error", typeof error.message === "string" ? error.message : "subscription refused");
  }
  if (message.id !== id) return new HerdrError("protocol", `Herdr's events.subscribe reply answers ${JSON.stringify(message.id ?? null)}, not ${id}`);
  const result = message.result as { type?: unknown } | undefined;
  if (!result || typeof result !== "object" || result.type !== "subscription_started") {
    return new HerdrError("protocol", "Herdr's events.subscribe reply is not subscription_started");
  }
  return null;
}

/** An event line: a JSON object with a string `event` and, when present, an object `data`; null otherwise. */
function parseEvent(line: string): HerdrEvent | null {
  const message = jsonObject(line);
  if (!message || typeof message.event !== "string") return null;
  const data = message.data ?? {};
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return { event: message.event, data: data as Record<string, unknown> };
}
