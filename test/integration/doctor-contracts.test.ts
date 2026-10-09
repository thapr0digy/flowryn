import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateFiles } from "../../src/config/paths.ts";
import { cli } from "../helpers/harness.ts";
import { makeLeaderEnv, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * `flowryn doctor --contracts` from an agent pane, through the real CLI and
 * daemon. Nothing here reaches a real Herdr or harness: the test home's
 * [herdr] socket is missing and its claude answers no version, so a suite
 * that does start fails at its first step, and none records anything.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

function contractRows(e: LeaderEnv): number {
  return e.withDb((db) => (db.query("SELECT COUNT(*) AS n FROM harness_contracts").get() as { n: number }).n);
}

function reports(e: LeaderEnv): string[] {
  const dir = join(e.h.home, "data", "contracts");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** A leader session that holds the lease, as its SessionStart hook makes it. */
async function leaderSession(e: LeaderEnv): Promise<{ token: string }> {
  const opened = await e.openSession("claude");
  const started = await e.call("hook.session-start", { harness: "claude", input: JSON.stringify({ source: "startup" }) }, opened.token);
  if (!started.ok) throw new Error(`session-start: ${JSON.stringify(started.error)}`);
  return opened;
}

async function doctor(e: LeaderEnv, args: string[], identity: Record<string, string>) {
  const result = await cli(e.h, ["doctor", ...args, "--json"], { env: identity });
  return { ...result, reply: JSON.parse(result.stdout) as { ok: boolean; error?: { code: string; message: string; help?: string }; data?: { checks: { check: string; status: string; detail: string }[] } } };
}

/** The suite started: its plan line went to stderr before the first harness. */
function suiteStarted(stderr: string): boolean {
  return stderr.includes("contracts: claude");
}

describe("doctor --contracts from an agent pane", () => {
  test("--verify-only runs for the leader and for a worker, and never writes harness_contracts", async () => {
    env = await makeLeaderEnv();
    const e = env;
    const leader = await leaderSession(e);
    const identities: Record<string, string>[] = [{ FLOWRYN_TOKEN: leader.token }, { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }];
    for (const identity of identities) {
      const result = await doctor(e, ["--contracts", "--verify-only", "--harness", "claude"], identity);
      expect(suiteStarted(result.stderr)).toBe(true);
      expect(result.stderr).toContain("verify-only: nothing is recorded");
      expect(result.reply.error).toBeUndefined();
      expect(result.reply.data!.checks.find((c) => c.check === "contract claude")!.status).toBe("fail");
    }
    expect(contractRows(e)).toBe(0);
    expect(reports(e)).toEqual([]);
  });

  test("a worker asking to record is refused before the suite starts", async () => {
    env = await makeLeaderEnv();
    const result = await doctor(env, ["--contracts", "--harness", "claude"], { FLOWRYN_TOKEN: env.worker.token, FLOWRYN_RUN: env.worker.runId });
    expect(result.code).toBe(77);
    expect(result.reply.error!.code).toBe("worker_token");
    expect(result.reply.error!.help).toContain("--verify-only");
    expect(suiteStarted(result.stderr)).toBe(false);
  });

  test("strict (the default): the leader asking to record is refused before the suite starts", async () => {
    env = await makeLeaderEnv();
    const leader = await leaderSession(env);
    const result = await doctor(env, ["--contracts", "--harness", "claude"], { FLOWRYN_TOKEN: leader.token });
    expect(result.code).toBe(77);
    expect(result.reply.error).toMatchObject({ code: "human_only", message: expect.stringContaining("strict policy") });
    expect(result.reply.error!.help).toContain("--verify-only");
    expect(suiteStarted(result.stderr)).toBe(false);
    expect(contractRows(env)).toBe(0);
  });

  test("relaxed: a leader on a binary that is not the daemon's build is refused before the suite starts", async () => {
    // The test daemon is a development command (bun src/main.ts): it has no build id, so no leader binary matches it.
    env = await makeLeaderEnv({ extraConfig: '[policy]\nmode = "relaxed"\n' });
    const leader = await leaderSession(env);
    const result = await doctor(env, ["--contracts", "--harness", "claude"], { FLOWRYN_TOKEN: leader.token });
    expect(result.code).toBe(2);
    expect(result.reply.error!.code).toBe("not_installed_build");
    expect(suiteStarted(result.stderr)).toBe(false);
    expect(contractRows(env)).toBe(0);
  });

  test("plain doctor and --restore stay your own terminal's; --verify-only needs --contracts", async () => {
    env = await makeLeaderEnv();
    const leader = await leaderSession(env);
    for (const args of [[], ["--restore"]]) {
      const result = await doctor(env, args, { FLOWRYN_TOKEN: leader.token });
      expect(result.code).toBe(77);
      expect(result.reply.error!.code).toBe("human_only");
    }
    const result = await doctor(env, ["--verify-only"], { FLOWRYN_TOKEN: leader.token });
    expect(result.code).toBe(3);
    expect(result.reply.error!.code).toBe("bad_args");
  });
  test("--restore refuses an agent pane whatever flags come with it, and never goes with --contracts", async () => {
    env = await makeLeaderEnv();
    const e = env;
    const leader = await leaderSession(e);
    const db = stateFiles(e.h.stateDir).db;
    const before = statSync(db).ino;
    const identities: Record<string, string>[] = [{ FLOWRYN_TOKEN: leader.token }, { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }];
    for (const identity of identities) {
      for (const args of [["--contracts", "--verify-only", "--restore"], ["--contracts", "--restore"]]) {
        const result = await doctor(e, args, identity);
        expect(result.code).toBe(77);
        expect(result.reply.error!.code).toBe("human_only");
        expect(suiteStarted(result.stderr)).toBe(false);
      }
    }
    expect(statSync(db).ino).toBe(before);
    expect(readdirSync(e.h.stateDir).filter((f) => f.includes(".replaced-"))).toEqual([]);
    const human = await doctor(e, ["--contracts", "--verify-only", "--restore"], {});
    expect(human.code).toBe(3);
    expect(human.reply.error!.code).toBe("bad_args");
  });

  test("--for-daemon is the daemon's own run: refused from an agent pane, needs --harness, and records nothing", async () => {
    env = await makeLeaderEnv();
    const e = env;
    const leader = await leaderSession(e);
    const identities: Record<string, string>[] = [{ FLOWRYN_TOKEN: leader.token }, { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }];
    for (const identity of identities) {
      const result = await doctor(e, ["--contracts", "--for-daemon", "--harness", "claude"], identity);
      expect(result.code).toBe(77);
      expect(result.reply.error!.code).toBe("human_only");
      expect(suiteStarted(result.stderr)).toBe(false);
    }
    for (const args of [["--for-daemon"], ["--contracts", "--for-daemon", "--verify-only", "--harness", "claude"]]) {
      const result = await doctor(e, args, {});
      expect(result.code).toBe(3);
      expect(result.reply.error!.code).toBe("bad_args");
    }
    const noHarness = await doctor(e, ["--contracts", "--for-daemon"], {});
    expect(noHarness.reply.data!.checks).toEqual([{ check: "contracts", status: "fail", detail: "--for-daemon runs one harness: pass --harness" }]);
    // With no Herdr to run in, it fails without a report, and hands the daemon none.
    const run = await doctor(e, ["--contracts", "--for-daemon", "--harness", "claude"], {});
    expect(run.reply.data).toMatchObject({ report: "-", version: "-" });
    expect(contractRows(e)).toBe(0);
  });
});
