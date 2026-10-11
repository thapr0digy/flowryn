import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The policy follow-through end to end (task policy-follow-through-fy): the
 * real daemon, the fake Herdr and worker, the fake GitHub backed by the
 * project's bare origin, and the test homes' no-mistakes stand-in reporting
 * the ship's pipeline running. Merges land on the fake origin as a merge on
 * GitHub would; the follow-through's clock is shrunk to 400 ms.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const T = 120_000;
const CONFIG = "[upkeep]\nsync_primary = false\n[validation]\nci_wait_alert = 0\nfollow_interval_ms = 400";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A merge on GitHub that someone else made: `file` on origin's main. */
function mergeOnOrigin(origin: string, file: string, text: string): string {
  const clone = mkdtempSync(join(tmpdir(), "fw-policy-clone-"));
  try {
    git(tmpdir(), ["clone", "-q", origin, clone]);
    mkdirSync(dirname(join(clone, file)), { recursive: true });
    writeFileSync(join(clone, file), text);
    git(clone, ["add", "."]);
    git(clone, ["commit", "-q", "-m", `merge ${file}`]);
    git(clone, ["push", "-q", "origin", "main"]);
    return git(clone, ["rev-parse", "HEAD"]);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function rows<R>(f: FleetEnv, sql: string, ...params: string[]): R[] {
  const db = f.h.db();
  try {
    return db.query(sql).all(...params) as R[];
  } finally {
    db.close();
  }
}

function policySteers(f: FleetEnv, run: string): string[] {
  return rows<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at, rowid", run)
    .map((m) => m.body)
    .filter((b) => b.includes("changed its validation policy"));
}

function followEvents(f: FleetEnv, run: string): Record<string, unknown>[] {
  return rows<{ payload: string }>(f, "SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.policy_steered' ORDER BY seq", run).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

function openItems(f: FleetEnv, kind: string): string[] {
  return rows<{ line: string }>(f, "SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')", kind).map((r) => r.line);
}

/** Enough follow-through passes for one to have seen the latest merge: the clock is 400 ms, a pass a few git calls. */
const SETTLE_MS = 3_000;

describe("policy follow-through", () => {
  test(
    "a policy change merged to origin steers a validating ship once; an unrelated merge does not steer again; a further policy change does",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", extraConfig: CONFIG });
      const e = ship;
      const f = e.fleet;
      const steps = ["Follow the policy", "FAKE: commit b.txt b", "FAKE: verb stage begin ship", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: sleep 600000"].join("\n");
      const { run } = await f.dispatch(steps, { kind: "ship" });
      await waitUntil(() => e.github.repo("acme/web").prs.length === 1, 30_000, "the PR");
      writeFileSync(
        join(f.h.home, "nm-status"),
        [
          "run:",
          '  id: "01NMPOLICY"',
          `  branch: ${f.run(run).branch}`,
          "  status: running",
          "  head: abc",
          `  pr: "${e.github.prUrl("acme/web", 1)}"`,
          "  active_steps[1]{step,status,active_for,last_activity,agent_pid,round}:",
          '    review,running,1m,"1s ago: reviewing","",starting',
          "",
        ].join("\n"),
      );
      await f.waitRun(run, (r) => r.state === "validating", "validating");
      await Bun.sleep(SETTLE_MS);
      expect(policySteers(f, run)).toEqual([]);

      const tip = mergeOnOrigin(f.origin!, ".no-mistakes.yaml", "# settings\nno_ci: true\n");
      await waitUntil(() => policySteers(f, run).length === 1, 30_000, "the policy steer");
      expect(policySteers(f, run)[0]).toContain(`main changed its validation policy since your branch forked (.no-mistakes.yaml; origin/main at ${tip.slice(0, 8)})`);
      expect(policySteers(f, run)[0]).toContain("git merge origin/main; never rebase or force-push");
      expect(f.run(run).state).toBe("validating");

      mergeOnOrigin(f.origin!, "README.md", "an unrelated merge\n");
      await Bun.sleep(SETTLE_MS);
      expect(policySteers(f, run)).toHaveLength(1);

      mergeOnOrigin(f.origin!, ".github/workflows/ci.yml", "on: push\n");
      await waitUntil(() => policySteers(f, run).length === 2, 30_000, "the second policy steer");
      expect(policySteers(f, run)[1]).toContain(".github/workflows/ci.yml");
      const events = followEvents(f, run);
      expect(events.map((x) => x.via)).toEqual(["steer", "steer"]);
      expect(events[0]!.hash).not.toBe(events[1]!.hash);
    },
    { timeout: T },
  );

  test(
    "a delivered ship behind a policy change is sent back to merge main and deliver again, with a policy_sent_back line",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", extraConfig: CONFIG });
      const e = ship;
      const f = e.fleet;
      const steps = ["Deliver then follow", "FAKE: commit b.txt b", "FAKE: verb stage begin ship", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
      const { run } = await f.dispatch(steps, { kind: "ship" });
      await f.waitRun(run, (r) => r.state === "ready", "delivered");

      mergeOnOrigin(f.origin!, ".github/workflows/ci.yml", "on: push\n");
      await waitUntil(() => openItems(f, "policy_sent_back").length === 1, 30_000, "the send-back");
      expect(openItems(f, "policy_sent_back")[0]).toContain("Deliver then follow (web) was delivered without it; sent back to merge origin/main and deliver again");
      expect(followEvents(f, run)).toMatchObject([{ via: "send_back", files: [".github/workflows/ci.yml"] }]);
      await waitUntil(() => policySteers(f, run).length === 1, 30_000, "the stage start's steer");
      expect(policySteers(f, run)[0]).toContain("Your delivered PR is behind");
      expect(["running", "validating"]).toContain(f.run(run).state);
    },
    { timeout: T },
  );
});
