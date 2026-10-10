import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotaJson, REPO_ROOT, waitUntil } from "../helpers/harness.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { Pty } from "../helpers/pty.ts";

/**
 * The Claude quota floor (the toolkit report's Q4), end to end on the fake
 * fleet: the scheduler reads the test home's stand-in quota-axi (it prints
 * $FLOWRYN_HOME/quota.json) before a new Claude run starts. Under the floor
 * new Claude runs wait with a P1; runs in flight drain; a failed reading
 * holds nothing; you start Claude work anyway with capacity resume.
 */

const MAIN = join(REPO_ROOT, "src/main.ts");
const FAST = "[sched]\npass_ms = 250\nquota_cache_ms = 300";

let fleet: FleetEnv | null = null;
const ptys: Pty[] = [];

afterEach(async () => {
  for (const pty of ptys.splice(0)) pty.kill();
  await fleet?.cleanup();
  fleet = null;
});

function rows<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T[] {
  const db = e.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function one<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T | null {
  return rows<T>(e, sql, ...params)[0] ?? null;
}

function setQuota(e: FleetEnv, percent: number): void {
  writeFileSync(join(e.h.home, "quota.json"), quotaJson(percent));
}

const quotaEvents = (e: FleetEnv): string[] => rows<{ kind: string }>(e, "SELECT kind FROM events WHERE kind LIKE 'sched.quota_%' ORDER BY seq").map((r) => r.kind);
const lowItem = (e: FleetEnv) => one<{ state: string; line: string; resolved_by: string | null }>(e, "SELECT state, line, resolved_by FROM items WHERE kind = 'quota_low' ORDER BY rowid DESC");

describe("the Claude quota floor", () => {
  test(
    "under the floor a new Claude run waits with a P1 and Pi starts; a reading back over the floor starts it",
    async () => {
      fleet = await makeFleetEnv({ extraConfig: FAST });
      const f = fleet;
      setQuota(f, 3);
      const b = await f.dispatch("Waits on the quota\nFAKE: sleep 120000", { kind: "scout", harness: "claude" });
      await waitUntil(() => lowItem(f)?.state === "open", 15_000, "the quota P1");
      expect(lowItem(f)!.line).toBe("Claude quota 3% (seven_day), under the 5% floor; new Claude runs wait until it resets at 04:00; flowryn capacity resume --harness claude starts them anyway");
      const capacity = await f.json(["capacity"]);
      const view = JSON.stringify(capacity.reply.data);
      expect(view).toContain("Claude quota 3% under floor 5%");
      expect(view).toContain("claude 3% (floor 5%) low; new Claude runs wait");
      expect(capacity.reply.hints).toContain("flowryn capacity resume --harness claude");
      const pi = await f.dispatch("Pi goes on\nFAKE: sleep 120000", { kind: "scout", harness: "pi" });
      await f.waitRun(pi.run, (r) => r.proc_pid !== null, "the Pi worker");
      expect(f.run(b.run).proc_pid).toBeNull();
      // The probe is quota-axi's fixed, read-only argv.
      expect(readFileSync(join(f.h.home, "quota-calls.log"), "utf8")).toContain("--provider claude --json --no-credential-refresh");

      setQuota(f, 50);
      await f.waitRun(b.run, (r) => r.proc_pid !== null, "the Claude worker once the quota is back", 20_000);
      expect(lowItem(f)).toMatchObject({ state: "resolved", resolved_by: "quota ok" });
      expect(quotaEvents(f)).toEqual(["sched.quota_low", "sched.quota_ok"]);
    },
    { timeout: 90_000 },
  );

  test(
    "a live Claude run drains under the floor: its next stage starts while a new run waits, until you start Claude work anyway in your own terminal",
    async () => {
      fleet = await makeFleetEnv({ extraConfig: FAST });
      const f = fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "fix"])).code).toBe(0);
      const a = await f.dispatch("In flight\nFAKE: wait-file go\nFAKE: stage-done\nFAKE: sleep 120000", { kind: "ship", harness: "claude" });
      await f.waitRun(a.run, (r) => r.proc_pid !== null && r.stage === "build", "the first Claude worker");
      setQuota(f, 2);
      // The 80% reading that let the first run start is reused for quota_cache_ms: let it expire.
      await Bun.sleep(700);
      const b = await f.dispatch("New work\nFAKE: sleep 120000", { kind: "scout", harness: "claude" });
      await waitUntil(() => lowItem(f)?.state === "open", 15_000, "the quota P1");

      writeFileSync(join(f.h.dataDir, a.task, "go"), "");
      await f.waitRun(a.run, (r) => r.stage === "ship" && r.stage_state === "active", "the live run's next stage");
      expect(f.run(b.run).proc_pid).toBeNull();

      // A leader cannot start it anyway; you can, in your own terminal.
      const refused = await f.json(["capacity", "resume", "--harness", "claude"]);
      expect((refused.reply.error as { code: string }).code).toBe("human_only");
      const pty = Pty.spawn(["bun", MAIN, "capacity", "resume", "--harness", "claude"], f.h.env, REPO_ROOT);
      ptys.push(pty);
      expect(await pty.exited).toBe(0);
      expect(pty.text()).toContain("started anyway");
      await f.waitRun(b.run, (r) => r.proc_pid !== null, "the held Claude worker", 20_000);
      expect(lowItem(f)).toMatchObject({ state: "resolved", resolved_by: "started anyway (flowryn capacity resume)" });
      expect(quotaEvents(f)).toEqual(["sched.quota_ok", "sched.quota_low", "sched.quota_override"]);
      expect(JSON.stringify((await f.json(["capacity"])).reply.data)).toContain("you started Claude work anyway");
    },
    { timeout: 90_000 },
  );

  test(
    "a failed reading holds nothing and is logged once; a floor of 0 never reads quota-axi",
    async () => {
      fleet = await makeFleetEnv({ extraConfig: FAST });
      const f = fleet;
      writeFileSync(join(f.h.home, "quota.fail"), "");
      const a = await f.dispatch("Starts anyway\nFAKE: sleep 120000", { kind: "scout", harness: "claude" });
      await f.waitRun(a.run, (r) => r.proc_pid !== null, "the Claude worker");
      const b = await f.dispatch("Starts too\nFAKE: sleep 120000", { kind: "scout", harness: "claude" });
      await f.waitRun(b.run, (r) => r.proc_pid !== null, "the second Claude worker");
      expect(quotaEvents(f)).toEqual(["sched.quota_unknown"]);
      const unknown = JSON.parse(one<{ payload: string }>(f, "SELECT payload FROM events WHERE kind = 'sched.quota_unknown'")!.payload) as { detail: string };
      expect(unknown.detail).toBe("quota-axi exited 1: quota-axi: claude: network unreachable");
      expect(lowItem(f)).toBeNull();
      rmSync(join(f.h.home, "quota.fail"));
    },
    { timeout: 90_000 },
  );

  test(
    "with [capacity.quota] floor = 0 quota-axi is never read",
    async () => {
      fleet = await makeFleetEnv({ extraConfig: `${FAST}\n[capacity.quota]\nfloor = 0` });
      const f = fleet;
      setQuota(f, 0);
      const a = await f.dispatch("No floor\nFAKE: sleep 120000", { kind: "scout", harness: "claude" });
      await f.waitRun(a.run, (r) => r.proc_pid !== null, "the Claude worker");
      expect(rows(f, "SELECT 1 FROM events WHERE kind LIKE 'sched.quota_%'")).toEqual([]);
      expect(() => readFileSync(join(f.h.home, "quota-calls.log"), "utf8")).toThrow();
      expect(JSON.stringify((await f.json(["capacity"])).reply.data)).toContain("off ([capacity.quota] floor = 0)");
    },
    { timeout: 90_000 },
  );
});
