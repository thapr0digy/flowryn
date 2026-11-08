import { afterEach, describe, expect, test } from "bun:test";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Sensitive merges during a user-started away, end to end (docs/notes/2026-11-08-merge-sensitive-prs-rr.md):
 * a real daemon and CLI, the fake GitHub over the project's bare origin, a yolo direct-PR project
 * with verify steps and `[merge] sensitive_when_away = true`, and fake workers. The validator's
 * call goes to the fleet's stand-in `claude -p` (test/helpers/fake-ask.ts), which answers the
 * `ASK: reply` line the brief carries; nothing reaches a model or GitHub.
 */

let env: ShipEnv | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
}, 30_000);

const PASSING = ["printf ' 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [1.00ms]\\n'"];
const CONFIG = `[merge]\nsensitive_when_away = true\n[projects.web]\nverify = ${JSON.stringify(PASSING)}\n`;
const PASS = JSON.stringify({ verdict: "pass", findings: [], questions: [] });
const CHANGES = JSON.stringify({ verdict: "changes", findings: [{ requirement: "Requirement 2", problem: "A failed check still merges.", fix: "Refuse on a failed check." }], questions: [] });

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** A sensitive ship whose brief tells the stand-in validator what to answer; `after` runs once it delivered (the turn then waits). */
async function ship(e: ShipEnv, title: string, answer: string, opts: { file?: string; after?: string[]; idle?: boolean } = {}): Promise<{ task: string; run: string }> {
  const file = opts.file ?? "sensitive.txt";
  const steps = [`FAKE: commit ${file} ${file}`, "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", ...(opts.after ?? []), ...(opts.idle ? [] : ["FAKE: sleep 120000"])];
  const body = [title, `ASK: reply ${answer}`, ...steps].join("\n");
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--sensitive", "--body-file", "-"], { stdin: body });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  return dispatched.reply.data as { task: string; run: string };
}

/** Delivered and its auto-verify passed at the delivered head: what every case starts from. */
async function verified(e: ShipEnv, run: string): Promise<void> {
  await e.fleet.waitRun(run, (r) => r.state === "ready", "the delivery");
  await waitUntil(() => query(e, "SELECT 1 FROM auto_merges WHERE run_id = ?1 AND state = 'verified'", run).length === 1, 60_000, "the delivery's verify passed");
}

const landed = (e: ShipEnv, run: string) => query(e, "SELECT 1 FROM runs WHERE id = ?1 AND state IN ('landed','cleaned')", run).length === 1;
const rounds = (e: ShipEnv, task: string) => query<{ id: string; state: string; reason: string | null }>(e, "SELECT id, state, reason FROM gate_validations WHERE task_id = ?1 AND stage = 'merge' ORDER BY started_at, id", task);

