import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { contractsConfig, DEFAULT_CONTRACTS } from "../../src/config/contracts.ts";
import { HarnessVersionPoller } from "../../src/contracts/version-poll.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { migrate, openDb, setMeta, type Db } from "../../src/db/db.ts";
import { AUTO_BUILD_KEY, unverifiedVersion } from "../../src/lifecycle/harness-gate.ts";

/** The harness version poll (src/contracts/version-poll.ts): a self-updated harness is flagged with no dispatch. */

let dir: string;
let db: Db;
let config: FlowrynConfig;
let installed: string | null;
let busy: boolean;
let kicks: number;
let logs: string[];

function poller(): HarnessVersionPoller {
  return new HarnessVersionPoller({
    db,
    config: () => config,
    harnessVersion: async () => installed,
    now: Date.now,
    log: (m) => logs.push(m),
    restartBusy: () => busy,
    flagged: () => kicks++,
  });
}

/** [contracts] as a config with only this body would resolve. */
function at(body: string) {
  return contractsConfig(parseConfig(`[contracts]\n${body}\n`, dir));
}

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-vpoll-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[tools]\nclaude = "/x/claude"\n[policy]\nmode = "relaxed"\n`, dir);
  setMeta(db, AUTO_BUILD_KEY, "ab12cd34ef56");
  // A project on Claude puts the harness in use.
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, harness) VALUES ('web', 'https://example.invalid/web', '/x/web', 'main', 'direct-PR', 'claude')").run();
  db.query("INSERT INTO harness_contracts (harness, version, revision, passed_at) VALUES ('claude', '2.1.318', ?1, 0)").run(contractRevision("claude"));
  installed = "2.1.318";
  busy = false;
  kicks = 0;
  logs = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the harness version poll", () => {
  test("flags a new version with no dispatch, once, and kicks the automatic check", async () => {
    const poll = poller();
    expect(await poll.poll()).toEqual([expect.objectContaining({ harness: "claude", state: "verified", version: "2.1.318" })]);
    expect(kicks).toBe(0);
    installed = "2.1.319";
    expect(await poll.poll()).toEqual([expect.objectContaining({ state: "unverified", version: "2.1.319", flaggedNow: true })]);
    expect(unverifiedVersion(db, "claude")).toBe("2.1.319");
    expect(events("harness.unverified")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.319", where: "poll", auto: true })]);
    expect(kicks).toBe(1);
    // The same version again: no second flag, no kick.
    await poll.poll();
    expect(events("harness.unverified")).toHaveLength(1);
    expect(kicks).toBe(1);
  });

  test("waits while a restart is pending; a harness whose version cannot be read flags nothing", async () => {
    busy = true;
    installed = "2.1.319";
    expect(await poller().poll()).toEqual([]);
    expect(unverifiedVersion(db, "claude")).toBeNull();
    busy = false;
    installed = null;
    expect(await poller().poll()).toEqual([expect.objectContaining({ state: "missing" })]);
    expect(unverifiedVersion(db, "claude")).toBeNull();
    expect(kicks).toBe(0);
  });

  test("a version read that throws is logged and the poll goes on", async () => {
    const poll = new HarnessVersionPoller({ db, config: () => config, harnessVersion: async () => { throw new Error("boom"); }, now: Date.now, log: (m) => logs.push(m), restartBusy: () => false, flagged: () => kicks++ });
    expect(await poll.poll()).toEqual([]);
    expect(logs).toEqual(["contracts: version poll of claude failed: boom"]);
  });

  test("[contracts] version_poll_ms: 10 minutes by default, 0 turns it off, too short or not a number is refused", () => {
    expect(contractsConfig(config)).toEqual(DEFAULT_CONTRACTS);
    expect(DEFAULT_CONTRACTS.version_poll_ms).toBe(600_000);
    expect(at("version_poll_ms = 0")).toEqual({ version_poll_ms: 0 });
    expect(at("version_poll_ms = 60000")).toEqual({ version_poll_ms: 60_000 });
    expect(() => at("version_poll_ms = 5")).toThrow("[contracts] version_poll_ms must be 0 (off) or a whole number of at least 10000");
    expect(() => at('version_poll_ms = "x"')).toThrow("must be 0 (off)");
    expect(() => at("poll = 1")).toThrow("[contracts] poll is not a known setting");
  });
});
