import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { tx } from "../../src/db/db.ts";
import { quotaCheck } from "../../src/doctor/doctor.ts";
import { judgeQuota, overrideQuota, parseQuota, probeQuota, QUOTA_ARGS, quotaHolds, quotaLine, quotaState, recordQuota, type QuotaReading } from "../../src/sched/quota.ts";
import { makeHome, quotaJson, type TestHome } from "../helpers/harness.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "../fixtures/quota-axi-0.1.37-claude.json"), "utf8");

let homes: TestHome[] = [];
let dirs: string[] = [];
afterEach(() => {
  for (const h of homes) h.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  homes = [];
  dirs = [];
});

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-quota-"));
  dirs.push(dir);
  const path = join(dir, "quota-axi");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const known = (percent: number): QuotaReading => ({ state: "known", percent, window: "seven_day", resets_at: "2026-10-11T04:00:00+00:00" });

describe("parseQuota (assumption: quota-axi 0.1.37 --json, schema 5, reports Claude's all_models effectivePercentRemaining)", () => {
  test("reads the output quota-axi printed on a real Mac", () => {
    expect(parseQuota(FIXTURE)).toEqual({ state: "known", percent: 80, window: "seven_day", resets_at: "2026-10-10T03:59:59.773274+00:00" });
  });

  test("anything it cannot read is unknown, with why", () => {
    const fixture = JSON.parse(FIXTURE) as { schemaVersion: number; providers: { provider: string; quotaSemantics: { effectiveAvailability: { scope: string; status: string; effectivePercentRemaining: unknown }[] } }[] };
    const variant = (edit: (j: typeof fixture) => void): string => {
      const copy = structuredClone(fixture);
      edit(copy);
      return JSON.stringify(copy);
    };
    const cases: [string, string][] = [
      ["{not json", "quota-axi did not print JSON"],
      [variant((j) => (j.schemaVersion = 6)), "quota-axi schema 6, not 5"],
      [variant((j) => (j.providers[0]!.provider = "codex")), "quota-axi reported no claude provider"],
      [variant((j) => (j.providers[0]!.quotaSemantics.effectiveAvailability = j.providers[0]!.quotaSemantics.effectiveAvailability.filter((a) => a.scope !== "all_models"))), "quota-axi reported no all_models availability for claude"],
      [variant((j) => (j.providers[0]!.quotaSemantics.effectiveAvailability[0]!.status = "unknown")), "claude availability is unknown"],
      [variant((j) => (j.providers[0]!.quotaSemantics.effectiveAvailability[0]!.effectivePercentRemaining = "80")), "claude effectivePercentRemaining is not a number"],
    ];
    for (const [text, detail] of cases) expect(parseQuota(text)).toEqual({ state: "unknown", detail });
  });

  test("the test homes' stand-in prints the same shape", () => {
    expect(parseQuota(quotaJson(3))).toMatchObject({ state: "known", percent: 3, window: "seven_day" });
  });
});

