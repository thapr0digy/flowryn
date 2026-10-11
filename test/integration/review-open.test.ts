import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

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

const PAGE = "<html data-lavish-live-reload-root><body><h1>Design</h1></body></html>";

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
