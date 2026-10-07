import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import type { Role } from "../api/verbs.ts";
import type { PolicyMode } from "../config/policy.ts";

/**
 * Who may record a harness contract pass (design section 5; the leader's part
 * is docs/cutover-notes.md, "Approval channels · contract records from the
 * leader"). Your own terminal records as it always has. A leader records only
 * in relaxed mode, and only from the installed build: the build id of the
 * binary that ran the suite (its scratch daemon is that same binary) must be
 * the build id of the running daemon. Workers and read-only sessions never
 * record; `authorize` refuses them by role before this runs, and this refuses
 * them again so the rule reads whole in one place.
 */

export interface GrantInput {
  role: Role;
  mode: PolicyMode;
  /** The recording CLI's build id (buildIdOf(selfCommand())); null for a development command. */
  callerBuild: string | null;
  /** The running daemon's build id (DaemonInfo.build); null for a development command. */
  daemonBuild: string | null;
}

/** Throws the refusal, or returns when this caller may record. */
export function recordGrant(input: GrantInput): void {
  const { role, mode, callerBuild, daemonBuild } = input;
  if (role === "human") return;
  if (role === "worker") throw new FlowrynError("worker_token", "a worker token cannot record a contract pass", "doctor --contracts --verify-only runs the suite without recording");
  if (role !== "leader") throw new FlowrynError("human_only", "only your own terminal or the leader records a contract pass", "doctor --contracts --verify-only runs the suite without recording");
  if (mode === "strict") {
    throw new FlowrynError(
      "human_only",
      "strict policy: only your own terminal records a contract pass",
      "ask the user to run flowryn doctor --contracts in their own terminal; --verify-only runs the suite without recording",
    );
  }
  if (!daemonBuild) {
    throw new FlowrynError("not_installed_build", "the daemon runs a development command, which has no build id, so the leader cannot record", "ask the user to run flowryn doctor --contracts in their own terminal; --verify-only runs the suite without recording");
  }
  if (callerBuild !== daemonBuild) {
    throw new FlowrynError(
      "not_installed_build",
      `this binary is ${callerBuild ? `build ${callerBuild}` : "a development command"}; the daemon runs build ${daemonBuild}, and only that build may record`,
      "run the installed flowryn, or --verify-only; a newer build needs flowryn daemon restart first, on the user's word",
    );
  }
}

/** "claude 2.1.300 passed, recorded by the leader (build ab12cd34ef56)": the user's line for a leader's record. */
export function leaderRecordLine(harness: string, version: string, build: string | null): string {
  return `${harness} ${version} passed, recorded by the leader (build ${build ?? "dev"})`;
}

/** What a recording run writes to its report (src/contracts/report.ts) besides the result. */
export interface ReportStamp {
  mode: "record" | "verify-only";
  build: string | null;
  /** Who ran it, by the caller's environment: a run token is a worker, another token the leader. */
  by: "human" | "leader" | "worker";
}

function isUnder(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * A leader's record must point at the report its run wrote: in
 * `<data_dir>/contracts/`, a passing recording run of this harness, version
 * and build. Not proof against a forged file (docs/cutover-notes.md), but a
 * confused leader cannot record a failed or verify-only run by mistake.
 */
function reportRefusal(why: string): FlowrynError {
  return new FlowrynError("not_installed_build", `the leader's record needs its run's report: ${why}`, "run flowryn doctor --contracts again with the installed build");
}

export function checkLeaderReport(dataDir: string, report: string | null, expected: { harness: string; version: string; build: string }): void {
  if (!report) throw reportRefusal("no --report");
  const dir = join(dataDir, "contracts");
  if (!existsSync(report)) throw reportRefusal(`${report} does not exist`);
  if (!existsSync(dir)) throw reportRefusal(`${dir} does not exist`);
  if (!isUnder(realpathSync(report), realpathSync(dir))) throw reportRefusal(`${report} is not in ${dir}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  } catch {
    throw reportRefusal(`${report} is not a contract report`);
  }
  if (parsed.passed !== true) throw reportRefusal(`${report} is not a passing run`);
  if (parsed.mode !== "record") throw reportRefusal(`${report} is a ${String(parsed.mode ?? "unmarked")} run, not a recording one`);
  if (parsed.harness !== expected.harness || parsed.version !== expected.version) throw reportRefusal(`${report} is for ${String(parsed.harness)} ${String(parsed.version)}`);
  if (parsed.build !== expected.build) throw reportRefusal(`${report} was written by build ${String(parsed.build)}`);
}
