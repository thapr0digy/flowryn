/**
 * Section 16's outages that end in one P1: Herdr unreachable ("P1 once", per
 * episode, once something needs it) and GitHub unavailable or rate-limited
 * ("P1 only if a merge is waiting"). Herdr is the fake Herdr, stopped and
 * started again on its socket; GitHub is the fake forge with its outage knobs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

const fleets: FleetEnv[] = [];
const ships: ShipEnv[] = [];
afterEach(async () => {
  for (const env of fleets.splice(0)) await env.cleanup();
  for (const env of ships.splice(0)) await env.cleanup();
});

async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  fleets.push(env);
  return env;
}

interface ItemView {
  id: string;
  lane: string;
  state: string;
  line: string;
}

function itemsOf(env: FleetEnv, kind: string): ItemView[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, lane, state, line FROM items WHERE kind = ?1 ORDER BY opened_at").all(kind) as ItemView[];
  } finally {
    db.close();
  }
}

function eventCount(env: FleetEnv, kind: string): number {
  const db = env.h.db();
  try {
    return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(kind) as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("Herdr unreachable: one P1 per episode", () => {
  test(
    "with a run open: one P1 however many retries fail; dispatch refuses; it resolves when Herdr answers; the next outage is a new one",
    async () => {
      const env = await fleet({ herdrAlertMs: 1_000 });
      const { run } = await env.dispatch("Scout\nFAKE: sleep 120000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await env.stopHerdr();
      await waitUntil(() => itemsOf(env, "herdr_unreachable").length === 1, 15_000, "the Herdr P1");
      const [item] = itemsOf(env, "herdr_unreachable");
      expect(item).toMatchObject({ lane: "P1", state: "open" });
      expect(item!.line).toContain("Herdr is unreachable");
      expect(item!.line).toContain("1 open run(s) read liveness unknown");
      const refused = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Another scout" });
      expect(refused.reply.error).toMatchObject({ code: "herdr_unavailable" });
      // The subscription keeps retrying with backoff; the episode still has one P1.
      await Bun.sleep(3_500);
      expect(itemsOf(env, "herdr_unreachable")).toHaveLength(1);
      expect(eventCount(env, "herdr.unreachable")).toBe(1);

      await env.startHerdr();
      await waitUntil(() => itemsOf(env, "herdr_unreachable")[0]!.state === "resolved", 30_000, "the P1 resolved");
      expect(eventCount(env, "herdr.reachable")).toBe(1);
      // The reconciler can resolve the P1 before the subscription's backoff reconnects it; the next
      // outage is seen when that subscription drops, so wait for it rather than for the next retry.
      await waitUntil(() => env.herdr.subscriberCount() > 0, 35_000, "the event subscription back");

      await env.stopHerdr();
      await waitUntil(() => itemsOf(env, "herdr_unreachable").length === 2, 15_000, "a second episode's P1");
      expect(itemsOf(env, "herdr_unreachable")[1]!.state).toBe("open");
    },
    { timeout: 120_000 },
  );

  test(
    "with nothing open and nothing asked of it, no P1; a dispatch it refuses raises it",
    async () => {
      const env = await fleet({ herdrAlertMs: 500 });
      await env.stopHerdr();
      await waitUntil(() => eventCount(env, "herdr.unreachable") === 1, 10_000, "the outage noticed");
      await Bun.sleep(2_000);
      expect(itemsOf(env, "herdr_unreachable")).toHaveLength(0);
      const refused = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout it" });
      expect(refused.reply.error).toMatchObject({ code: "herdr_unavailable" });
      await waitUntil(() => itemsOf(env, "herdr_unreachable").length === 1, 5_000, "the Herdr P1");
    },
    { timeout: 45_000 },
  );
});

function subscribeCalls(env: FleetEnv): number {
  return env.herdr.calls.filter((c) => c.method === "events.subscribe").length;
}

function unreachableDetails(env: FleetEnv): string[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE kind = 'herdr.unreachable' ORDER BY seq").all() as { payload: string }[]).map((r) => String((JSON.parse(r.payload) as { detail: unknown }).detail));
  } finally {
    db.close();
  }
}

describe("Herdr connected but not acknowledging the subscription", () => {
  test(
    "assumption: a silent peer fails within [herdr] handshake_ms and goes through the outage path; the daemon does not wedge, and recovers once Herdr answers",
    async () => {
      const env = await fleet({ herdrHandshakeMs: 300, herdrSubscribe: "silent" });
      await waitUntil(() => unreachableDetails(env).length === 1, 10_000, "the outage noticed");
      expect(unreachableDetails(env)[0]).toContain("did not acknowledge events.subscribe within 300 ms");
      // Retried with backoff, not held on one hung attempt.
      await waitUntil(() => subscribeCalls(env) >= 2, 10_000, "a second subscribe attempt");
      expect(env.herdr.subscriberCount()).toBe(0);

      env.herdr.subscribeReply = "answer";
      await waitUntil(() => env.herdr.subscriberCount() > 0, 20_000, "the event subscription up");
      await waitUntil(() => eventCount(env, "herdr.reachable") === 1, 10_000, "the episode ended");
      // The startup pass and the scheduler ran: a dispatch launches its worker.
      const { run } = await env.dispatch("Scout\nFAKE: sleep 120000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
    },
    { timeout: 60_000 },
  );

  test(
    "assumption: an acknowledgement of another type is protocol, not a started stream",
    async () => {
      const env = await fleet({ herdrHandshakeMs: 2_000, herdrSubscribe: (id) => JSON.stringify({ id, result: { type: "pane_info" } }) + "\n" });
      await waitUntil(() => unreachableDetails(env).length === 1, 10_000, "the outage noticed");
      expect(unreachableDetails(env)[0]).toContain("not subscription_started");
      expect(env.herdr.subscriberCount()).toBe(0);
    },
    { timeout: 30_000 },
  );
});

const PR_STEPS = (api: string) => `FAKE: commit fix.txt fixed\nFAKE: push\nFAKE: pr ${api} acme/web\nFAKE: deliver-pr\n`;

describe("GitHub unavailable or rate-limited: a P1 only if a merge is waiting", () => {
  test(
    "a delivered PR waits for its merge: one P1, the merge refuses; GitHub back, it resolves and the merge goes through",
    async () => {
      const e = await makeShipEnv({ mode: "direct-PR", yolo: true });
      ships.push(e);
      const { task, run } = await e.fleet.dispatch(`Fix the login loop\n${PR_STEPS(e.github.apiUrl)}FAKE: sleep 120000`, { kind: "ship" });
      await e.fleet.waitRun(run, (r) => r.state === "ready", "the PR delivered");
      e.github.unreachable = true;
      await waitUntil(() => itemsOf(e.fleet, "forge_unavailable").length === 1, 15_000, "the GitHub P1");
      const [item] = itemsOf(e.fleet, "forge_unavailable");
      expect(item).toMatchObject({ lane: "P1", state: "open" });
      expect(item!.line).toContain("GitHub is unavailable");
      expect(item!.line).toContain(`1 merge(s) wait (${task})`);
      const refused = await e.fleet.json(["merge", task]);
      expect(refused.reply.error).toMatchObject({ code: "forge_unavailable" });
      await Bun.sleep(1_500);
      expect(itemsOf(e.fleet, "forge_unavailable")).toHaveLength(1);

      e.github.unreachable = false;
      await waitUntil(() => itemsOf(e.fleet, "forge_unavailable")[0]!.state === "resolved", 30_000, "the P1 resolved");
      expect((await e.fleet.json(["merge", task])).code).toBe(0);
    },
    { timeout: 90_000 },
  );

  test(
    "rate-limited: the P1 names it; once no merge waits (the delivery declined), it resolves",
    async () => {
      const e = await makeShipEnv({ mode: "direct-PR" });
      ships.push(e);
      const { task, run } = await e.fleet.dispatch(`Fix the login loop\n${PR_STEPS(e.github.apiUrl)}FAKE: sleep 120000`, { kind: "ship" });
      await e.fleet.waitRun(run, (r) => r.state === "ready", "the PR delivered");
      e.github.rateLimited = true;
      await waitUntil(() => itemsOf(e.fleet, "forge_unavailable").length === 1, 15_000, "the GitHub P1");
      expect(itemsOf(e.fleet, "forge_unavailable")[0]!.line).toContain("GitHub is rate-limited");
      expect((await e.fleet.json(["decline", task, "--body-file", "-"], { stdin: "Not yet." })).code).toBe(0);
      await waitUntil(() => itemsOf(e.fleet, "forge_unavailable")[0]!.state === "resolved", 30_000, "the P1 resolved: no merge waits");
    },
    { timeout: 90_000 },
  );

  test(
    "with no merge waiting, an outage raises nothing",
    async () => {
      const e = await makeShipEnv({ mode: "direct-PR" });
      ships.push(e);
      const { run } = await e.fleet.dispatch("Build\nFAKE: sleep 120000", { kind: "ship" });
      await e.fleet.waitRun(run, (r) => r.liveness === "busy", "busy");
      e.github.unreachable = true;
      await Bun.sleep(2_000);
      expect(itemsOf(e.fleet, "forge_unavailable")).toHaveLength(0);
    },
    { timeout: 45_000 },
  );
});
