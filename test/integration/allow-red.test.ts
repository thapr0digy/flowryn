import { afterEach, describe, expect, test } from "bun:test";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * A red-check waiver from the leader conversation: `flowryn merge <task>
 * --allow-red <check>`, approved in Claude's own prompt (claude-ask) or the
 * Pi flowryn_merge confirm (pi-confirm). The leaders are fakes that run the
 * real leader bridge files; GitHub is a local fake whose one red check has a
 * name with spaces, a slash, parentheses and a comma.
 */

let env: ShipEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
}, 30_000);

const RED = "CI / build (ubuntu-latest, 20)";
const QUOTED = `'${RED}'`;

async function redShip(e: ShipEnv, title: string, flags: string[] = []): Promise<{ task: string; run: string }> {
  e.github.repo("acme/web").defaultChecks = [
    { name: "ci/test", state: "green" },
    { name: RED, state: "red" },
  ];
  const steps = `FAKE: commit ${title}.txt ${title}\nFAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\nFAKE: deliver-pr\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", ...flags, "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `${title}\n${steps}FAKE: sleep 120000` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const shipped = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(shipped.run, (r) => r.state === "ready", `${title} delivered`);
  // The prompt names the checks flowrynd last read: wait until it has read the red one.
  await waitUntil(() => evidenceRed(e, shipped.run).includes(RED), 10_000, "the red check read");
  return shipped;
}

function evidenceRed(e: ShipEnv, run: string): string[] {
  const db = e.fleet.h.db();
  try {
    const row = db.query("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'github'").get(run) as { value: string } | null;
    return row ? ((JSON.parse(row.value) as { checks?: { red?: string[] } }).checks?.red ?? []) : [];
  } finally {
    db.close();
  }
}

function mergedApproval(e: ShipEnv, task: string): { channel: string; allow_red_check: string | null; detail: string | null } | null {
  const db = e.fleet.h.db();
  try {
    return db
      .query("SELECT a.channel, a.allow_red_check, m.detail FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1 AND m.state = 'merged'")
      .get(task) as { channel: string; allow_red_check: string | null; detail: string | null } | null;
  } finally {
    db.close();
  }
}

function approvalKeyEvents(e: ShipEnv): number {
  const db = e.fleet.h.db();
  try {
    return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'leader.approval_key'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function errorOf(stdout: string): { code: string; message: string; help?: string } {
  return (JSON.parse(stdout) as { error: { code: string; message: string; help?: string } }).error;
}

describe("merge --allow-red through the leader's approval channels", () => {
  test(
    "Claude: the prompt shows the PR, the head and the exact check; a no runs nothing, a yes merges with a claude-ask waiver",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const leader = await e.claude();
      await leader.start();
      const { task, run } = await redShip(e, "waive");
      const head = e.github.pr("acme/web", 1).headSha;

      const plain = await leader.runBash(`flowryn merge ${task} --json`, { approve: true });
      expect(plain.code).toBe(2);
      expect(errorOf(plain.stdout).code).toBe("red_checks");
      expect(errorOf(plain.stdout).help).toContain(`flowryn merge ${task} --allow-red ${QUOTED}`);

      const wrong = await leader.runBash(`flowryn merge ${task} --allow-red ci/test --json`, { approve: true });
      expect(leader.prompts.at(-1)).toContain(`flowrynd last read failing: ${JSON.stringify(RED)}`);
      expect(wrong.code).toBe(2);
      expect(errorOf(wrong.stdout).code).toBe("red_checks");

      const no = await leader.runBash(`flowryn merge ${task} --allow-red ${QUOTED} --json`, { approve: false });
      expect(no).toMatchObject({ prompted: true, ran: false });
      const prompt = leader.prompts.at(-1)!;
      expect(prompt).toContain(`WAIVE the red check ${JSON.stringify(RED)}`);
      expect(prompt).toContain("https://github.com/acme/web/pull/1");
      expect(prompt).toContain(head.slice(0, 8));
      expect(prompt).not.toContain("refused");
      expect(e.fleet.run(run).state).toBe("ready");

      const yes = await leader.runBash(`flowryn merge ${task} --allow-red ${QUOTED} --json`, { approve: true });
      expect(yes).toMatchObject({ prompted: true, ran: true, code: 0 });
      expect(JSON.parse(yes.stdout).data).toMatchObject({ state: "merged", channel: "claude-ask", waived: RED });
      expect(mergedApproval(e, task)).toEqual({ channel: "claude-ask", allow_red_check: RED, detail: expect.stringContaining(`waived ${RED}`) });
    },
    { timeout: 120_000 },
  );

  test(
    "Claude on a yolo project: a waiver is never routine, so it is asked; bypassPermissions never counts",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true });
      const e = env;
      const leader = await e.claude();
      await leader.start();
      const first = await redShip(e, "yolo-red");

      const routine = await leader.runBash(`flowryn merge ${first.task} --json`, { approve: false });
      expect(routine).toMatchObject({ prompted: false, ran: true, code: 2 });
      expect(errorOf(routine.stdout).code).toBe("red_checks");

      leader.permissionMode = "bypassPermissions";
      const bypass = await leader.runBash(`flowryn merge ${first.task} --allow-red ${QUOTED} --json`, { approve: true });
      expect(bypass).toMatchObject({ prompted: true, ran: true, code: 2 });
      expect(errorOf(bypass.stdout).code).toBe("approval_required");
      expect(errorOf(bypass.stdout).message).toContain("yolo never waives");
      expect(e.fleet.run(first.run).state).toBe("ready");

      leader.permissionMode = "auto";
      const yes = await leader.runBash(`flowryn merge ${first.task} --allow-red ${QUOTED} --json`, { approve: true });
      expect(yes).toMatchObject({ prompted: true, ran: true, code: 0 });
      expect(mergedApproval(e, first.task)).toMatchObject({ channel: "claude-ask", allow_red_check: RED });
    },
    { timeout: 120_000 },
  );

  test(
    "Claude fail-open: the hook's ask is lost after flowrynd recorded the attempt, and Claude's own ask rule still prompts",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: true });
      const e = env;
      const leader = await e.claude();
      await leader.start();
      const { task, run } = await redShip(e, "fail-open");
      leader.hookDecisionsLost = true;

      const no = await leader.runBash(`flowryn merge ${task} --allow-red ${QUOTED} --json`, { approve: false });
      expect(no).toMatchObject({ prompted: true, ran: false });
      expect(leader.prompts.at(-1)).toBe(`Bash(flowryn merge ${task} --allow-red ${QUOTED} --json)`);
      expect(e.fleet.run(run).state).toBe("ready");

      // A shell value the hook cannot read exactly records no attempt, so even a yes merges nothing.
      const unreadable = await leader.runBash(`C=${QUOTED}; flowryn merge ${task} --allow-red "$C" --json`, { approve: true });
      expect(unreadable.code).toBe(2);
      expect(e.fleet.run(run).state).toBe("ready");
    },
    { timeout: 120_000 },
  );

  test(
    "Pi: flowryn_merge with allow_red shows the waived check in its confirm; yes merges with a pi-confirm waiver",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const leader = await e.pi();
      await leader.start();
      const { task, run } = await redShip(e, "pi-waive");

      const wrong = await leader.callTool("flowryn_merge", { task, allow_red: "ci/test" }, true);
      expect(wrong).toContain("Cannot waive");
      expect(leader.confirms).toHaveLength(0);

      const no = await leader.callTool("flowryn_merge", { task, allow_red: RED }, false);
      expect(no).toContain("declined");
      expect(leader.confirms[0]!.title).toContain(`waiving red check ${JSON.stringify(RED)}`);
      expect(leader.confirms[0]!.message).toContain(`WAIVE red check: ${JSON.stringify(RED)}`);
      expect(leader.confirms[0]!.message).toContain("https://github.com/acme/web/pull/1");
      expect(e.fleet.run(run).state).toBe("ready");

      // The lease's key rotated under the extension: the refusal asks for approval, so it fetches a fresh key once.
      const keysBefore = approvalKeyEvents(e);
      const db = e.fleet.h.db();
      try {
        db.query("UPDATE leader_lease SET approval_key_hash = 'rotated' WHERE id = 1").run();
      } finally {
        db.close();
      }
      const yes = await leader.callTool("flowryn_merge", { task, allow_red: RED }, true);
      expect(approvalKeyEvents(e)).toBeGreaterThan(keysBefore);
      expect(yes).toContain(`Merged ${task}`);
      expect(yes).toContain(`waiving ${JSON.stringify(RED)}`);
      expect(mergedApproval(e, task)).toMatchObject({ channel: "pi-confirm", allow_red_check: RED });
    },
    { timeout: 120_000 },
  );
});
