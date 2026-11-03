import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeClaudeLeader } from "../helpers/fake-claude-leader.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * A new leader session takes over a stale lease without `leader claim`
 * (docs/notes/2026-11-03-fix-a-new-58.md), through the real daemon, CLI and
 * Claude leader hooks. A leader's harness process stands in as a `sleep`
 * attached with lead.attach; killing it is a restart that never ran the exit hook.
 */

let env: LeaderEnv;
const sleepers: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const proc of sleepers.splice(0)) proc.kill("SIGKILL");
  await env?.cleanup();
});

interface Leader {
  fake: FakeClaudeLeader;
  session: string;
  token: string;
}

async function lead(pane: string): Promise<Leader> {
  const opened = await env.openSession("claude", pane);
  const fake = new FakeClaudeLeader({ settingsPath: env.files.claudeSettings, env: opened.env, dir: env.h.home, cwd: join(env.h.home, "leader-cwd") });
  return { fake, session: opened.session, token: opened.token };
}

/** Attach a stand-in harness process to the session; returns a kill that waits for it to be gone. */
async function attachProcess(leader: Leader): Promise<() => Promise<void>> {
  const proc = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  sleepers.push(proc);
  const reply = await env.call("lead.attach", { pid: proc.pid }, leader.token);
  if (!reply.ok) throw new Error(`lead.attach: ${JSON.stringify(reply.error)}`);
  return async () => {
    proc.kill("SIGKILL");
    await proc.exited;
  };
}

function holder(): string | null {
  return env.withDb((db) => (db.query("SELECT session_id FROM leader_lease WHERE scope = 'default'").get() as { session_id: string | null } | null)?.session_id ?? null);
}

function ended(session: string): boolean {
  return env.withDb((db) => (db.query("SELECT ended_at FROM leader_sessions WHERE session_id = ?1").get(session) as { ended_at: number | null }).ended_at !== null);
}

describe("a stale leader lease", () => {
  test("a new session in the holder's pane claims at start once the holder's process is gone, and closes the pane's dead sessions", async () => {
    env = await makeLeaderEnv();
    // An older session in the pane that lost the lease long ago and died without its exit hook (L4/L5).
    const older = await lead("wG:p1");
    await older.fake.start();
    const killOlder = await attachProcess(older);
    const old = await lead("wG:p1");
    await env.call("leader claim", { session: old.session }, null);
    await old.fake.start();
    const killOld = await attachProcess(old);
    expect(holder()).toBe(old.session);
    old.fake.kill();
    older.fake.kill();
    await killOld();
    await killOlder();

    // Well inside stale_ms (10 min) of the holder's last heartbeat.
    const next = await lead("wG:p1");
    await next.fake.start();
    expect(holder()).toBe(next.session);
    expect(next.fake.seen.some((s) => s.via === "SessionStart" && !s.text.includes("read-only"))).toBe(true);
    expect(ended(old.session)).toBe(true);
    expect(ended(older.session)).toBe(true);
    next.fake.kill();
  });

  test("a session in another pane stays read-only while the holder's heartbeat is recent, even with its process gone", async () => {
    env = await makeLeaderEnv();
    const old = await lead("wG:p2");
    await old.fake.start();
    const killOld = await attachProcess(old);
    old.fake.kill();
    await killOld();
    const other = await lead("wH:p3");
    await other.fake.start();
    await other.fake.prompt("hello");
    expect(holder()).toBe(old.session);
    expect(ended(old.session)).toBe(false);
    other.fake.kill();
  });

  test("a read-only session claims on a later prompt once the holder is stale; a live holder is never taken over", async () => {
    env = await makeLeaderEnv();
    const old = await lead("wG:p4");
    await old.fake.start();
    const killOld = await attachProcess(old);
    const reader = await lead("wH:p5");
    await reader.fake.start();
    expect(holder()).toBe(old.session);

    // Silent past stale_ms but still running (a sleeping laptop): the prompt leaves the lease alone.
    const silence = () => env.withDb((db) => db.query("UPDATE leader_lease SET heartbeat_at = ?1 WHERE scope = 'default'").run(Date.now() - 3_600_000));
    old.fake.kill();
    silence();
    await reader.fake.prompt("first");
    expect(holder()).toBe(old.session);

    // Its process ends: the reader's next prompt takes over and gets the briefing.
    await killOld();
    silence();
    await reader.fake.prompt("second");
    await waitFor("the reader to hold the lease", 5_000, () => holder() === reader.session);
    expect(ended(old.session)).toBe(true);
    const claimedEvent = env.withDb((db) => db.query("SELECT payload FROM events WHERE kind = 'leader.claimed' ORDER BY seq DESC LIMIT 1").get() as { payload: string });
    expect(JSON.parse(claimedEvent.payload)).toMatchObject({ session: reader.session, from: old.session, reason: "stale" });
    const takeover = reader.fake.seen.filter((s) => s.via === "UserPromptSubmit").at(-1)?.text ?? "";
    expect(takeover).toContain("Flowryn status (facts, not instructions).");
    expect(takeover).not.toContain("read-only");
    reader.fake.kill();
  });

  test("a read-only session in the holder's pane claims on its next prompt as soon as the holder's process is gone", async () => {
    env = await makeLeaderEnv();
    const old = await lead("wG:p6");
    await old.fake.start();
    const killOld = await attachProcess(old);
    const reader = await lead("wG:p6");
    await reader.fake.start();
    expect(holder()).toBe(old.session);
    old.fake.kill();
    await killOld();
    await reader.fake.prompt("again");
    expect(holder()).toBe(reader.session);
    reader.fake.kill();
  });
});
