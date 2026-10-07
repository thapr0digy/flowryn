import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * `flowryn verify` end to end: a real daemon, the fake GitHub backed by the
 * project's bare origin, and a tiny fixture project whose verify steps are
 * shell lines (one prints a bun summary, one builds a stand-in binary). Its
 * one check is a GitHub Actions job GitHub never started (Actions billing),
 * so the merge needs local green. Nothing reaches GitHub.
 */

let env: ShipEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
}, 30_000);

const CI = "typecheck, lint, test, build, fixtures";

const STEPS = [
  // A step sees none of this Flowryn: the test home's FLOWRYN_HOME must not reach it.
  'test -z "$(env | grep ^FLOWRYN_)"',
  "printf ' 3 pass\\n 0 fail\\n 9 expect() calls\\nRan 3 tests across 1 file. [4.00ms]\\n'",
  "mkdir -p dist && printf fake-binary > dist/flowryn && chmod 755 dist/flowryn",
];

const VERIFY_CONFIG = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nverify_binary = "dist/flowryn"\n`;

async function unstartedShip(e: ShipEnv, title: string): Promise<{ task: string; run: string }> {
  e.github.repo("acme/web").defaultChecks = [{ name: CI, state: "red", notStarted: true }];
  const steps = `FAKE: commit ${title}.txt ${title}\nFAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\nFAKE: deliver-pr\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `${title}\n${steps}FAKE: sleep 120000` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const shipped = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(shipped.run, (r) => r.state === "ready", `${title} delivered`);
  return shipped;
}

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("flowryn verify", () => {
  test(
    "a PR whose CI never started: merge refuses and says verify; verify passes at the head; the merge then lands on local green",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", extraConfig: VERIFY_CONFIG });
      const e = env;
      const { task } = await unstartedShip(e, "verify-me");
      const head = e.github.pr("acme/web", 1).headSha;
      expect((await e.approve(task)).ok).toBe(true);

      const before = await e.call("merge", { task });
      expect(before.ok).toBe(false);
      expect(before.error).toMatchObject({ code: "red_checks" });
      expect(before.error!.message).toContain(`CI never started at ${head.slice(0, 8)}`);
      expect(before.error!.help).toContain(`flowryn verify ${task}`);

      const verified = await e.fleet.cli(["verify", task]);
      expect(verified.stderr).toBe("");
      expect(verified.code).toBe(0);
      expect(verified.stdout).toContain(`v1 · web https://github.com/acme/web/pull/1 at ${head.slice(0, 8)}`);
      for (const step of STEPS) expect(verified.stdout).toContain(`✓ ${step}`);
      expect(verified.stdout).toContain("3 pass · 0 fail · 1 file");
      const binary = join(e.fleet.h.home, "state", "verify", "v1", "bin", "flowryn");
      expect(verified.stdout).toContain(`binary ${binary}`);
      expect(readFileSync(binary, "utf8")).toBe("fake-binary");
      expect(existsSync(join(e.fleet.h.home, "state", "verify", "v1", "wt"))).toBe(false);

      const recorded = query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'pr.verified'").map((r) => JSON.parse(r.payload) as Record<string, unknown>);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ verification: "v1", pr: "https://github.com/acme/web/pull/1", head, ok: true, tests: { pass: 3, fail: 0, tests: 3, files: 1 }, binary });

      const shown = await e.fleet.json(["show", task]);
      expect(JSON.stringify(shown.reply.data)).toContain(`v1 passed at ${head.slice(0, 8)} (3 pass, 0 fail)`);
      const detail = await e.fleet.json(["verify", "show", "v1"]);
      expect(detail.reply.data).toMatchObject({ verification: "v1", state: "passed", task, binary, tests: "3 pass · 0 fail · 1 file" });

      const merged = await e.call("merge", { task });
      expect(merged.ok).toBe(true);
      expect(merged.data).toMatchObject({ state: "merged", local_green: "v1", waived: "-" });
      const requested = query<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'merge.requested'").map((r) => JSON.parse(r.payload) as Record<string, unknown>);
      expect(requested.at(-1)).toMatchObject({ local_green: "v1", waived: null });
      expect(query<{ detail: string }>(e, "SELECT detail FROM merges WHERE task_id = ?1", task)[0]!.detail).toContain("local green v1");
    },
    { timeout: 120_000 },
  );

  test(
    "a PR number resolves through the one GitHub project; a fork and an unknown PR are refused; --detach returns the id; a PR URL works too",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", extraConfig: VERIFY_CONFIG });
      const e = env;
      await unstartedShip(e, "by-number");

      e.github.addPr("acme/web", { number: 50, headRef: "main", headRepo: "mallory/web" });
      const fork = await e.fleet.json(["verify", "50"]);
      expect(fork.code).toBe(2);
      expect(fork.reply.error).toMatchObject({ code: "fork_pr" });

      const missing = await e.fleet.json(["verify", "#77"]);
      expect(missing.code).toBe(4);
      expect(missing.reply.error).toMatchObject({ code: "not_found" });

      const detached = await e.fleet.json(["verify", "1", "--detach"]);
      expect(detached.code).toBe(0);
      expect(detached.reply.data).toMatchObject({ verification: "v1", task: expect.any(String), attached: false });
      await waitUntil(() => query<{ state: string }>(e, "SELECT state FROM verifications WHERE id = 'v1'")[0]?.state === "passed", 30_000, "v1 passed");

      // A verify the PR head already has reruns: the merge reads the newest one.
      const url = await e.fleet.json(["verify", "https://github.com/acme/web/pull/1"]);
      expect(url.code).toBe(0);
      expect(url.reply.data).toMatchObject({ verification: "v2", state: "passed" });

    },
    { timeout: 120_000 },
  );

  test(
    "a project without verify steps is refused with what to paste",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      await unstartedShip(e, "unconfigured");
      const refused = await e.fleet.json(["verify", "1"]);
      expect(refused.code).toBe(3);
      expect(refused.reply.error).toMatchObject({ code: "not_configured" });
      expect(JSON.stringify(refused.reply.error)).toContain("[projects.web]");
      expect(query(e, "SELECT id FROM verifications")).toEqual([]);
    },
    { timeout: 120_000 },
  );
});
