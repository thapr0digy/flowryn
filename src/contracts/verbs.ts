import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { noteContractPassed } from "../lifecycle/harness-gate.ts";

const VERSION = /^\d+\.\d+\.\d+[\w.+-]*$/;

/**
 * `contracts.record`: the daemon writes the passing harness version that
 * `flowryn doctor --contracts` proved (design section 5). Internal (dotted),
 * so it is never parsed from argv; doctor calls it from your own terminal.
 */
export const recordContract: VerbSpec = {
  name: "contracts.record",
  summary: "Record a harness version whose contract suite passed",
  positionals: [],
  flags: {
    harness: { type: "string", help: "claude or pi" },
    version: { type: "string", help: "the harness version the suite ran against" },
    report: { type: "string", help: "where the suite's report was written" },
  },
  kind: "mutation",
  roles: ["human", "leader"],
  apply(ctx, args) {
    const harness = stringArg(args, "harness") ?? "";
    const version = stringArg(args, "version") ?? "";
    if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
    if (!VERSION.test(version)) throw new FlowrynError("bad_args", "--version must look like 1.2.3");
    const now = ctx.now();
    ctx.db
      .query(
        `INSERT INTO harness_contracts (harness, version, passed_at, report_path) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(harness, version) DO UPDATE SET passed_at = excluded.passed_at, report_path = excluded.report_path`,
      )
      .run(harness, version, now, stringArg(args, "report") ?? null);
    appendEvent(ctx.db, { source: "cli", kind: "contract.passed", payload: { harness, version, report: stringArg(args, "report") ?? null, by: ctx.caller.role } });
    noteContractPassed(ctx.db, harness as HarnessId, version, now);
    return { data: { harness, version, recorded: true } };
  },
  async settle(ctx, result) {
    // Launches and resumes that waited for this version can go now.
    ctx.sched.kick();
    ctx.fleet.reconcile();
    return result;
  },
};

export const CONTRACT_VERBS: VerbSpec[] = [recordContract];
