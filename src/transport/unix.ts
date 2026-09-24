import { chmodSync } from "node:fs";
import net from "node:net";

/**
 * Transport seam (design section 12, Portability). v1 is a Unix socket on
 * macOS; Linux uses the same socket, and a Windows build would put a named
 * pipe behind these two functions. Nothing above this file knows the path
 * semantics. One request per connection: one JSON line in, one JSON line out.
 */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export type TransportFailure = "unavailable" | "timeout" | "protocol";

export class TransportError extends Error {
  readonly kind: TransportFailure;
  constructor(kind: TransportFailure, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

export interface Listener {
  close(): Promise<void>;
}

export type MessageHandler = (message: unknown) => Promise<unknown>;

/** Listen on a Unix socket; the socket file is made owner-only. Fails if the path already exists. */
export function listen(path: string, handler: MessageHandler, onError: (error: Error) => void): Promise<Listener> {
  const server = net.createServer((socket) => {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_MESSAGE_BYTES) {
        handled = true;
        socket.end(JSON.stringify({ ok: false, error: { code: "bad_envelope", message: "message too large" } }) + "\n");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      const line = buffer.slice(0, newline);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        socket.end(JSON.stringify({ ok: false, error: { code: "bad_envelope", message: "request is not JSON" } }) + "\n");
        return;
      }
      handler(message)
        .then((reply) => {
          if (!socket.destroyed) socket.end(JSON.stringify(reply) + "\n");
        })
        .catch((error: Error) => {
          onError(error);
          if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: { code: "internal", message: error.message } }) + "\n");
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.on("error", onError);
      chmodSync(path, 0o600);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export interface RequestTimeouts {
  connectMs: number;
  replyMs: number;
}

/** Send one message and read one reply. Connection failures are `unavailable`; a slow reply is `timeout`. */
export function request(path: string, message: unknown, timeouts: RequestTimeouts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Attach every handler before connecting: Bun reports a missing socket file synchronously.
    const socket = new net.Socket();
    let connected = false;
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(replyTimer);
      socket.destroy();
      fn();
    };
    const connectTimer = setTimeout(
      () => finish(() => reject(new TransportError("unavailable", `no daemon answered on ${path} within ${timeouts.connectMs} ms`))),
      timeouts.connectMs,
    );
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      replyTimer = setTimeout(
        () => finish(() => reject(new TransportError("timeout", `the daemon did not reply within ${timeouts.replyMs} ms`))),
        timeouts.replyMs,
      );
      socket.write(JSON.stringify(message) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new TransportError("protocol", "the daemon's reply is not JSON"));
        }
      });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const kind: TransportFailure = connected ? "timeout" : "unavailable";
      finish(() => reject(new TransportError(kind, `${path}: ${error.code ?? error.message}`)));
    });
    socket.on("close", () => {
      finish(() => reject(new TransportError(connected ? "protocol" : "unavailable", "the daemon closed the connection without a reply")));
    });
    try {
      socket.connect(path);
    } catch (error) {
      finish(() => reject(new TransportError("unavailable", `${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)));
    }
  });
}
