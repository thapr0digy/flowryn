import { tx, type Db } from "../../src/db/db.ts";
import { batchRef } from "../../src/verify/batch-store.ts";
import { insertRequest, markStarted } from "../../src/verify/queue.ts";
import { finishVerification, insertVerification, type VerifyStep } from "../../src/verify/store.ts";

/**
 * A fleet for the dashboard (docs/notes/2026-11-24-a-live-build-t8.md), written through the
 * verify store's own writers and the landing tables as the daemon writes them: three passed
 * verifications of project web for history, one running (v4: two groups done, the tests
 * running 5 min of their usual 10, docs waiting), two queued requests, a landing batch of two
 * and one entry waiting behind it. `now` is the clock the summary is built at.
 */

const MIN = 60_000;
export const FLEET_TASKS = { running: "web-dash-a1", queued: "web-queue-b2", first: "web-land-c3", second: "web-land-d4", waiting: "web-land-e5" } as const;

function step(name: string, state: VerifyStep["state"], ms: number | null, group: number, extra: Partial<VerifyStep> = {}): VerifyStep {
  return { name, state, exit: state === "passed" ? 0 : null, ms, log: `${name.replace(/\W+/g, "-")}.log`, tests: null, detail: null, group, ...extra };
}

/** The history: each step's usual time is the median of these (install 1 min, check 2 min, tests 10 min, docs 1 min). */
const HISTORY: [number, number, number, number][] = [
  [MIN, 2 * MIN, 9 * MIN, MIN],
  [MIN, 2 * MIN, 10 * MIN, MIN],
  [MIN, 3 * MIN, 12 * MIN, MIN],
];

export function seedDashboardFleet(db: Db, now: number): void {
  const base = { project_id: "web", head_sha: "1a2b3c4d5e6f", policy_id: "p1", dir: (id: string) => `/tmp/v/${id}`, worktree: (id: string) => `/tmp/v/${id}/wt`, project_path: "/tmp/web", source: "cli" as const };
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://example.test/web.git', '/tmp/web', 'main', 'local-only')").run();
    HISTORY.forEach(([install, check, tests, docs], i) => {
      const started = now - (10 - i) * 60 * MIN;
      const v = insertVerification(db, {
        ...base,
        pr_url: `https://github.com/acme/web/pull/${100 + i}`,
        task_id: null,
        steps: [step("bun install", "passed", install, 0), step("bun run typecheck", "passed", check, 1), step("bun test", "passed", tests, 2), step("bun run docs", "passed", docs, 3)],
        now: started,
      });
      finishVerification(db, v, { state: "passed", steps: v.steps, tests: null, detail: null, binary: null }, started + install + check + tests + docs);
    });

    const running = insertRequest(db, { ...base, pr_url: "https://github.com/acme/web/pull/211", task_id: FLEET_TASKS.running, pr_number: 211, head_ref: "flowryn/dash", worktree: null, path: null, now: now - 12 * MIN });
    const v = insertVerification(db, {
      ...base,
      pr_url: running.pr_url,
      task_id: FLEET_TASKS.running,
      steps: [
        step("bun install", "passed", MIN, 0),
        step("bun run typecheck", "passed", 2 * MIN, 1),
        step("bun test", "running", null, 2, { started_at: now - 5 * MIN }),
        step("bun run docs", "waiting", null, 3),
      ],
      now: now - 8 * MIN,
    });
    markStarted(db, running, v.id, now - 8 * MIN);
    db.query("INSERT INTO job_leases (pool, kind, job_id, task_id, granted_at) VALUES ('validation', 'verify', ?1, ?2, ?3)").run(v.id, FLEET_TASKS.running, now - 8 * MIN);

    insertRequest(db, { ...base, pr_url: "https://github.com/acme/web/pull/212", task_id: FLEET_TASKS.queued, pr_number: 212, head_ref: "flowryn/queue", worktree: null, path: null, now: now - 4 * MIN });
    insertRequest(db, { ...base, pr_url: batchRef("web", "lb1"), task_id: null, pr_number: null, head_ref: null, worktree: null, path: null, now: now - 3 * MIN });

    db.query(
      `INSERT INTO landing_batches (id, project_id, state, base_sha, head_sha, integrations, created_at, state_since, updated_at)
       VALUES ('lb1', 'web', 'verifying', 'aaaa1111bbbb', 'cccc2222dddd', 0, ?1, ?1, ?1)`,
    ).run(now - 3 * MIN);
    const entry = (id: string, task: string, state: string, at: number, batchPos: number | null) =>
      db
        .query(
          `INSERT INTO landing_queue (id, project_id, run_id, task_id, ref, entered_head, head_sha, state, enqueued_at, state_since, updated_at, batch_id, batch_pos)
           VALUES (?1, 'web', ?2, ?3, ?4, 'eeee3333', 'eeee3333', ?5, ?6, ?6, ?6, ?7, ?8)`,
        )
        .run(id, `r-${task}`, task, `local:flowryn/${task}`, state, at, batchPos === null ? null : "lb1", batchPos);
    entry("lq1", FLEET_TASKS.first, "landing", now - 20 * MIN, 1);
    entry("lq2", FLEET_TASKS.second, "landing", now - 15 * MIN, 2);
    entry("lq3", FLEET_TASKS.waiting, "waiting", now - 2 * MIN, null);
  });
}
