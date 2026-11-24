import { afterEach, describe, expect, test } from "bun:test";
import { allowedHost, allowedOrigin, DASHBOARD_PORT, DashboardServer, dashboardPort, PAGE_CSP, PAGE_HTML } from "../../src/dashboard/server.ts";

/** The dashboard's listener (docs/notes/2026-11-24-a-live-build-t8.md): loopback only, read-only, no CORS. */

const servers: DashboardServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function serve(status: () => string = () => JSON.stringify({ version: 1 }), retryMs = 30_000): { server: DashboardServer; lines: string[] } {
  const lines: string[] = [];
  const server = new DashboardServer({ choice: { port: 0 }, status, log: (l) => lines.push(l), retryMs });
  servers.push(server);
  server.start();
  return { server, lines };
}

function portOf(server: DashboardServer): number {
  return Number(new URL(server.state().url!).port);
}

function request(server: DashboardServer, path: string, init: { method?: string; host?: string; origin?: string } = {}): Response {
  const port = portOf(server);
  const headers = new Headers({ host: init.host ?? `127.0.0.1:${port}` });
  if (init.origin) headers.set("origin", init.origin);
  return server.handle(new Request(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "GET", headers }));
}

describe("dashboardPort", () => {
  test("your own daemon takes the fixed port", () => {
    expect(dashboardPort({})).toEqual({ port: DASHBOARD_PORT });
  });
  test("a home with notifications off (tests, lab, contract homes) serves none unless told", () => {
    expect("off" in dashboardPort({ FLOWRYN_NOTIFY: "off" })).toBe(true);
    expect(dashboardPort({ FLOWRYN_NOTIFY: "off", FLOWRYN_DASHBOARD_PORT: "0" })).toEqual({ port: 0 });
  });
  test("off, a number, and something that is not a port", () => {
    expect(dashboardPort({ FLOWRYN_DASHBOARD_PORT: "off" })).toEqual({ off: "FLOWRYN_DASHBOARD_PORT=off" });
    expect(dashboardPort({ FLOWRYN_DASHBOARD_PORT: "48000" })).toEqual({ port: 48_000 });
    expect("off" in dashboardPort({ FLOWRYN_DASHBOARD_PORT: "70000" })).toBe(true);
    expect("off" in dashboardPort({ FLOWRYN_DASHBOARD_PORT: "-1" })).toBe(true);
    expect("off" in dashboardPort({ FLOWRYN_DASHBOARD_PORT: "http" })).toBe(true);
  });
});

describe("allowedHost and allowedOrigin", () => {
  test("only this Mac itself on this port", () => {
    expect(allowedHost("127.0.0.1:4000", 4000)).toBe(true);
    expect(allowedHost("localhost:4000", 4000)).toBe(true);
    for (const host of ["evil.example:4000", "127.0.0.1", "127.0.0.1:4001", "0.0.0.0:4000", "[::1]:4000", "127.0.0.1.evil.example:4000", null]) expect(allowedHost(host, 4000)).toBe(false);
  });
  test("no Origin, or the page's own", () => {
    expect(allowedOrigin(null, 4000)).toBe(true);
    expect(allowedOrigin("http://127.0.0.1:4000", 4000)).toBe(true);
    expect(allowedOrigin("http://evil.example", 4000)).toBe(false);
    expect(allowedOrigin("http://127.0.0.1:4001", 4000)).toBe(false);
  });
});