describe("sensitive merges while you are away", () => {
  test(
    "an away you started: verify and the validator pass, it merges on channel away-validator, and back's brief lists it with its URL, report and undo",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: CONFIG });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      const s = await ship(e, "Tighten the token check", PASS);
      await verified(e, s.run);
      // You are here: nothing merges by itself, and the PR waits for your approval as today.
      await Bun.sleep(1_500);
      expect(rounds(e, s.task)).toEqual([]);
      expect(landed(e, s.run)).toBe(false);
      expect(query(e, "SELECT 1 FROM items WHERE kind = 'sensitive_action_waiting' AND run_id = ?1 AND state IN ('open','presented')", s.run)).toHaveLength(1);

      expect((await e.call("away", { until: "+8h" })).ok).toBe(true);
      await waitUntil(() => landed(e, s.run), 60_000, "the sensitive merge");
      expect(rounds(e, s.task)).toEqual([expect.objectContaining({ id: "j1", state: "passed" })]);
      const merge = query<{ id: string; channel: string; actor: string; pr_url: string; head_sha: string }>(e, "SELECT m.id, a.channel, a.actor, m.pr_url, m.head_sha FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1", s.task);
      expect(merge).toEqual([expect.objectContaining({ channel: "away-validator" })]);
      expect(merge[0]!.actor).toMatch(/^validator j1 \(away since \d\d:\d\d, started by human\)$/);
      const judged = query<{ head: string }>(e, "SELECT head FROM gate_validations WHERE id = 'j1'")[0]!.head;
      expect(merge[0]!.head_sha).toBe(judged);
      // Never recorded as you.
      expect(query(e, "SELECT 1 FROM approvals WHERE task_id = ?1 AND channel IN ('cli-tty','board')", s.task)).toHaveLength(0);

      const shown = await e.call("show", { target: "j1" });
      expect(shown.data).toMatchObject({ validation: "j1", stage: "merge", gate: "-", state: "passed", verdict: "pass" });
      const back = await e.call("back", {});
      const brief = ((back.data as { brief: string[] }).brief ?? []).join("\n");
      expect(brief).toContain(`- [${merge[0]!.id}] merged sensitive PR ${merge[0]!.pr_url}`);
      expect(brief).toContain("report: flowryn show j1; undo: git revert ");
      expect(brief).toContain("in a new fix ship");
      expect(brief).toContain(`pre-merge check of sensitive`);
    },
    { timeout: 150_000 },
  );

  test(
    "an away the leader started on its own counts for nothing: no round, no merge",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: CONFIG });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      const s = await ship(e, "Leader away", PASS);
      await verified(e, s.run);
      const away = await e.fleet.json(["away", "--until", "+8h"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(away.code).toBe(0);
      await Bun.sleep(3_000);
      expect(rounds(e, s.task)).toEqual([]);
      expect(landed(e, s.run)).toBe(false);
      expect(query(e, "SELECT 1 FROM approvals WHERE channel = 'away-validator'")).toHaveLength(0);
    },
    { timeout: 120_000 },
  );

  test(
    "the validator asks for changes: no merge, and the worker is sent back with its findings",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: CONFIG });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      const s = await ship(e, "Needs changes", CHANGES);
      await verified(e, s.run);
      expect((await e.call("away", { until: "+8h" })).ok).toBe(true);
      await waitUntil(() => rounds(e, s.task).some((r) => r.state === "changes"), 60_000, "the changes round");
      await waitUntil(() => query(e, "SELECT 1 FROM messages WHERE run_id = ?1 AND body LIKE '%The independent validator (j1) checked this PR%'", s.run).length === 1, 30_000, "the worker's findings");
      const body = query<{ body: string }>(e, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%independent validator%'", s.run)[0]!.body;
      expect(body).toContain("1. (requirement: Requirement 2) A failed check still merges. Fix: Refuse on a failed check.");
      expect(landed(e, s.run)).toBe(false);
      expect(query(e, "SELECT 1 FROM approvals WHERE channel = 'away-validator'")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM merges WHERE task_id = ?1", s.task)).toHaveLength(0);
    },
    { timeout: 120_000 },
  );

  test(
    "the head moves while the validator judges it: advice only, no merge at the judged head",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: CONFIG });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      // The stand-in sleeps 4 s before it answers; the worker commits again meanwhile (once the test drops go.txt).
      const s = await ship(e, "Moving head", `${PASS}\nASK: sleep 4000`, { after: ["FAKE: wait-file go.txt", "FAKE: commit later.txt later"] });
      await verified(e, s.run);
      expect((await e.call("away", { until: "+8h" })).ok).toBe(true);
      await waitUntil(() => rounds(e, s.task).length === 1, 30_000, "the round started");
      await Bun.write(`${e.fleet.h.dataDir}/${s.task}/go.txt`, "go");
      await waitUntil(() => rounds(e, s.task)[0]?.state === "advised", 30_000, "advice only");
      expect(rounds(e, s.task)[0]!.reason).toContain("moved");
      await Bun.sleep(1_500);
      expect(landed(e, s.run)).toBe(false);
      expect(query(e, "SELECT 1 FROM approvals WHERE channel = 'away-validator'")).toHaveLength(0);
      expect(query(e, "SELECT 1 FROM items WHERE kind = 'validator_advice' AND run_id = ?1", s.run)).toHaveLength(1);
    },
    { timeout: 120_000 },
  );

  test(
    "the forge refuses the merge: it does not land, and the brief says it waits for you",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: CONFIG });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      e.github.repo("acme/web").mergeMode = "refuse";
      const s = await ship(e, "Refused by GitHub", PASS);
      await verified(e, s.run);
      expect((await e.call("away", { until: "+8h" })).ok).toBe(true);
      await waitUntil(() => query(e, "SELECT 1 FROM merges WHERE task_id = ?1 AND state = 'refused'", s.task).length === 1, 60_000, "the refused merge");
      expect(landed(e, s.run)).toBe(false);
      const back = await e.call("back", {});
      const brief = ((back.data as { brief: string[] }).brief ?? []).join("\n");
      expect(brief).toMatch(/sensitive PR \S+ of .* did not merge \(refused: .*\); it waits for you \(report: flowryn show j1\)/);
    },
    { timeout: 120_000 },
  );

  test(
    "on a landing-queue project: the queue's merge of main moves the head, so the validator judges the new head again, and it lands there",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true, extraConfig: `[merge]\nsensitive_when_away = true\n[projects.web]\nverify = ${JSON.stringify(PASSING)}\nlanding = "queue"\nlanding_train_depth = 1\n` });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      expect((await e.call("away", { until: "+8h" })).ok).toBe(true);
      // A routine PR first: it lands and moves main under the sensitive one.
      const routine = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { stdin: `routine\nFAKE: commit one.txt one\nFAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\nFAKE: deliver-pr\n` });
      expect(routine.code).toBe(0);
      const first = routine.reply.data as { task: string; run: string };
      await e.fleet.waitRun(first.run, (r) => r.state === "ready", "the routine delivery");
      // Its turn ends once it delivered: the queue waits on a busy worker before it merges main in.
      const s = await ship(e, "Sensitive behind it", PASS, { file: "two.txt", idle: true });
      await e.fleet.waitRun(s.run, (r) => r.state === "ready", "the sensitive delivery");
      await waitUntil(() => landed(e, s.run), 150_000, "the sensitive PR to land through the queue");
      const merge = query<{ head_sha: string; channel: string }>(e, "SELECT m.head_sha, a.channel FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1", s.task);
      expect(merge).toEqual([expect.objectContaining({ channel: "away-validator" })]);
      const passed = rounds(e, s.task).filter((r) => r.state === "passed");
      // The routine PR landed first, so the queue merged main in: two rounds, the second at the new head.
      expect(passed.length).toBe(2);
      // The merged head is exactly the last one the validator judged.
      const last = query<{ head: string }>(e, "SELECT head FROM gate_validations WHERE task_id = ?1 AND stage = 'merge' AND state = 'passed' ORDER BY started_at DESC, id DESC LIMIT 1", s.task)[0]!.head;
      expect(merge[0]!.head_sha).toBe(last);
      expect(query(e, "SELECT 1 FROM landing_queue WHERE task_id = ?1 AND state = 'left' AND reason = 'approval_needed'", s.task)).toHaveLength(1);
      // The validator judged the new head by itself: nothing was held for you or woke the leader.
      expect(query(e, "SELECT 1 FROM items WHERE kind = 'auto_merge_held' AND run_id = ?1", s.run)).toHaveLength(0);
    },
    { timeout: 240_000 },
  );
});
