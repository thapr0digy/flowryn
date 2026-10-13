import type { Fact, Unblock } from "../attention/explanations.ts";
import type { HostCheckConfig } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { harnessFacts, harnessUnblock, harnessWaitReason, type AutoAttempt, type HarnessCheck } from "../lifecycle/harness-gate.ts";
import { liveCounts } from "./pools.ts";
import { quotaState } from "./quota.ts";
import type { HostState } from "./scheduler.ts";
import { RESUME_COMMAND, usagePause } from "./usage.ts";

/**
 * Why the scheduler refused a grant, as the rule saw it (docs/notes/2026-10-12-next-steps-md-wz.md):
 * one builder per check in tryGrant, each from the state the check read. Facts hold the times
 * things started, never a duration, so a wait that has not changed explains the same way.
 */
export interface Refusal {
  rule: string;
  reason: string;
  facts: Fact[];
  unblock: Unblock[];
}

const iso = (t: number) => new Date(t).toISOString();
const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);

export function usageRefusal(db: Db, now: number): Refusal {
  const pause = usagePause(db);
  if (!pause) return { rule: "capacity.usage_limit", reason: "the Claude usage limit pauses Claude starts", facts: [], unblock: [{ by: "captain", action: RESUME_COMMAND }] };
  const probing = now >= pause.until && pause.probe !== null;
  return {
    rule: "capacity.usage_limit",
    reason: probing ? `the Claude usage limit: run ${pause.probe!.run} probes it first` : `the Claude usage limit pauses Claude starts until ${clock(pause.until)}`,
    facts: [
      { name: "usage limit hit", value: pause.who, at: pause.since },
      { name: "pause until", value: iso(pause.until), at: pause.since },
      ...(pause.probe ? [{ name: "probe", value: pause.probe.run, at: pause.probe.at }] : []),
    ],
    unblock: [
      { by: "flowryn", action: probing ? "lifts the pause when the probe's turn ends normally" : `lets one Claude run probe it after ${clock(pause.until)}` },
      { by: "captain", action: RESUME_COMMAND },
    ],
  };
}

export function quotaRefusal(db: Db): Refusal {
  const quota = quotaState(db);
  return {
    rule: "capacity.quota_floor",
    reason: quota ? `the Claude quota is ${quota.percent}%, under the ${quota.floor}% floor` : "the Claude quota is under its floor",
    facts: quota
      ? [
          { name: "quota remaining", value: `${quota.percent}%${quota.window ? ` (${quota.window})` : ""}`, at: quota.since },
          { name: "floor", value: `${quota.floor}%`, at: quota.since },
          ...(quota.resets_at ? [{ name: "window resets", value: quota.resets_at, at: quota.since }] : []),
        ]
      : [],
    unblock: [
      { by: "flowryn", action: "starts it once a quota reading is at or over the floor" },
      { by: "captain", action: RESUME_COMMAND },
    ],
  };
}

export function harnessRefusalOf(check: Exclude<HarnessCheck, { state: "verified" }>, attempt: AutoAttempt | null, now: number): Refusal {
  const auto = attempt && check.state === "unverified" ? `an automatic contract check of ${check.harness} ${check.version} is ${attempt.state === "running" ? "running" : `queued (${attempt.wait ?? "waiting"})`}; it launches once that passes` : null;
  return {
    rule: "capacity.harness_unverified",
    reason: check.state === "missing" ? `the harness cannot launch: ${check.detail}` : harnessWaitReason(check),
    facts: harnessFacts(check, now),
    unblock: harnessUnblock(check, "launches it", auto),
  };
}

export function hostRefusal(host: HostState | null, cfg: HostCheckConfig, reason: string, now: number): Refusal {
  const since = host?.since ?? now;
  return {
    rule: "capacity.host_check",
    reason: `the host check fails: ${host?.reason ?? reason}`,
    facts: [
      { name: "host check", value: host?.reason ?? reason, at: since },
      ...(host?.free_mem_gb != null ? [{ name: "free memory", value: `${host.free_mem_gb} GB (needs ${cfg.min_free_mem_gb})`, at: since }] : []),
      ...(host?.load_per_core != null ? [{ name: "load per core", value: `${host.load_per_core} (under ${cfg.max_load_per_core})`, at: since }] : []),
    ],
    unblock: [{ by: "flowryn", action: `grants once the host check passes (${cfg.min_free_mem_gb} GB free, load per core under ${cfg.max_load_per_core})` }],
  };
}

export function poolsRefusal(db: Db, caps: Record<string, number>, full: readonly string[], now: number): Refusal {
  const counts = liveCounts(db);
  const facts = full.map((pool) => {
    // Runs by task id, and heavy work that is not a run (a flowryn verify) by its job id: the same leases liveCounts counts.
    const holders = (
      db
        .query(
          `SELECT holder FROM (
             SELECT DISTINCT r.task_id AS holder FROM pool_leases l JOIN runs r ON r.id = l.run_id WHERE l.pool = ?1 AND l.released_at IS NULL
             UNION SELECT kind || ' ' || job_id FROM job_leases WHERE pool = ?1 AND released_at IS NULL)
           ORDER BY holder`,
        )
        .all(pool) as { holder: string }[]
    ).map((h) => h.holder);
    return { name: `pool ${pool}`, value: `${counts[pool] ?? 0}/${caps[pool] ?? 0} held by ${holders.join(", ") || "-"}`, at: now };
  });
  return {
    rule: "capacity.pools_full",
    reason: `no free slot in ${full.join(", ")}`,
    facts,
    unblock: [
      { by: "flowryn", action: `grants when a slot in ${full.join(", ")} frees (a holder's stage, run or job ends)` },
      { by: "captain", action: `raise [capacity] ${full[0]} in config.toml` },
    ],
  };
}
