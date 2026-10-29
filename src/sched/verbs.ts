import { FlowrynError } from "../api/errors.ts";
import { unresolvedLine } from "../attention/explanations.ts";
import { stringArg, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { capacityConfig, projectWorkerLimits, WORKER_POOL } from "../config/workflows.ts";
import { taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { unverifiedVersion } from "../lifecycle/harness-gate.ts";
import { neededPools, positionOf, projectLimit } from "../lifecycle/stages.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { fullPools, liveCounts, liveJobLeases, projectAtLimit, projectWorkerHolders } from "./pools.ts";
import { hostState } from "./scheduler.ts";
import { overrideQuota, quotaHolds, quotaLine, quotaState, quotaStates, type QuotaState } from "./quota.ts";
import { clearUsageLimit, resumeCommand, usageGate, usagePause, usagePauses, type UsagePause } from "./usage.ts";
import { signedOutAccounts } from "./signed-out.ts";
import { accountsConfig, harnessAccounts } from "../config/accounts.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { queuedRequests } from "../verify/queue.ts";
import { waitingOn } from "../verify/start.ts";
import { lensFor } from "../leader/scope.ts";

const MAX_WAITING_ROWS = 20;

function age(now: number, since: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** Why a waiting run has no grant yet, as the scheduler would see it now. */
function waitReason(ctx: ReadCtx, run: RunWithPolicy, needs: string[], caps: Record<string, number>, hostOk: boolean, signedOut: string[]): string {
  const account = run.account ?? run.harness;
  if (run.pending_launch && signedOut.includes(account)) return `${account} signed out`;
  if (usageGate(ctx.db, ctx.now, account, run.id) === "paused") return `${account} usage limit`;
  if (run.pending_launch === "fresh" && quotaHolds(ctx.db, account)) {
    const quota = quotaState(ctx.db, account)!;
    return `${account} quota ${quota.percent}% under floor ${quota.floor}%`;
  }
  const untested = run.pending_launch ? unverifiedVersion(ctx.db, run.harness) : null;
  if (untested) return `${run.harness} ${untested} has no passing contract`;
  if (needs.length === 0) return "next pass";
  const full = fullPools(ctx.db, caps, needs);
  if (full.length > 0) return `full: ${full.join(", ")}`;
  const limit = projectLimit(ctx.config, run.project_id);
  if (projectAtLimit(ctx.db, limit, needs)) return `project ${limit!.project} at its worker limit (${projectWorkerHolders(ctx.db, limit!.project).length}/${limit!.max})`;
  if (!hostOk) return "host check";
  return "next pass";
}

/**
 * `flowryn capacity` (design section 11): each pool's live leases against its
 * cap (a run's and a job's, such as a verify), each project's workers against
 * its `max_workers`, the jobs holding slots, the host
 * check, each account's usage-limit pause and quota floor, the verifies
 * queued for a validation slot, and the runs waiting for a grant in the order
 * the scheduler grants them.
 */
const capacity: VerbSpec = {
  name: "capacity",
  summary: "Capacity pools (live leases over caps), the host check, and the runs waiting for a grant",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  scope: { kind: "list" },
  read(ctx) {
    const cfg = capacityConfig(ctx.config);
    const counts = liveCounts(ctx.db);
    const host = hostState(ctx.db);
    const pauses = usagePauses(ctx.db);
    const quotas = quotaStates(ctx.db);
    const signedOut = signedOutAccounts(ctx.db);
    const rows = ctx.db
      .query(
        `SELECT r.*, tp.project_id, tp.kind, tp.delivery_mode, tp.sensitive, COALESCE(p.priority, 2) AS priority
         FROM runs r JOIN task_policy tp ON tp.task_id = r.task_id LEFT JOIN projects p ON p.id = tp.project_id
         WHERE r.state NOT IN ('cleaned','failed','cancelled') AND (r.stage_state = 'waiting' OR r.pending_launch IS NOT NULL)
           AND (r.pending_launch IS NOT NULL OR r.liveness != 'dead')`,
      )
      .all() as (RunWithPolicy & { priority: number })[];
    // A scoped leader sees its own scope's waiting runs and project limits; pools and accounts are shared and name no task.
    const lens = lensFor(ctx.db, ctx.config, ctx.caller.scope);
    const limits = projectWorkerLimits(ctx.config).filter((l) => lens.project(l.project));
    const waiting = rows
      .filter((run) => lens.task(run.task_id))
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
        why: waitReason(ctx, w.run, w.needs, cfg.pools, host?.ok !== false, signedOut),
        title: sanitizeLine(taskTitle(ctx.db, w.run.task_id), 60),
      }));
    const data: Record<string, unknown> = {
      pools: Object.entries(cfg.pools).map(([pool, cap]) => ({ pool, used: counts[pool] ?? 0, cap })),
      ...(limits.length > 0 ? { projects: limits.map((l) => ({ project: l.project, workers: projectWorkerHolders(ctx.db, l.project).length, max: l.max })) } : {}),
      host: host
        ? `${host.ok ? "ok" : `blocked: ${host.reason}`} (since ${age(ctx.now, host.since)} ago; needs ${cfg.host.min_free_mem_gb} GB free, load per core under ${cfg.host.max_load_per_core})`
        : `not checked yet (needs ${cfg.host.min_free_mem_gb} GB free, load per core under ${cfg.host.max_load_per_core})`,
      usage_limit: pauses.size > 0 ? [...pauses].map(([account, pause]) => ({ account, state: usageLine(ctx.now, pause) })) : "-",
      quota:
        cfg.quota.floor <= 0
          ? "off ([capacity.quota] floor = 0)"
          : quotas.size > 0
            ? [...quotas].map(([account, quota]) => ({ account, state: `${quotaLine(quota)} (since ${age(ctx.now, quota.since)} ago)` }))
            : `not read yet (floor ${cfg.quota.floor}%; read for an account before a new run starts on it)`,
      ...(signedOut.length > 0 ? { signed_out: signedOut } : {}),
      waiting: waiting.slice(0, MAX_WAITING_ROWS),
      unresolved: unresolvedLine(ctx.db, ctx.now),
    };
    const jobs = liveJobLeases(ctx.db);
    if (jobs.length > 0) data.jobs = jobs.map((j) => ({ job: j.job_id, kind: j.kind, pool: j.pool, task: j.task_id ?? "-", held: age(ctx.now, j.granted_at) }));
    // Verifies queued for a validation slot (src/verify/start.ts): granted before any stage, in this order.
    const queued = queuedRequests(ctx.db);
    if (queued.length > 0) data.verify_queue = queued.map((r) => ({ request: r.id, pr: r.pr_url, task: r.task_id ?? "-", waited: age(ctx.now, r.requested_at), why: waitingOn(ctx.db, r, cfg.pools, ctx.now) }));
    if (waiting.length > MAX_WAITING_ROWS) data.more = `${waiting.length - MAX_WAITING_ROWS} more waiting`;
    const hints = waiting.length > 0 ? ["flowryn show <task>"] : [`every run holds a ${WORKER_POOL} slot while its worker lives`];
    const held = [...new Set([...pauses.keys(), ...[...quotas].filter(([a]) => quotaHolds(ctx.db, a)).map(([a]) => a)])];
    return { data, hints: [...held.map(resumeCommand), ...hints] };
  },
};

