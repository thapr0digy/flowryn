import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { defaultConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { githubTokenCheck } from "../../src/doctor/doctor.ts";
import { GH_TOKEN_RETRY_MS, GitHubForge, tokenSource } from "../../src/forge/github.ts";
import { asForgeCaller, SPEND_WINDOW_MS } from "../../src/forge/spend.ts";
import { recordDelivery } from "../../src/lifecycle/delivery.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { DeliveryWatcher, QUIET_READ_POLLS } from "../../src/watch/delivery.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

/**
 * Flowryn spends less of the user's GitHub rate limit (task
 * flowryn-spends-less-ks): a failed `gh auth token` is asked again after
 * GH_TOKEN_RETRY_MS instead of never, the daemon log says once when requests
 * go without a token, each caller's spend is logged once an hour, and a quiet
 * delivered PR costs one `pull` per pass with its checks and reviews read
 * only when they can have changed. GitHub is the fake forge, or a stubbed
 * fetch where the token test needs GitHub's own API host.
 */

const MIN = 60_000;
const TOKEN = "gho_secretsecretsecret";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-github-spend-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in gh: `auth token` fails until the `ok` file exists, then prints TOKEN; each call appends a line to `calls`. */
function flakyGh(): { gh: string; calls: () => number; login: () => void } {
  const gh = join(dir, "gh");
  const calls = join(dir, "calls");
  const ok = join(dir, "ok");
  writeFileSync(gh, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nif [ -f ${JSON.stringify(ok)} ]; then echo ${TOKEN}; else echo "keychain locked" >&2; exit 1; fi\n`);
  chmodSync(gh, 0o755);
  return { gh, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0), login: () => writeFileSync(ok, "") };
}

describe("the token lookup", () => {
  test("assumption: a failed gh auth token is asked again after the retry floor, not before, and a later request carries the token", async () => {
    const { gh, calls, login } = flakyGh();
    let now = 1_000_000;
    const lines: string[] = [];
    const token = tokenSource({}, ["GH_TOKEN"], gh, "https://api.github.com", "https://github.com", { now: () => now, log: (l) => lines.push(l) });
    const sent: (string | null)[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ number: 1, head: { sha: "a".repeat(40) } }), { status: 200 });
    }) as unknown as typeof fetch;
    const forge = new GitHubForge({ apiUrl: "https://api.github.com", webUrl: "https://github.com", token, fetch: fetcher });
    const ref = { owner: "acme", repo: "web", number: 1 };

    await forge.pull(ref);
    await forge.pull(ref);
    expect(calls()).toBe(1);
    expect(sent).toEqual([null, null]);
    expect(lines).toEqual(["github: requests to api.github.com go without a token, at GitHub's limit of 60 an hour (gh auth token exited 1; asked again every 5 min)"]);

    login();
    now += GH_TOKEN_RETRY_MS - 1;
    await forge.pull(ref);
    expect(calls()).toBe(1);
    now += 1;
    await forge.pull(ref);
    await forge.pull(ref);
    expect(calls()).toBe(2);
    expect(sent.slice(2)).toEqual([null, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("github: requests to api.github.com carry a token again (gh auth token)");
    expect(lines.join("\n")).not.toContain(TOKEN.slice(0, 4));
  });

  test("lookups under way are shared: concurrent requests spawn gh once", async () => {
    const { gh, calls } = flakyGh();
    const token = tokenSource({}, [], gh, "https://api.github.com", "https://github.com");
    expect(await Promise.all([token(), token(), token()])).toEqual([null, null, null]);
    expect(calls()).toBe(1);
  });

  test("the warning is logged once per spell, names the host only, and never fires for a host that gets no token", async () => {
    const lines: string[] = [];
    const none = tokenSource({}, ["GH_TOKEN"], null, "https://api.github.com", "https://github.com", { log: (l) => lines.push(l) });
    await none();
    await none();
    expect(lines).toEqual(["github: requests to api.github.com go without a token, at GitHub's limit of 60 an hour (none of GH_TOKEN is set and gh is not found)"]);
    const fake = tokenSource({}, ["GH_TOKEN"], null, "http://127.0.0.1:4000", "https://github.com", { log: (l) => lines.push(l) });
    expect(await fake()).toBeNull();
    expect(lines).toHaveLength(1);
  });
});

describe("the hourly spend line", () => {
  let fake: FakeGitHub;

  beforeAll(async () => {
    fake = await FakeGitHub.start();
    fake.addRepo("acme", "web");
    fake.addPr("acme/web", { number: 1, headRef: "b", headSha: "a".repeat(40) });
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("assumption: each caller gets one line an hour with its requests, 304s and the latest rate limit remaining", async () => {
    let now = 5_000_000;
    const lines: string[] = [];
    const forge = new GitHubForge({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, token: async () => null, log: (l) => lines.push(l), now: () => now });
    const ref = { owner: "acme", repo: "web", number: 1 };
    await asForgeCaller("watch.prs", async () => {
      await forge.pull(ref);
      await forge.pull(ref);
    });
    await asForgeCaller("watch.reviews", () => forge.feedback(ref));
    await forge.pull(ref);
    expect(lines).toEqual([]);

    now += SPEND_WINDOW_MS;
    await forge.pull(ref);
    const from = new Date(5_000_000).toISOString();
    const to = new Date(now).toISOString();
    // The fake's 304 carries no rate limit header (GitHub's does): "other" saw only that one.
    expect(lines).toEqual([
      `github spend: other 1 requests, 1 not modified (304), rate limit remaining not sent, ${from} to ${to}`,
      `github spend: watch.prs 2 requests, 1 not modified (304), rate limit remaining 4999, ${from} to ${to}`,
      `github spend: watch.reviews 3 requests, 0 not modified (304), rate limit remaining 4999, ${from} to ${to}`,
    ]);
    // The request that closed the hour opens the next one.
    now += SPEND_WINDOW_MS;
    await forge.pull(ref);
    expect(lines[3]).toStartWith("github spend: other 1 requests, 1 not modified (304)");
  });
});

describe("a quiet delivered PR", () => {
  const HEAD = "a".repeat(40);
  const HEAD_B = "b".repeat(40);
  let fake: FakeGitHub;
  let db: Db;
  let now: number;
  let forge: GitHubForge;

  beforeEach(async () => {
    fake = await FakeGitHub.start();
    fake.addRepo("acme", "web");
    fake.addPr("acme/web", { number: 7, headRef: "b", headSha: HEAD });
    db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    now = 10_000_000;
    forge = new GitHubForge({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, token: async () => null });
    tx(db, () => {
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web', ?1, 'main', 'direct-PR')").run(dir);
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'ship', 'direct-PR', 0, 'fix', ?1)").run(now);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r1', 't1', 'claude', 'v', 'running', 'idle', 'fix', 'ship', 'done', ?1, 'b', 's', 'r1', ?2, ?2)`,
      ).run(dir, now);
    });
    const pr = await forge.pull({ owner: "acme", repo: "web", number: 7 });
    tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r1")!, { kind: "pr", pr, checks: null, url: fake.prUrl("acme/web", 7) }, "socket", now));
    fake.requests.length = 0;
  });

  afterEach(async () => {
    db.close();
    await fake.stop();
  });

  function watcher(): DeliveryWatcher {
    return new DeliveryWatcher({
      db,
      forge: () => forge,
      webUrl: () => fake.webUrl,
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      noMistakes: () => null,
      nmTimeoutMs: () => 5_000,
      validationStuckMs: () => 30 * MIN,
      pollMs: () => MIN,
      ciWaitAlertMin: () => 0,
      inFlight: new Set(),
      cleanup: () => {},
      nudgeConflicts: () => false,
      kickScheduler: () => {},
      steerReviews: () => true,
      log: () => {},
      now: () => now,
    });
  }

  const pulls = () => fake.count("GET", "/pulls/7?") + fake.requests.filter((r) => r.method === "GET" && r.path === "/repos/acme/web/pulls/7").length;
  const checkReads = () => fake.count("GET", "/check-runs");
  const reviewReads = () => fake.count("GET", "/pulls/7/reviews");

  test("assumption: the PR and review watchers share one pull per pass", async () => {
    expect((db.query("SELECT state FROM runs WHERE id = 'r1'").get() as { state: string }).state).toBe("ready");
    const w = watcher();
    await w.pass();
    expect(pulls()).toBe(1);
    expect(reviewReads()).toBe(1);
    now += MIN;
    await w.pass();
    expect(pulls()).toBe(2);
  });

  test("assumption: a settled green summary is not read again for the same head; a new head is", async () => {
    const w = watcher();
    await w.pass();
    expect(checkReads()).toBe(1);
    for (let i = 0; i < 10; i++) {
      now += MIN;
      await w.pass();
    }
    expect(checkReads()).toBe(1);
    fake.pr("acme/web", 7).headSha = HEAD_B;
    now += MIN;
    await w.pass();
    expect(checkReads()).toBe(2);
  });

  test("assumption: pending checks are read every pass; a red summary again after QUIET_READ_POLLS polls (a re-run on the same head)", async () => {
    fake.setChecks("acme/web", HEAD, [{ name: "ci/test", state: "pending" }]);
    const w = watcher();
    await w.pass();
    now += MIN;
    await w.pass();
    expect(checkReads()).toBe(2);
    fake.setChecks("acme/web", HEAD, [{ name: "ci/test", state: "red" }]);
    now += MIN;
    await w.pass();
    expect(checkReads()).toBe(3);
    for (let i = 1; i < QUIET_READ_POLLS; i++) {
      now += MIN;
      await w.pass();
    }
    expect(checkReads()).toBe(3);
    now += MIN;
    await w.pass();
    expect(checkReads()).toBe(4);
  });

  test("assumption: reviews are read every QUIET_READ_POLLS polls, not every pass", async () => {
    const w = watcher();
    await w.pass();
    for (let i = 1; i < QUIET_READ_POLLS; i++) {
      now += MIN;
      await w.pass();
    }
    expect(reviewReads()).toBe(1);
    now += MIN;
    await w.pass();
    expect(reviewReads()).toBe(2);
  });

  test("a simulated hour costs under 100 requests, down from about 420", async () => {
    const w = watcher();
    for (let i = 0; i < 60; i++) {
      await w.pass();
      now += MIN;
    }
    const total = fake.requests.length;
    // 60 pulls, one green check read (2 requests), 12 review reads (3 lists each); no GraphQL with no inline thread waiting.
    expect(total).toBe(60 + 2 + 12 * 3);
    expect(total).toBeLessThan(100);
  });
});