describe("DashboardServer", () => {
  test("serves the page with a policy that allows only its own inline script and style", async () => {
    const { server } = serve();
    expect(server.state().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = request(server, "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe(PAGE_HTML);
    expect(page.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(PAGE_CSP).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(PAGE_CSP).not.toContain("unsafe-inline");
  });

  test("the JSON endpoint, with no CORS header and its guards", async () => {
    const { server } = serve(() => JSON.stringify({ version: 1, verifies: [] }));
    const reply = request(server, "/api/status");
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ version: 1, verifies: [] });
    for (const [name, value] of [["cache-control", "no-store"], ["x-content-type-options", "nosniff"], ["cross-origin-resource-policy", "same-origin"], ["referrer-policy", "no-referrer"]]) expect(reply.headers.get(name!)).toBe(value!);
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a non-loopback Host is refused (DNS rebinding), and a foreign Origin", () => {
    const { server } = serve();
    expect(request(server, "/api/status", { host: "evil.example" }).status).toBe(421);
    expect(request(server, "/api/status", { origin: "http://evil.example" }).status).toBe(403);
  });

  test("read-only: a write method is refused, an unknown path is not found, HEAD has no body", async () => {
    const { server } = serve();
    expect(request(server, "/api/status", { method: "POST" }).status).toBe(405);
    expect(request(server, "/api/status", { method: "DELETE" }).status).toBe(405);
    expect(request(server, "/app.js").status).toBe(404);
    const head = request(server, "/api/status", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("a real request over loopback: the browser's path", async () => {
    const { server } = serve();
    const reply = await fetch(`${server.state().url}api/status`);
    expect(reply.status).toBe(200);
  });

  test("one summary answers every tab for a second", () => {
    let built = 0;
    const { server } = serve(() => JSON.stringify({ n: ++built }));
    request(server, "/api/status");
    request(server, "/api/status");
    expect(built).toBe(1);
  });

  test("a summary that throws is a 500 with a fixed message, logged", async () => {
    const { server, lines } = serve(() => {
      throw new Error("boom /tmp/secret");
    });
    const reply = request(server, "/api/status");
    expect(reply.status).toBe(500);
    expect(await reply.text()).not.toContain("secret");
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
  });

  test("a taken port is logged and tried again, and the daemon goes on", async () => {
    const holder = serve().server;
    const lines: string[] = [];
    const second = new DashboardServer({ choice: { port: portOf(holder) }, status: () => "{}", log: (l) => lines.push(l), retryMs: 50 });
    servers.push(second);
    second.start();
    expect(second.state().url).toBeNull();
    expect(second.state().why).toContain("cannot listen");
    const port = portOf(holder);
    await holder.stop();
    await Bun.sleep(200);
    expect(second.state().url).toBe(`http://127.0.0.1:${port}/`);
  });

  test("off serves nothing and says why", () => {
    const server = new DashboardServer({ choice: { off: "FLOWRYN_DASHBOARD_PORT=off" }, status: () => "{}", log: () => {} });
    server.start();
    expect(server.state()).toEqual({ url: null, why: "FLOWRYN_DASHBOARD_PORT=off" });
  });

});

/**
 * The page's own script, run against a recording stand-in for the browser's document: any HTML
 * sink (innerHTML, outerHTML, insertAdjacentHTML, document.write) throws, and every element it
 * creates is recorded. HTML in the status must come out as text, never as an element.
 */
const HOSTILE = `<img src=x onerror="alert(1)">`;

interface FakeText {
  textContent: string;
}

class FakeElement {
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes: Record<string, string> = {};
  readonly style = { cssText: "" };
  readonly classList = { add: () => {}, remove: () => {} };
  className = "";
  #text: string | null = null;
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.#text ?? this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.children.length = 0;
    this.#text = String(value);
  }
  set innerHTML(_: string) {
    throw new Error("innerHTML set");
  }
  set outerHTML(_: string) {
    throw new Error("outerHTML set");
  }
  insertAdjacentHTML(): never {
    throw new Error("insertAdjacentHTML called");
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") throw new Error("a raw string appended");
      this.#text = null;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: (FakeElement | FakeText)[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }
  addEventListener(): void {}
}

async function renderPage(status: unknown): Promise<{ created: FakeElement[]; main: FakeElement }> {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)![1]!;
  const created: FakeElement[] = [];
  const byId = Object.fromEntries(["main", "as-of", "banner", "live"].map((id) => [id, new FakeElement("div")]));
  const document = {
    visibilityState: "hidden",
    body: new FakeElement("body"),
    createElement: (tag: string) => {
      const node = new FakeElement(tag);
      created.push(node);
      return node;
    },
    createTextNode: (text: string): FakeText => ({ textContent: String(text) }),
    getElementById: (id: string) => byId[id] ?? null,
    addEventListener: () => {},
    write: () => {
      throw new Error("document.write called");
    },
  };
  const fetch = async () => ({ ok: true, status: 200, json: async () => status });
  const run = new Function("document", "window", "navigator", "location", "fetch", "setTimeout", "clearTimeout", script);
  run(document, {}, {}, { reload: () => {} }, fetch, () => 0, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { created, main: byId.main! };
}

describe("the page", () => {
  test("renders HTML in the status as text, never as an element", async () => {
    const subject = { kind: "task", id: "t1", title: HOSTILE };
    const status = {
      build: "b1",
      now: 0,
      verifies: [
        {
          id: "v1",
          project: HOSTILE,
          for: subject,
          pr: null,
          elapsed_ms: 60_000,
          eta: null,
          eta_why: HOSTILE,
          steps: [{ name: HOSTILE, group: 0, state: "running", ms: null, elapsed_ms: 1_000, usual_ms: null, approx: false }],
          show: "flowryn verify show v1",
        },
      ],
      verify_queue: [{ id: "vq1", project: "web", for: subject, pr: null, position: 1, waited_ms: 0, why: HOSTILE, eta: { starts_in_ms: null, why: HOSTILE }, show: "flowryn verify show vq1" }],
      landing: [{ project: "web", batches: false, entries: [{ id: "lq1", task: "t2", title: HOSTILE, state: "waiting", place: "1.", cell: "", line: HOSTILE, since_ms: 0, show: "flowryn show t2" }], more: 0 }],
      batches: [{ id: "lb1", project: "web", state: "verifying", line: HOSTILE, verify: null, members: [{ task: "t3", pos: 1, state: "landing" }], show: "flowryn show lb1" }],
      waiting: { runs: [{ task: "t4", title: HOSTILE, stage: "work", needs: "worker", waited: "1 min", why: HOSTILE, show: "flowryn show t4" }], more: null },
      pools: [{ pool: "validation", used: 1, cap: 2 }],
      host: { ok: false, line: HOSTILE },
    };
    const { created, main } = await renderPage(status);
    expect(created.length).toBeGreaterThan(0);
    expect(created.map((node) => node.tag)).not.toContain("img");
    expect(created.flatMap((node) => Object.keys(node.attributes)).filter((name) => name.startsWith("on") || name === "srcdoc")).toEqual([]);
    expect(main.textContent.split(HOSTILE).length - 1).toBeGreaterThanOrEqual(8);
  });
});