export function usageLine(now: number, pause: UsagePause): string {
  const since = `paused since ${age(now, pause.since)} ago`;
  if (now < pause.until) return `${since}; expires in ${age(pause.until, now)}, then one run probes it`;
  return pause.probe ? `${since}; expired, ${pause.probe.run} probes it` : `${since}; expired, the next start probes it`;
}

/** One account's quota for `flowryn accounts`: the verdict with the reading it flipped on, and when. */
export function quotaCell(state: QuotaState | null, floor: number, unreadable: string | null = null): string {
  if (floor <= 0) return "off";
  if (!state) return unreadable ? `unknown (${unreadable})` : "not read yet";
  const at = new Date(state.since).toTimeString().slice(0, 5);
  if (state.state === "unknown") return `unknown (${state.detail ?? "no reading"})`;
  if (state.state === "ok") return `ok ${state.percent}% at ${at}`;
  return `low ${state.percent}% (floor ${state.floor}%)${state.override ? ", started anyway" : ""}`;
}

/** One account's usage pause for `flowryn accounts`. */
export function usageCell(now: number, pause: UsagePause | null): string {
  if (!pause) return "-";
  return now < pause.until ? `paused until ${new Date(pause.until).toTimeString().slice(0, 5)}` : pause.probe ? `probing (${pause.probe.run})` : "expired; the next start probes it";
}

/**
 * `flowryn capacity resume --account <id>`: you lift the account's usage-limit
 * pause now, in your own terminal (a leader or worker cannot), with an event,
 * resolving its P1. It also starts new runs on the account under the quota
 * floor, until its next reading that is not low. `--harness <h>` does it for
 * every account of the harness.
 */
const capacityResume: VerbSpec = {
  name: "capacity resume",
  summary: "Lift an account's usage-limit pause and its quota floor's hold now, in your own terminal",
  positionals: [],
  flags: {
    account: { type: "string", help: "the account whose pause to lift (flowryn accounts)", placeholder: "id" },
    harness: { type: "string", help: "every account of this harness: claude or pi", placeholder: "harness" },
  },
  kind: "mutation",
  roles: ["human"],
  apply(ctx, args) {
    const accountId = stringArg(args, "account");
    const harness = stringArg(args, "harness");
    if ((accountId === undefined) === (harness === undefined)) throw new FlowrynError("bad_args", "name one of --account <id> or --harness <claude|pi>", "flowryn accounts");
    let ids: string[];
    if (accountId !== undefined) {
      const known = Object.keys(accountsConfig(ctx.config()).accounts);
      // An account config dropped can still hold a recorded pause: it can be lifted too.
      if (!known.includes(accountId) && !usagePause(ctx.db, accountId) && !quotaState(ctx.db, accountId)) throw new FlowrynError("not_found", `no account ${accountId}`, "flowryn accounts");
      ids = [accountId];
    } else {
      if (!(HARNESS_IDS as readonly string[]).includes(harness!)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
      ids = harnessAccounts(ctx.config(), harness as HarnessId).map((a) => a.id);
    }
    const accounts = ids.map((id) => {
      const lifted = clearUsageLimit(ctx.db, id, "lifted by you (flowryn capacity resume)", ctx.now(), "cli");
      const quota = overrideQuota(ctx.db, id, ctx.now());
      return { account: id, usage: lifted ? "resumed" : "not paused", quota: quota ? "started anyway" : "not held" };
    });
    return { data: { accounts }, hints: ["flowryn capacity"] };
  },
  async settle(ctx, result) {
    const accounts = result.data.accounts as { usage: string; quota: string }[];
    if (accounts.some((a) => a.usage === "resumed" || a.quota === "started anyway")) ctx.sched.kick();
    return result;
  },
};

export const SCHED_VERBS: VerbSpec[] = [capacity, capacityResume];
