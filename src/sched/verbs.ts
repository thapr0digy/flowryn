import { FlowrynError } from "../api/errors.ts";
import { unresolvedLine } from "../attention/explanations.ts";
import { stringArg, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { capacityConfig, WORKER_POOL } from "../config/workflows.ts";
import { taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { unverifiedVersion } from "../lifecycle/harness-gate.ts";
import { neededPools, positionOf } from "../lifecycle/stages.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { fullPools, liveCounts, liveJobLeases } from "./pools.ts";
import { hostState } from "./scheduler.ts";
import { overrideQuota, quotaHolds, quotaLine, quotaState } from "./quota.ts";
import { clearUsageLimit, RESUME_COMMAND, usageGate, usagePause } from "./usage.ts";

const MAX_WAITING_ROWS = 20;

function age(now: number, since: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** Why a waiting run has no grant yet, as the scheduler would see it now. */
function waitReason(ctx: ReadCtx, run: RunWithPolicy, needs: string[], caps: Record<string, number>, hostOk: boolean): string {
  if (run.harness === "claude" && usageGate(ctx.db, ctx.now, run.id) === "paused") return "Claude usage limit";
  if (run.harness === "claude" && run.pending_launch === "fresh" && quotaHolds(ctx.db)) {
    const quota = quotaState(ctx.db)!;
    return `Claude quota ${quota.percent}% under floor ${quota.floor}%`;
  }
  const untested = run.pending_launch ? unverifiedVersion(ctx.db, run.harness) : null;
  if (untested) return `${run.harness} ${untested} has no passing contract`;
  if (needs.length === 0) return "next pass";
  const full = fullPools(ctx.db, caps, needs);
  if (full.length > 0) return `full: ${full.join(", ")}`;
  if (!hostOk) return "host check";
  return "next pass";
}

/**
 * `flowryn capacity` (design section 11): each pool's live leases against its
 * cap (a run's and a job's, such as a verify), the jobs holding slots, the host
 * check, the Claude usage-limit pause, the Claude quota floor, and the runs
 * waiting for a grant in the order the scheduler grants them.
 */
const capacity: VerbSpec = {
  name: "capacity",
  summary: "Capacity pools (live leases over caps), the host check, and the runs waiting for a grant",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx) {
    const cfg = capacityConfig(ctx.config);
    const counts = liveCounts(ctx.db);
    const host = hostState(ctx.db);
    const pause = usagePause(ctx.db);
    const quota = quotaState(ctx.db);
    const rows = ctx.db
      .query(
        `SELECT r.*, tp.project_id, tp.kind, tp.delivery_mode, tp.sensitive, COALESCE(p.priority, 2) AS priority
         FROM runs r JOIN task_policy tp ON tp.task_id = r.task_id LEFT JOIN projects p ON p.id = tp.project_id
         WHERE r.state NOT IN ('cleaned','failed','cancelled') AND (r.stage_state = 'waiting' OR r.pending_launch IS NOT NULL)
           AND (r.pending_launch IS NOT NULL OR r.liveness != 'dead')`,
      )
      .all() as (RunWithPolicy & { priority: number })[];
    const waiting = rows
      .map((run) => {
        const pos = positionOf(ctx.db, run, run.kind);
        return { run, pos, needs: neededPools(ctx.db, run, pos), remaining: pos.def.stages.length - 1 - pos.index };
      })
      .toSorted((a, b) => a.remaining - b.remaining || a.run.priority - b.run.priority || (a.run.waiting_since ?? 0) - (b.run.waiting_since ?? 0))
      .map((w) => ({
        task: w.run.task_id,
        stage: w.pos.stage.id,
        needs: w.needs.join(" ") || "-",
        waited: w.run.waiting_since ? age(ctx.now, w.run.waiting_since) : "-",
        why: waitReason(ctx, w.run, w.needs, cfg.pools, host?.ok !== false),
        title: sanitizeLine(taskTitle(ctx.db, w.run.task_id), 60),
      }));
    const data: Record<string, unknown> = {
      pools: Object.entries(cfg.pools).map(([pool, cap]) => ({ pool, used: counts[pool] ?? 0, cap })),
      host: host
        ? `${host.ok ? "ok" : `blocked: ${host.reason}`} (since ${age(ctx.now, host.since)} ago; needs ${cfg.host.min_free_mem_gb} GB free, load per core under ${cfg.host.max_load_per_core})`
        : `not checked yet (needs ${cfg.host.min_free_mem_gb} GB free, load per core under ${cfg.host.max_load_per_core})`,
      usage_limit: pause ? usageLine(ctx.now, pause) : "-",
      quota:
        cfg.quota.floor <= 0
          ? "off ([capacity.quota] floor = 0)"
          : quota
            ? `${quotaLine(quota)} (since ${age(ctx.now, quota.since)} ago)`
            : `not read yet (floor ${cfg.quota.floor}%; read before a new Claude run starts)`,
      waiting: waiting.slice(0, MAX_WAITING_ROWS),
      unresolved: unresolvedLine(ctx.db, ctx.now),
    };
    const jobs = liveJobLeases(ctx.db);
    if (jobs.length > 0) data.jobs = jobs.map((j) => ({ job: j.job_id, kind: j.kind, pool: j.pool, task: j.task_id ?? "-", held: age(ctx.now, j.granted_at) }));
    if (waiting.length > MAX_WAITING_ROWS) data.more = `${waiting.length - MAX_WAITING_ROWS} more waiting`;
    const hints = waiting.length > 0 ? ["flowryn show <task>"] : [`every run holds a ${WORKER_POOL} slot while its worker lives`];
    return { data, hints: pause || quotaHolds(ctx.db) ? [RESUME_COMMAND, ...hints] : hints };
  },
};

function usageLine(now: number, pause: NonNullable<ReturnType<typeof usagePause>>): string {
  const since = `Claude paused since ${age(now, pause.since)} ago`;
  if (now < pause.until) return `${since}; expires in ${age(pause.until, now)}, then one run probes it`;
  return pause.probe ? `${since}; expired, ${pause.probe.run} probes it` : `${since}; expired, the next Claude start probes it`;
}

/**
 * `flowryn capacity resume --harness claude`: you lift the Claude usage-limit
 * pause now, in your own terminal (a leader or worker cannot), with an event,
 * resolving its P1. It also starts new Claude runs under the quota floor,
 * until the next reading that is not low.
 */
const capacityResume: VerbSpec = {
  name: "capacity resume",
  summary: "Lift the Claude usage-limit pause and the quota floor's hold now, in your own terminal",
  positionals: [],
  flags: { harness: { type: "string", help: "the harness whose pause to lift: claude", placeholder: "harness" } },
  kind: "mutation",
  roles: ["human"],
  apply(ctx, args) {
    const harness = stringArg(args, "harness");
    if (harness !== "claude") throw new FlowrynError("bad_args", "--harness claude is required: only Claude work pauses on a usage limit");
    const lifted = clearUsageLimit(ctx.db, "lifted by you (flowryn capacity resume)", ctx.now(), "cli");
    const quota = overrideQuota(ctx.db, ctx.now());
    return { data: { harness, usage: lifted ? "resumed" : "not paused", quota: quota ? "started anyway" : "not held" }, hints: ["flowryn capacity"] };
  },
  async settle(ctx, result) {
    if (result.data.usage === "resumed" || result.data.quota === "started anyway") ctx.sched.kick();
    return result;
  },
};

export const SCHED_VERBS: VerbSpec[] = [capacity, capacityResume];
