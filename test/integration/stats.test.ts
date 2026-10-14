import { afterEach, describe, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import { cli, cliJson, makeHome, seedLeader, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/** `flowryn stats` through the real CLI (docs/notes/2026-10-13-measure-waiting-time-na.md). */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

describe("flowryn stats", () => {
  test("the daemon serves it to the leader; with the daemon down the read-only fallback does", async () => {
    const h = makeHome();
    homes.push(h);
    const env = { FLOWRYN_TOKEN: seedLeader(h) };
    const d = await startDaemon(h);
    daemons.push(d);

    const served = await cliJson(h, ["stats", "--since", "24h"], { env });
    expect(served.code).toBe(0);
    const data = served.reply.data as { window: { project: string }; store: { tables: { table: string; rows: number }[]; latency: { read: string }[] } };
    expect(data.window.project).toBe("all");
    expect(data.store.tables.find((t) => t.table === "events")!.rows).toBeGreaterThan(0);
    expect(data.store.latency.map((l) => l.read)).toEqual(["fleet", "brief"]);

    const bad = await cliJson(h, ["stats", "--since", "7w"], { env });
    expect(bad.code).toBe(3);
    expect(bad.reply.error).toMatchObject({ code: "bad_args" });

    await d.stop();
    const fallback = await cli(h, ["stats"], { env });
    expect(fallback.code).toBe(0);
    expect(fallback.stdout).toStartWith("banner: daemon down");
    const parsed = decode(fallback.stdout) as { unneeded: { rule: string }[] };
    expect(parsed.unneeded.map((u) => u.rule)).toEqual(["U1 dismissed alone", "U2 steer to a busy run", "U3 answered as recommended"]);
  });
});
