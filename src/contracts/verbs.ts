import { openItem } from "../attention/items.ts";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type Args, type Caller, type DaemonInfo, type VerbSpec } from "../api/verbs.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { policyMode } from "../config/policy.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { noteContractPassed } from "../lifecycle/harness-gate.ts";
import { checkLeaderReport, leaderRecordLine, recordGrant } from "./grant.ts";

const VERSION = /^\d+\.\d+\.\d+[\w.+-]*$/;

/** The record grant for this caller, against the daemon's live config and build. */
function grantFor(caller: Caller, config: FlowrynConfig, info: DaemonInfo | undefined, args: Args): void {
  recordGrant({ role: caller.role, mode: policyMode(config), callerBuild: stringArg(args, "build") ?? null, daemonBuild: info?.build ?? null });
}

/**
 * `contracts.record`: the daemon writes the passing harness version that
 * `flowryn doctor --contracts` proved (design section 5). Internal (dotted),
 * so it is never parsed from argv; doctor calls it after a passing run. Your
 * own terminal records as it always has; the leader only as recordGrant and
 * its report check allow, and each of its records opens a contract_recorded
 * item so you see it.
 */
export const recordContract: VerbSpec = {
  name: "contracts.record",
  summary: "Record a harness version whose contract suite passed",
  positionals: [],
  flags: {
    harness: { type: "string", help: "claude or pi" },
    version: { type: "string", help: "the harness version the suite ran against" },
    report: { type: "string", help: "where the suite's report was written" },
    build: { type: "string", help: "the build id of the binary that ran the suite" },
  },
  kind: "mutation",
  roles: ["human", "leader"],
  apply(ctx, args) {
    const harness = stringArg(args, "harness") ?? "";
    const version = stringArg(args, "version") ?? "";
    if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
    if (!VERSION.test(version)) throw new FlowrynError("bad_args", "--version must look like 1.2.3");
    const info = ctx.info();
    grantFor(ctx.caller, ctx.config(), info, args);
    const report = stringArg(args, "report") ?? null;
    const build = stringArg(args, "build") ?? null;
    const byLeader = ctx.caller.role === "leader";
    if (byLeader) checkLeaderReport(ctx.config().data_dir, report, { harness, version, build: info.build! });
    const now = ctx.now();
    ctx.db
      .query(
        `INSERT INTO harness_contracts (harness, version, passed_at, report_path) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(harness, version) DO UPDATE SET passed_at = excluded.passed_at, report_path = excluded.report_path`,
      )
      .run(harness, version, now, report);
    const event = appendEvent(ctx.db, { source: "cli", kind: "contract.passed", payload: { harness, version, report, by: ctx.caller.role, build, session: ctx.caller.session ?? null } });
    if (byLeader) openItem(ctx.db, { kind: "contract_recorded", eventSeq: event.seq, line: leaderRecordLine(harness, version, build), now });
    noteContractPassed(ctx.db, harness as HarnessId, version, now);
    return { data: { harness, version, recorded: true, by: ctx.caller.role } };
  },
  async settle(ctx, result) {
    // Launches and resumes that waited for this version can go now.
    ctx.sched.kick();
    ctx.fleet.reconcile();
    return result;
  },
};

/**
 * `contracts.may_record`: the record grant alone, asked before a suite runs,
 * so a caller that cannot record learns it in a second rather than after the
 * suite. `contracts.record` checks again; that check is the one that counts.
 */
export const mayRecordContract: VerbSpec = {
  name: "contracts.may_record",
  summary: "Whether this caller and build may record a contract pass",
  positionals: [],
  flags: {
    build: { type: "string", help: "the build id of the binary that will run the suite" },
  },
  kind: "read",
  roles: ["human", "leader"],
  read(ctx, args) {
    if (!ctx.info) throw new FlowrynError("daemon_unavailable", "the daemon is down, so nothing can be recorded", "flowryn daemon status");
    grantFor(ctx.caller, ctx.config, ctx.info, args);
    return { data: { may_record: true, by: ctx.caller.role } };
  },
};

export const CONTRACT_VERBS: VerbSpec[] = [recordContract, mayRecordContract];