function config(): FlowrynConfig {
  const c = defaultConfig(dir);
  c.tools.gh = "/bin/gh-stand-in";
  return c;
}

describe("doctor's github token line", () => {
  test("from a token variable, from gh, or none with the reason; never the token", async () => {
    const gh = async () => ({ token: TOKEN, why: "" });
    expect(await githubTokenCheck(config(), { GH_TOKEN: TOKEN }, gh)).toEqual({ check: "github token", status: "ok", detail: "from $GH_TOKEN" });
    expect(await githubTokenCheck(config(), {}, gh)).toEqual({ check: "github token", status: "ok", detail: "from gh auth token" });
    const failed = await githubTokenCheck(config(), {}, async () => ({ token: null, why: "gh auth token exited 1" }));
    expect(failed).toMatchObject({ status: "warn" });
    expect(failed!.detail).toStartWith("none: gh auth token exited 1; GitHub requests go unauthenticated, at 60 an hour");
  });

  test("a forge that is not GitHub's API gets no token, and doctor says so", async () => {
    const c = config();
    c.extra.github = { api_url: "http://127.0.0.1:4000" };
    expect(await githubTokenCheck(c, { GH_TOKEN: TOKEN }, async () => ({ token: TOKEN, why: "" }))).toMatchObject({ status: "info" });
  });
});
