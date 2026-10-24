import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { filledDesignPage } from "../helpers/design-page.ts";

/**
 * Review pages open in your browser (docs/notes/2026-10-10-review-pages-open-4b.md), end to
 * end on the fake fleet: the fake worker hands in a design page with stage done, the daemon's
 * poll of it starts (the test home's lavish-axi stand-in), and the opener hands the page to the
 * browser. The test home's FLOWRYN_OPENER records each open to browser-opens.log instead of
 * running /usr/bin/open, and its recorded presence is listening.
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

async function handIn(e: ShipEnv): Promise<{ task: string; run: string; gate: { id: string; review_url: string } }> {
  const f = e.fleet;
  expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
  const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: STEPS });
  expect(dispatched.code).toBe(0);
  const { task, run } = dispatched.reply.data as { task: string; run: string };
  await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
  const gate = one<{ id: string; review_url: string }>(f, "SELECT id, review_url FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
  return { task, run, gate };
}

async function gateLine(e: ShipEnv, task: string, gateId: string): Promise<string> {
  const shown = await e.fleet.json(["show", task], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
  return (shown.reply.data as { gates: string[] }).gates.find((l) => l.startsWith(`${gateId} `))!;
}

describe("review pages open in your browser", () => {
  test("once the gate's poll runs, the page goes to the browser; the item and show say it opened", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const e = ship;
    const f = e.fleet;
    const opens = join(f.h.home, "browser-opens.log");
    const { task, run, gate } = await handIn(e);

    await waitUntil(() => one<{ open_state: string }>(f, "SELECT open_state FROM gates WHERE id = ?1", gate.id)?.open_state === "opened", 10_000, "the page opened");
    // The daemon's own poll of the page is what the opener waited on.
    const calls = join(f.h.home, "lavish-calls.log");
    await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes("poll "), 10_000, "the lavish-axi poll");
    expect(readFileSync(opens, "utf8")).toBe(`Google Chrome\t${gate.review_url}\n`);
    // The worker's own lavish-axi never opens anything.
    const pane = [...f.herdr.panes.values()].find((p) => p.env.FLOWRYN_RUN === run)!;
    expect(pane.env.LAVISH_AXI_NO_OPEN).toBe("1");
    const item = one<{ line: string; full_line: string | null }>(f, "SELECT line, full_line FROM items WHERE kind = 'gate_ready' AND run_id = ?1", run)!;
    expect(item.full_line ?? item.line).toEndWith(`${gate.review_url} · opened in Google Chrome`);
    expect(await gateLine(e, task, gate.id)).toContain("; browser: opened ");
    expect(await gateLine(e, task, gate.id)).not.toContain("open by hand");

    // At most once: a restarted daemon finds the gate past pending and opens nothing more.
    await f.restartDaemon();
    await Bun.sleep(500);
    expect(readFileSync(opens, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a failed open shows on the gate item and in show with the URL to open by hand", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const e = ship;
    const f = e.fleet;
    writeFileSync(join(f.h.home, "browser-opens.log.fail"), "open exited 1: Unable to find application named 'Google Chrome'\n");
    const { task, run, gate } = await handIn(e);

    await waitUntil(() => one<{ open_state: string }>(f, "SELECT open_state FROM gates WHERE id = ?1", gate.id)?.open_state === "failed", 10_000, "the open failed");
    const item = one<{ line: string; full_line: string | null }>(f, "SELECT line, full_line FROM items WHERE kind = 'gate_ready' AND run_id = ?1", run)!;
    expect(item.full_line ?? item.line).toEndWith(`${gate.review_url} · NOT opened (open exited 1: Unable to find application named 'Google Chrome'); open it by hand`);
    const line = await gateLine(e, task, gate.id);
    expect(line).toContain("; browser: failed ");
    expect(line).toContain("(open exited 1: Unable to find application named 'Google Chrome')");
    expect(line).toEndWith(`; open by hand: ${gate.review_url}`);
  });

  test("a page whose polls fail opens one review_channel item and show says DOWN; a delivered poll resolves it; the browser state and the gate are untouched", async () => {
    ship = await makeShipEnv({ mode: "local-only", extraConfig: "[review]\nchannel_alert_ms = 0\n" });
    const e = ship;
    const f = e.fleet;
    // The test home's lavish-axi fails a poll per queued *.fail.out, printing it, the way Lavish's 500 did on 2026-10-11.
    const queue = join(f.h.home, "lavish-queue");
    mkdirSync(queue, { recursive: true });
    for (const n of ["001", "002"]) writeFileSync(join(queue, `${n}.fail.out`), "error: Lavish Editor request failed: 500\ncode: SERVER_ERROR\n");
    const { task, run, gate } = await handIn(e);

    await waitUntil(() => one(f, "SELECT 1 FROM items WHERE kind = 'review_channel' AND run_id = ?1 AND state = 'open'", run) !== null, 15_000, "the review_channel item");
    const item = one<{ id: string; lane: string; line: string; full_line: string | null }>(f, "SELECT id, lane, line, full_line FROM items WHERE kind = 'review_channel' AND run_id = ?1", run)!;
    expect(item.lane).toBe("P1");
    expect(item.full_line ?? item.line).toStartWith("Review page not delivering answers: restart Lavish");
    expect(item.full_line ?? item.line).toContain(`${task} (design gate ${gate.id}) since `);
    expect(item.full_line ?? item.line).toContain("2 failed polls: error: Lavish Editor request failed: 500 (exit 1)");
    const down = await gateLine(e, task, gate.id);
    expect(down).toContain("; channel: DOWN since ");
    expect(down).toContain(`2 failed polls (error: Lavish Editor request failed: 500 (exit 1)); next try `);
    expect(down).toEndWith(`; item ${item.id}`);

    // Lavish is healthy again: the next poll delivers, the item resolves and show says listening.
    writeFileSync(join(queue, "003.out"), "session:\n  status: waiting\n");
    await waitUntil(() => one<{ state: string }>(f, "SELECT state FROM items WHERE id = ?1", item.id)?.state === "resolved", 15_000, "the item resolved");
    expect(one<{ resolved_by: string }>(f, "SELECT resolved_by FROM items WHERE id = ?1", item.id)).toEqual({ resolved_by: `gate.channel_ok ${gate.id}` });
    const healthy = await gateLine(e, task, gate.id);
    expect(healthy).toContain("; channel: listening since ");
    expect(healthy).not.toContain("DOWN");
    // Distinct from opening the browser, and recovery never passes the gate.
    expect(one<Record<string, unknown>>(f, "SELECT state, approval_id, open_state FROM gates WHERE id = ?1", gate.id)).toEqual({ state: "open", approval_id: null, open_state: "opened" });
    expect(healthy).toContain("; browser: opened ");
    expect(one<{ n: number }>(f, "SELECT COUNT(*) AS n FROM items WHERE kind = 'review_channel'")).toEqual({ n: 1 });
  }, 60_000);

  test("[review] open_browser = false: the gate opens off, and nothing is handed to a browser", async () => {
    ship = await makeShipEnv({ mode: "local-only", extraConfig: "[review]\nopen_browser = false\n" });
    const e = ship;
    const f = e.fleet;
    const { task, gate } = await handIn(e);
    await waitUntil(() => existsSync(join(f.h.home, "lavish-calls.log")), 10_000, "the lavish-axi poll");
    await Bun.sleep(300);
    expect(one<{ open_state: string; open_detail: string }>(f, "SELECT open_state, open_detail FROM gates WHERE id = ?1", gate.id)).toEqual({ open_state: "off", open_detail: "[review] open_browser = false" });
    expect(existsSync(join(f.h.home, "browser-opens.log"))).toBe(false);
    expect(await gateLine(e, task, gate.id)).toContain(`; browser: off ([review] open_browser = false); open by hand: ${gate.review_url}`);
  });
});
