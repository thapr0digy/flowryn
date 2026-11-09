import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Recovering a broken Lavish server by itself (docs/notes/2026-11-08-recover-a-broken-7e.md), end
 * to end on the fake fleet: the test home's lavish-axi answers every poll and host with a server
 * error (HTTP 500, code: SERVER_ERROR) while $FLOWRYN_HOME/lavish-broken exists, and its `stop`
 * removes it, as a restart cured the real one on 2026-11-08.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const PAGE = filledDesignPage();
const STEPS = ["Feature open", `FAKE: write design/design.html ${PAGE}`, "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html", "FAKE: sleep 120000"].join("\n");

function one<T>(e: FleetEnv, sql: string, ...params: string[]): T | null {
  const db = e.h.db();
  try {
    return (db.query(sql).get(...params) as T | null) ?? null;
  } finally {
    db.close();
  }
}

function all<T>(e: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = e.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function calls(e: FleetEnv): string[] {
  const log = join(e.h.home, "lavish-calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

/** The fake fleet's worker hands in a design page; the daemon hosts its copy and polls it. */
async function handIn(e: ShipEnv): Promise<{ run: string; gate: string; page: string; token: string }> {
  const f = e.fleet;
  expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
  const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: STEPS });
  expect(dispatched.code).toBe(0);
  const { run } = dispatched.reply.data as { run: string };
  await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
  const gate = one<{ id: string; page_path: string }>(f, "SELECT id, page_path FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
  await waitUntil(() => calls(f).some((c) => c.startsWith(`poll ${gate.page_path}`)), 10_000, "the daemon's poll of the page");
  const pane = [...f.herdr.panes.values()].find((p) => p.env.FLOWRYN_RUN === run)!;
  return { run, gate: gate.id, page: gate.page_path, token: pane.env.FLOWRYN_TOKEN! };
}

function failures(e: FleetEnv, gate: string): number {
  return one<{ n: number }>(e, "SELECT channel_failures AS n FROM gates WHERE id = ?1", gate)!.n;
}

function breakLavish(e: FleetEnv): void {
  writeFileSync(join(e.h.home, "lavish-broken"), "");
}

/** A chat message the user sends on the page, in lavish-axi poll's own output. */
function queueMessage(e: FleetEnv, n: number, text: string): void {
  const dir = join(e.h.home, "lavish-queue");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(n).padStart(3, "0")}.out`), `session:\n  file: /x/design.html\n  status: feedback\nprompts[1]{uid,prompt,selector,tag,text}:\n  "",${text},"",message,Freeform message\n`);
}

describe("a broken Lavish server recovers by itself", () => {
  test("a worker's lavish recover restarts it, hosts the page again, the poll resumes with the queued answer; a second breakage within 10 minutes raises the P1", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const e = ship;
    const f = e.fleet;
    const { gate, page, token } = await handIn(e);
    const worker = { env: { FLOWRYN_TOKEN: token } };

    // The server breaks while the daemon's poll waits: that poll fails.
    breakLavish(f);
    await waitUntil(() => failures(f, gate) >= 1, 10_000, "the failed poll recorded");
    // What the user sends meanwhile stays queued in Lavish (the fake's queue) until a poll delivers it.
    queueMessage(f, 1, "Please add the stop timeout to the spec");

    const recovered = await f.json(["lavish", "recover"], worker);
    expect(recovered.code).toBe(0);
    expect(recovered.reply.data).toMatchObject({ state: "restarted", pages: 1 });
    expect(JSON.stringify(recovered.reply)).toContain("run your lavish-axi command again");
    const log = calls(f);
    const stopAt = log.indexOf("stop");
    expect(stopAt).toBeGreaterThan(-1);
    expect(log.filter((c) => c === "stop")).toHaveLength(1);
    // After the stop: the page is hosted again, then polled again.
    const after = log.slice(stopAt + 1);
    expect(after.some((c) => c === `${page} --no-open`)).toBe(true);
    await waitUntil(() => calls(f).slice(stopAt + 1).some((c) => c.startsWith(`poll ${page}`)), 10_000, "the poll resumed");
    // The answer queued during the breakage reaches the review's conversation.
    await waitUntil(() => one(f, "SELECT 1 FROM review_messages WHERE gate_id = ?1 AND author = 'user' AND body LIKE '%stop timeout%'", gate) !== null, 10_000, "the queued message delivered");
    const restarted = all<{ payload: string }>(f, "SELECT payload FROM events WHERE kind = 'lavish.restarted'");
    expect(restarted).toHaveLength(1);
    expect(JSON.parse(restarted[0]!.payload)).toMatchObject({ pages: 1, failed: [], ok: true });
    expect(JSON.parse(restarted[0]!.payload).by).toStartWith("worker:");

    // It breaks again within ten minutes: no second restart, one P1, and the worker is told to report blocked.
    breakLavish(f);
    const again = await f.json(["lavish", "recover"], worker);
    expect(again.code).toBe(0);
    expect(again.reply.data).toMatchObject({ state: "gave_up" });
    expect(JSON.stringify(again.reply)).toContain("report blocked naming that item");
    expect(calls(f).filter((c) => c === "stop")).toHaveLength(1);
    const items = all<{ id: string; lane: string; state: string; line: string }>(f, "SELECT id, lane, state, COALESCE(full_line, line) AS line FROM items WHERE kind = 'lavish_broken'");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ lane: "P1", state: "open", id: (again.reply.data as { item: string }).item });
    expect(items[0]!.line).toStartWith("Lavish keeps failing (");
    expect(all(f, "SELECT 1 FROM events WHERE kind = 'lavish.gave_up'")).toHaveLength(1);
  });

  test("the daemon's own poll failing twice with a server error restarts Lavish without the worker or the leader", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const e = ship;
    const f = e.fleet;
    const { page } = await handIn(e);
    breakLavish(f);
    await waitUntil(() => one(f, "SELECT 1 FROM events WHERE kind = 'lavish.restarted'") !== null, 20_000, "the automatic restart");
    const restarted = JSON.parse(one<{ payload: string }>(f, "SELECT payload FROM events WHERE kind = 'lavish.restarted'")!.payload);
    expect(restarted).toMatchObject({ by: "daemon", pages: 1, ok: true });
    expect(restarted.reason).toContain("failed twice with a server error");
    expect(all(f, "SELECT 1 FROM events WHERE kind = 'lavish.broken'")).toHaveLength(1);
    const stopAt = calls(f).indexOf("stop");
    await waitUntil(() => calls(f).slice(stopAt + 1).some((c) => c.startsWith(`poll ${page}`)), 10_000, "the poll resumed");
    expect(all(f, "SELECT 1 FROM items WHERE kind = 'lavish_broken'")).toHaveLength(0);
  });

  test("one page the server keeps failing while the probe hosts asks for one check, not one per backoff", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const e = ship;
    const f = e.fleet;
    const { gate } = await handIn(e);
    writeFileSync(join(f.h.home, "lavish-page-broken"), "");
    await waitUntil(() => one(f, "SELECT 1 FROM events WHERE kind = 'lavish.probe_ok'") !== null, 20_000, "the first check");
    await waitUntil(() => failures(f, gate) >= 4, 30_000, "two more backoff cycles");
    expect(all(f, "SELECT 1 FROM events WHERE kind = 'lavish.probe_ok'")).toHaveLength(1);
    expect(calls(f).filter((c) => c.includes("lavish-probe"))).toHaveLength(1);
    expect(calls(f).filter((c) => c === "stop")).toHaveLength(0);
  });

  test("a leader cannot run lavish recover", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const e = ship;
    const refused = await e.fleet.json(["lavish", "recover"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
    expect(refused.code).not.toBe(0);
    expect(calls(e.fleet).filter((c) => c === "stop")).toHaveLength(0);
  });
});
