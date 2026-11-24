import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { cliJson, makeHome, readText, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * The live build page through a real daemon (docs/notes/2026-11-24-a-live-build-t8.md): the
 * daemon serves it on 127.0.0.1 (FLOWRYN_DASHBOARD_PORT=0 here: any free port), `ping` and
 * `flowryn dashboard` name it, it refuses a foreign Host, and it comes back after a restart.
 * The summary's contents over a seeded fleet are test/unit/dashboard-status.test.ts.
 */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const h of homes.splice(0)) h.cleanup();
});

function home(): TestHome {
  const h = makeHome();
  homes.push(h);
  return h;
}

async function daemon(h: TestHome, env: Record<string, string> = {}): Promise<DaemonProc> {
  const d = await startDaemon(h, env);
  daemons.push(d);
  return d;
}

/** One raw HTTP/1.1 request with exactly this Host header (fetch would set its own); the status code. */
function rawStatus(port: number, host: string, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`${method} /api/status HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}

async function dashboardUrl(h: TestHome): Promise<string> {
  const { code, reply } = await cliJson(h, ["dashboard"]);
  expect(code).toBe(0);
  return (reply.data as { url: string }).url;
}

describe("flowryn dashboard", () => {
  test("the daemon serves the page and its summary on loopback; the verb prints and opens the URL", async () => {
    const h = home();
    await daemon(h, { FLOWRYN_DASHBOARD_PORT: "0" });
    const { code, reply } = await cliJson(h, ["dashboard"]);
    expect(code).toBe(0);
    const data = reply.data as { url: string; browser: string };
    expect(data.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(data.browser).toStartWith("opened in ");
    expect(readText(join(h.home, "browser-opens.log"))).toContain(`\t${data.url}`);

    const page = await fetch(data.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Flowryn builds</title>");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

    const status = (await (await fetch(`${data.url}api/status`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ version: 1, verifies: [], verify_queue: [], landing: [], batches: [] });
    expect(Array.isArray(status.pools)).toBe(true);

    const ping = await cliJson(h, ["daemon", "status"]);
    expect(ping.code).toBe(0);
  });

  test("a non-loopback Host is refused, a write method too, and no reply carries CORS", async () => {
    const h = home();
    await daemon(h, { FLOWRYN_DASHBOARD_PORT: "0" });
    const url = await dashboardUrl(h);
    const port = Number(new URL(url).port);
    expect(await rawStatus(port, "evil.example")).toBe(421);
    expect(await rawStatus(port, `attacker.example:${port}`)).toBe(421);
    expect(await rawStatus(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await rawStatus(port, `localhost:${port}`)).toBe(200);
    expect(await rawStatus(port, `127.0.0.1:${port}`, "POST")).toBe(405);
    const reply = await fetch(`${url}api/status`, { headers: { Origin: "http://evil.example" } });
    expect(reply.status).toBe(403);
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("assumption: a test or lab home (FLOWRYN_NOTIFY=off, no override) binds no port, and says why", async () => {
    const h = home();
    await daemon(h);
    const { code, reply } = await cliJson(h, ["dashboard"]);
    expect(code).not.toBe(0);
    expect((reply.error as { code: string; message: string }).code).toBe("not_ready");
    expect((reply.error as { message: string }).message).toContain("FLOWRYN_NOTIFY=off");
    expect(existsSync(join(h.home, "browser-opens.log"))).toBe(false);
  });

  test("the daemon down: the verb says so", async () => {
    const h = home();
    const { code, reply } = await cliJson(h, ["dashboard"]);
    expect(code).not.toBe(0);
    expect((reply.error as { code: string }).code).toBe("daemon_unavailable");
  });

  test("after a daemon restart the same address serves again: the page reconnects by polling", async () => {
    const h = home();
    const first = await daemon(h, { FLOWRYN_DASHBOARD_PORT: "0" });
    const url = await dashboardUrl(h);
    const port = new URL(url).port;
    expect(await first.stop()).toBe(0);
    daemons.splice(daemons.indexOf(first), 1);
    await expect(fetch(`${url}api/status`)).rejects.toThrow();
    await daemon(h, { FLOWRYN_DASHBOARD_PORT: port });
    expect(await dashboardUrl(h)).toBe(url);
    expect((await fetch(`${url}api/status`)).status).toBe(200);
  });
});
