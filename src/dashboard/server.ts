import { notificationsOff } from "../config/leader.ts";
import pageAsset from "./page.html" with { type: "text" };

/**
 * The dashboard's listener (docs/notes/2026-11-24-a-live-build-t8.md): one read-only page and its
 * JSON on 127.0.0.1 at a fixed port, served by the daemon. It never changes state, answers only
 * requests addressed to this Mac itself (a DNS-rebinding guard), sets no CORS header, and never
 * fails the daemon: a port that is taken is logged and tried again.
 */

/** Below macOS's ephemeral range (49152+). */
export const DASHBOARD_PORT = 47820;
/** How long one built summary answers every tab. */
const CACHE_MS = 1_000;
/** How often a taken port is tried again (a restart's old daemon may still hold it). */
const RETRY_MS = 30_000;

/** Bun types an `.html` import as a bundle; imported as text it is the file's contents. */
export const PAGE_HTML = pageAsset as unknown as string;

export type PortChoice = { port: number } | { off: string };

/**
 * Which port this daemon serves on. FLOWRYN_DASHBOARD_PORT=<n> (0: any free port, the tests) or
 * `off` decides it; otherwise the fixed port, except in a home with FLOWRYN_NOTIFY=off (the tests,
 * the lab, the contract homes), which serves none: only your own daemon takes the fixed port.
 */
export function dashboardPort(env: NodeJS.ProcessEnv): PortChoice {
  const raw = env.FLOWRYN_DASHBOARD_PORT?.trim();
  if (raw === "off") return { off: "FLOWRYN_DASHBOARD_PORT=off" };
  if (raw !== undefined && raw !== "") {
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || port > 65_535) return { off: `FLOWRYN_DASHBOARD_PORT=${raw.slice(0, 20)} is not a port (0-65535 or off)` };
    return { port };
  }
  if (notificationsOff(env)) return { off: "FLOWRYN_NOTIFY=off marks a test or lab home; set FLOWRYN_DASHBOARD_PORT to serve one" };
  return { port: DASHBOARD_PORT };
}

/** The Host header of a request addressed to this Mac itself on this port. */
export function allowedHost(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** An Origin header is absent (a plain navigation or fetch from a tool) or this page's own. */
export function allowedOrigin(origin: string | null, port: number): boolean {
  return origin === null || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function inlineHash(html: string, tag: "script" | "style"): string {
  const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1];
  if (body === undefined) throw new Error(`the dashboard page has no inline <${tag}>`);
  return `'sha256-${new Bun.CryptoHasher("sha256").update(body).digest("base64")}'`;
}

/** The page's policy: only its own inline script and style (by hash) and its own origin's JSON. */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${inlineHash(PAGE_HTML, "script")}`,
  `style-src ${inlineHash(PAGE_HTML, "style")}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export interface DashboardState {
  url: string | null;
  /** Why there is no URL: off, or the port is taken (tried again). */
  why: string | null;
}

export interface DashboardDeps {
  choice: PortChoice;
  /** The summary as JSON text, built on demand. */
  status(): string;
  log(line: string): void;
  now?: () => number;
  retryMs?: number;
}

export class DashboardServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private why: string | null;
  private cache: { at: number; body: string } | null = null;
  private stopped = false;

  constructor(private readonly deps: DashboardDeps) {
    this.why = "off" in deps.choice ? deps.choice.off : "not started";
  }

  /** Bind now, or log why not and try again later. */
  start(): void {
    if (this.stopped || this.server || "off" in this.deps.choice) return;
    const port = this.deps.choice.port;
    try {
      this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => this.handle(request) });
      this.why = null;
      this.deps.log(`dashboard: serving ${this.state().url}`);
    } catch (error) {
      this.why = `cannot listen on 127.0.0.1:${port} (${(error as Error).message}); tried again every ${(this.deps.retryMs ?? RETRY_MS) / 1000} s`;
      this.deps.log(`dashboard: ${this.why}`);
      this.retry = setTimeout(() => {
        this.retry = null;
        this.start();
      }, this.deps.retryMs ?? RETRY_MS);
    }
  }

  state(): DashboardState {
    return this.server ? { url: `http://127.0.0.1:${this.server.port}/`, why: null } : { url: null, why: this.why };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const server = this.server;
    this.server = null;
    this.why = "the daemon stopped";
    if (server) await server.stop(true);
  }

  private statusBody(): string {
    const now = (this.deps.now ?? Date.now)();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.body;
    const body = this.deps.status();
    this.cache = { at: now, body };
    return body;
  }

  handle(request: Request): Response {
    const port = this.server?.port ?? ("port" in this.deps.choice ? this.deps.choice.port : 0);
    if (!allowedHost(request.headers.get("host"), port)) return new Response(null, { status: 421, headers: COMMON_HEADERS });
    if (!allowedOrigin(request.headers.get("origin"), port)) return new Response(null, { status: 403, headers: COMMON_HEADERS });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...COMMON_HEADERS, Allow: "GET, HEAD" } });
    const path = new URL(request.url).pathname;
    const reply = (body: string, type: string, extra: Record<string, string> = {}) =>
      new Response(request.method === "HEAD" ? null : body, { headers: { ...COMMON_HEADERS, "Content-Type": type, ...extra } });
    if (path === "/") return reply(PAGE_HTML, "text/html; charset=utf-8", { "Content-Security-Policy": PAGE_CSP });
    if (path === "/api/status") {
      try {
        return reply(this.statusBody(), "application/json; charset=utf-8");
      } catch (error) {
        this.deps.log(`dashboard: the summary failed: ${(error as Error).message}`);
        return new Response(JSON.stringify({ error: "the summary could not be built; see the daemon log" }), { status: 500, headers: { ...COMMON_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
      }
    }
    return new Response(null, { status: 404, headers: COMMON_HEADERS });
  }
}
