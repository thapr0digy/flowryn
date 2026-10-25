import { openItem, resolveItems } from "../attention/items.ts";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type Args, type Caller, type DaemonInfo, type VerbSpec } from "../api/verbs.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { policyMode } from "../config/policy.ts";
import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { harnessItemKey, noteContractPassed } from "../lifecycle/harness-gate.ts";
import { checkLeaderReport, leaderRecordLine, recordGrant } from "./grant.ts";
import { reportFacts, type ReportFacts } from "./report.ts";
import { contractRevision } from "./revision.ts";

/** A pass: the harness version, the contract revision it proved and the context it ran on (ReportFacts), and who recorded it. */
export interface PassRecord extends ReportFacts {
  harness: HarnessId;
  version: string;
  report: string | null;
  /** Who recorded it: "human", "leader", or "daemon" for its automatic check. */
  by: string;
  build: string | null;
  session: string | null;
  source: EventSource;
}

/**
 * Write a passing harness version at its contract revision: the record, its
 * `contract.passed` event, and the settled P1 about it. The verb and the daemon's automatic check
 * (src/contracts/auto.ts) both record through here. Call inside a
 * transaction; returns the event's seq.
 */
export function recordPass(db: Db, pass: PassRecord, now: number): number {
  db.query(
    `INSERT INTO harness_contracts (harness, version, revision, passed_at, report_path, platform, herdr_version, launch_profile) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(harness, version, revision) DO UPDATE SET passed_at = excluded.passed_at, report_path = excluded.report_path,
       platform = excluded.platform, herdr_version = excluded.herdr_version, launch_profile = excluded.launch_profile`,
  ).run(pass.harness, pass.version, pass.revision, now, pass.report, pass.platform, pass.herdr_version, pass.launch_profile);
  const event = appendEvent(db, {
    source: pass.source,
    kind: "contract.passed",
    payload: {
      harness: pass.harness,
      version: pass.version,
      revision: pass.revision,
      report: pass.report,
      by: pass.by,
      build: pass.build,
      session: pass.session,
      platform: pass.platform,
      herdr_version: pass.herdr_version,
      launch_profile: pass.launch_profile,
    },
    ts: now,
  });
  noteContractPassed(db, pass.harness, pass.version, pass.revision, now);
  // A newer record supersedes the harness's earlier contract_recorded item: one stays open per harness.
  resolveItems(db, "contract_recorded", harnessItemKey(pass.harness), `superseded by ${pass.harness} ${pass.version}`, now);
  return event.seq;
}

/** Open the contract_recorded item for a record, keyed by its harness so the next record supersedes it (recordPass). Call inside the record's transaction. */
export function openContractRecorded(db: Db, harness: HarnessId, eventSeq: number, line: string, now: number): string {
  return openItem(db, { kind: "contract_recorded", eventSeq, taskId: harnessItemKey(harness), line, now });
}

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
 * item so you see it. The revision recorded is the one the run's report
 * proved (a leader's must be the daemon's own); your own terminal's record at
 * another revision is kept but does not verify, and the reply says so
 * (`current: false`).
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
  scope: { kind: "none" },
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
    const required = contractRevision(harness as HarnessId);
    if (byLeader) checkLeaderReport(ctx.config().data_dir, report, { harness, version, build: info.build!, revision: required });
    const facts = reportFacts(report, harness, version);
    const now = ctx.now();
    const seq = recordPass(ctx.db, { harness: harness as HarnessId, version, report, by: ctx.caller.role, build, session: ctx.caller.session ?? null, source: "cli", ...facts }, now);
    if (byLeader) openContractRecorded(ctx.db, harness as HarnessId, seq, leaderRecordLine(harness, version, build), now);
    return { data: { harness, version, revision: facts.revision, current: facts.revision === required, required_revision: required, recorded: true, by: ctx.caller.role } };
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
  scope: { kind: "none" },
  read(ctx, args) {
    if (!ctx.info) throw new FlowrynError("daemon_unavailable", "the daemon is down, so nothing can be recorded", "flowryn daemon status");
    grantFor(ctx.caller, ctx.config, ctx.info, args);
    return { data: { may_record: true, by: ctx.caller.role } };
  },
};

export const CONTRACT_VERBS: VerbSpec[] = [recordContract, mayRecordContract];
