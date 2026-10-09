/**
 * Worker reports reach the leader (task title-worker-reports-df), end to end:
 * a fake worker runs `flowryn report` through the real CLI. A status word that
 * opens an item (REPORT_EFFECT) raises one P1 worker_report item; the
 * leader's next message carries its digest line, `fleet` lists it, `show`
 * gives the whole body; an identical repeat adds no item; progress is only
 * recorded; dismissing the item, or the run's end, closes it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Reply } from "../../src/api/envelope.ts";
import { DIGEST_HEADER } from "../../src/attention/router.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
async function fleet(): Promise<FleetEnv> {
  const env = await makeFleetEnv();
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

const T = 30_000;

interface ReportItem {
  id: string;
  lane: string;
  class: string;
  state: string;
  line: string;
  resolved_by: string | null;
}

function reportItems(env: FleetEnv, runId: string): ReportItem[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, lane, class, state, line, resolved_by FROM items WHERE run_id = ?1 AND kind = 'worker_report' ORDER BY opened_at").all(runId) as ReportItem[];
  } finally {
    db.close();
  }
}

function reportStatuses(env: FleetEnv, runId: string): string[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'worker.report' ORDER BY seq").all(runId) as { payload: string }[]).map((e) => JSON.parse(e.payload).status as string);
  } finally {
    db.close();
  }
}

/** A Claude leader session holding the lease, as `flowryn lead` opens one; its token runs the prompt hook. */
async function openLeader(env: FleetEnv): Promise<string> {
  const reply = (await request(
    join(env.h.home, "run", "flowrynd.sock"),
    { proto: PROTO, ulid: ulid(), verb: "lead.open", token: null, channel: "tty", args: { harness: "claude", pane: "w9:p42", cwd: env.h.home } },
    { connectMs: 1_000, replyMs: 30_000 },
  )) as Reply;
  if (!reply.ok) throw new Error(`lead.open: ${JSON.stringify(reply.error)}`);
  const { token } = reply.data as { token: string };
  const claimed = await env.json(["leader", "claim"], { env: { FLOWRYN_TOKEN: token } });
  if (claimed.code !== 0) throw new Error(`leader claim: ${JSON.stringify(claimed.reply)}`);
  return token;
}

/** What the leader's next message carries: the UserPromptSubmit hook's context. */
async function nextMessageContext(env: FleetEnv, token: string): Promise<string> {
  const result = await env.cli(["hook", "prompt", "--harness", "claude"], { env: { FLOWRYN_TOKEN: token }, stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "what's new?" }) });
  return result.stdout;
}

const FINDING = "Pi contract c12 fails on the installed build: the steer-seen hook never fires after a compaction, so a mid-turn steer stays unseen and is re-rung three times before its P1. FLOWRYN-MARK-TAIL";

describe("worker reports reach the leader", () => {
  test(
    "a finding opens one P1 item: the digest line, fleet needs, the full text in show; a repeat adds none, progress opens none, dismiss closes it",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch(`Check the contract\nFAKE: wait-file go\nFAKE: report finding ${FINDING}\nFAKE: report finding ${FINDING}\nFAKE: report progress halfway there\nFAKE: sleep 60000`);
      // Claiming the lease retires the fleet's seeded leader token, so the session opens after the dispatch.
      const leader = await openLeader(env);
      // The session's first message gets the briefing; the reports open after it, so the next one gets a digest.
      expect(await nextMessageContext(env, leader)).not.toContain("Report (");
      await Bun.write(join(env.h.dataDir, task, "go"), "");
      await waitUntil(() => reportStatuses(env, run).length === 3, 15_000, "three reports recorded");

      // The repeat is recorded but adds no item; progress is only recorded.
      expect(reportStatuses(env, run)).toEqual(["finding", "finding", "progress"]);
      const items = reportItems(env, run);
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item).toMatchObject({ lane: "P1", class: "actionable", state: "open" });
      expect(item.line).toStartWith('Report (finding) from Check the contract: "Pi contract c12 fails');
      expect(item.line).toEndWith("(flowryn show for the full text)");

      // The leader's next message carries it in the digest.
      const context = await nextMessageContext(env, leader);
      expect(context).toContain(DIGEST_HEADER);
      expect(context).toContain(`[${item.id}] Report (finding) from Check the contract`);

      // fleet: in needs, and the run's needs column says report.
      const fleetReply = await env.json(["fleet"], { env: { FLOWRYN_TOKEN: leader } });
      const fleetData = fleetReply.reply.data as { needs: { id: string; lane: string }[]; fleet: { id: string; needs: string }[] };
      expect(fleetData.needs).toContainEqual(expect.objectContaining({ id: item.id, lane: "P1" }));
      expect(fleetData.fleet.find((r) => r.id === task)?.needs).toBe("report");

      // show <item>: the report itself, with the whole body.
      const shown = await env.json(["show", item.id], { env: { FLOWRYN_TOKEN: leader } });
      expect(shown.reply.data).toMatchObject({ item: item.id, kind: "worker_report", status: "finding", task, run, body: FINDING });
      // show <run>: the latest report of any status.
      const runView = await env.json(["show", run], { env: { FLOWRYN_TOKEN: leader } });
      expect(String((runView.reply.data as { report: string }).report)).toMatch(/^progress · \S+ ago · halfway there$/);

      const dismissed = await env.json(["dismiss", item.id], { env: { FLOWRYN_TOKEN: leader } });
      expect(dismissed.code).toBe(0);
      expect(reportItems(env, run).map((i) => i.state)).toEqual(["dismissed"]);
    },
    T,
  );

  test(
    "a multi-line body keeps its lines in show, plain and --json; a status outside the table opens an item",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Check the build\nFAKE: report flaky FLOWRYN-MARK-L1 first line\\nFLOWRYN-MARK-L2 second line\nFAKE: sleep 60000");
      await waitUntil(() => reportItems(env, run).length === 1, 15_000, "the report's item");
      const item = reportItems(env, run)[0]!;
      expect(item.line).toBe('Report (flaky) from Check the build: "FLOWRYN-MARK-L1 first line FLOWRYN-MARK-L2 second line"');
      const json = await env.json(["show", item.id]);
      expect((json.reply.data as { body: string }).body).toBe("FLOWRYN-MARK-L1 first line\nFLOWRYN-MARK-L2 second line");
      const plain = (await env.cli(["show", item.id])).stdout;
      expect(plain).toContain("FLOWRYN-MARK-L1 first line");
      expect(plain).toContain("FLOWRYN-MARK-L2 second line");
      expect(plain).toContain(`flowryn dismiss ${item.id}`);
    },
    T,
  );

  test(
    "the run's end closes its open report items",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout the cache\nFAKE: report blocked the staging cache is down\nFAKE: wait-file go\nFAKE: deliver notes.md the cache evicts too early\nFAKE: sleep 60000");
      await waitUntil(() => reportItems(env, run).length === 1, 15_000, "the blocked report's item");
      expect(reportItems(env, run)[0]).toMatchObject({ state: "open", line: 'Report (blocked) from Scout the cache: "the staging cache is down"' });
      await Bun.write(join(env.h.dataDir, env.run(run).task_id, "go"), "");
      await env.waitRun(run, (r) => r.state === "landed" || r.state === "cleaned", "the scout landed");
      expect(reportItems(env, run)).toMatchObject([{ state: "resolved", resolved_by: "run.landed report" }]);
    },
    T,
  );
});