describe("the floor", () => {
  test("low is strictly under the floor; unknown is never low; a floor of 0 is never low", () => {
    expect(judgeQuota(known(4.9), 5)).toBe("low");
    expect(judgeQuota(known(5), 5)).toBe("ok");
    expect(judgeQuota(known(0), 0)).toBe("ok");
    expect(judgeQuota({ state: "unknown", detail: "x" }, 5)).toBe("unknown");
  });

  test("a flip is recorded with an event; low opens one P1 and holds; ok resolves it; an unchanged reading writes nothing", () => {
    const h = makeHome();
    homes.push(h);
    const db = h.db();
    const events = () => (db.query("SELECT kind FROM events WHERE kind LIKE 'sched.quota_%' ORDER BY seq").all() as { kind: string }[]).map((e) => e.kind);
    const item = () => db.query("SELECT state, line FROM items WHERE kind = 'quota_low' ORDER BY rowid DESC").get() as { state: string; line: string } | null;
    tx(db, () => recordQuota(db, known(80), 5, 1));
    tx(db, () => recordQuota(db, known(60), 5, 2));
    expect(events()).toEqual(["sched.quota_ok"]);
    expect(quotaState(db)).toMatchObject({ state: "ok", percent: 80, since: 1 });
    expect(quotaHolds(db)).toBe(false);
    tx(db, () => recordQuota(db, known(3), 5, 3));
    tx(db, () => recordQuota(db, known(2), 5, 4));
    expect(events()).toEqual(["sched.quota_ok", "sched.quota_low"]);
    expect(quotaHolds(db)).toBe(true);
    expect(item()!.state).toBe("open");
    expect(item()!.line).toContain("Claude quota 3% (seven_day), under the 5% floor; new Claude runs wait until it resets at");
    expect(quotaLine(quotaState(db)!)).toBe("claude 3% (floor 5%) low; new Claude runs wait");
    tx(db, () => recordQuota(db, { state: "unknown", detail: "quota-axi exited 1" }, 5, 5));
    expect(quotaHolds(db)).toBe(false);
    expect(item()!.state).toBe("resolved");
    expect(quotaLine(quotaState(db)!)).toBe("unknown (quota-axi exited 1); nothing waits on it");
    // A new floor is recorded even when the verdict stays the same.
    tx(db, () => recordQuota(db, { state: "unknown", detail: "quota-axi exited 1" }, 10, 6));
    expect(events()).toEqual(["sched.quota_ok", "sched.quota_low", "sched.quota_unknown", "sched.quota_unknown"]);
    db.close();
  });

  test("capacity resume overrides a low reading until the next reading that is not low", () => {
    const h = makeHome();
    homes.push(h);
    const db = h.db();
    expect(tx(db, () => overrideQuota(db, 1))).toBe(false);
    tx(db, () => recordQuota(db, known(1), 5, 2));
    expect(tx(db, () => overrideQuota(db, 3))).toBe(true);
    expect(tx(db, () => overrideQuota(db, 4))).toBe(false);
    expect(quotaHolds(db)).toBe(false);
    expect((db.query("SELECT state FROM items WHERE kind = 'quota_low'").get() as { state: string }).state).toBe("resolved");
    // Still low: the override stands. Back over the floor and low again: it holds again.
    tx(db, () => recordQuota(db, known(0), 5, 5));
    expect(quotaHolds(db)).toBe(false);
    tx(db, () => recordQuota(db, known(90), 5, 6));
    tx(db, () => recordQuota(db, known(1), 5, 7));
    expect(quotaHolds(db)).toBe(true);
    db.close();
  });
});

describe("probeQuota", () => {
  test("runs quota-axi with its fixed read-only argv and parses what it prints", async () => {
    const log = join(tmpdir(), `fw-quota-args-${process.pid}`);
    const tool = script(`echo "$*" > ${JSON.stringify(log)}; cat <<'JSON'\n${quotaJson(42)}\nJSON`);
    expect(await probeQuota(tool, null)).toMatchObject({ state: "known", percent: 42 });
    expect(readFileSync(log, "utf8").trim()).toBe(QUOTA_ARGS.join(" "));
    rmSync(log, { force: true });
  });

  test("a missing tool, a failing one or one that never runs is unknown", async () => {
    expect(await probeQuota(null, null)).toEqual({ state: "unknown", detail: "quota-axi is not installed" });
    expect(await probeQuota(script("echo 'no network' >&2; exit 1"), null)).toEqual({ state: "unknown", detail: "quota-axi exited 1: no network" });
    expect((await probeQuota(join(tmpdir(), "fw-no-such-quota-axi"), null)).state).toBe("unknown");
  });
});

function config(extra: Record<string, unknown> = {}, tool: string | null = script("exit 0")): FlowrynConfig {
  const base = defaultConfig(mkdtempSync(join(tmpdir(), "fw-qcfg-")));
  dirs.push(base.home);
  return { ...base, tools: tool ? { quota_axi: tool } : {}, extra };
}

const at = (r: QuotaReading) => async () => r;

describe("doctor's quota probe line", () => {
  test("ok over the floor, warn under it or when the probe fails, nothing when the floor is off or quota-axi is missing", async () => {
    expect(await quotaCheck(config(), at(known(80)))).toEqual({ check: "quota probe", status: "ok", detail: "claude 80% (seven_day) effective, floor 5%" });
    expect(await quotaCheck(config(), at(known(3)))).toMatchObject({ status: "warn", detail: expect.stringContaining("under the 5% floor: new Claude runs wait") });
    expect(await quotaCheck(config(), at({ state: "unknown", detail: "quota-axi exited 1" }))).toMatchObject({ status: "warn", detail: "quota-axi exited 1; new Claude runs never wait on the quota while it fails" });
    expect(await quotaCheck(config({ capacity: { quota: { floor: 0 } } }), at(known(0)))).toBeNull();
    expect(await quotaCheck(config({}, join(tmpdir(), "fw-no-such-quota-axi")), at(known(80)))).toBeNull();
  });
});
