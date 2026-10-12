import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import type { ReportStamp } from "./grant.ts";
import { LEGACY_REVISION, storedRevision } from "./revision.ts";
import type { ContractResult } from "./runner.ts";

/**
 * Write a contract run's result to `<data_dir>/contracts/` and return the
 * path. The stamp says whether the run may record (`mode`), which build ran
 * it and who asked; a verify-only run's file name says so too. `extra.model`
 * marks a real-model Pi pass's report (always verify-only).
 */
export function dataDirReport(config: FlowrynConfig, result: ContractResult, stamp: ReportStamp, extra: { model?: string } = {}): string {
  const dir = join(config.data_dir, "contracts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const when = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = stamp.mode === "verify-only" ? "-verify-only" : "";
  const path = join(dir, `${result.harness}-${result.version}-${when}${suffix}.json`);
  writeFileSync(path, JSON.stringify({ ...result, ...stamp, ...extra }, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/** What a pass records from its report besides who recorded it (docs/notes/2026-10-12-next-steps-md-ez.md). */
export interface ReportFacts {
  revision: number;
  platform: string | null;
  herdr_version: string | null;
  launch_profile: string | null;
}

const NO_FACTS: ReportFacts = { revision: LEGACY_REVISION, platform: null, herdr_version: null, launch_profile: null };

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * The revision and context a report says its run proved, for this harness and
 * version. Read for the record only, never as authority (reportProblem checks
 * the leader's and the daemon's reports): no report, an unreadable one, one
 * for another harness or version, or one written before revisions gives a
 * legacy revision and no context.
 */
export function reportFacts(report: string | null, harness: string, version: string): ReportFacts {
  if (!report) return NO_FACTS;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  } catch {
    return NO_FACTS;
  }
  if (typeof parsed !== "object" || parsed === null || parsed.harness !== harness || parsed.version !== version) return NO_FACTS;
  const context = typeof parsed.context === "object" && parsed.context !== null ? (parsed.context as Record<string, unknown>) : {};
  return {
    revision: storedRevision(parsed.revision),
    platform: textOrNull(context.platform),
    herdr_version: textOrNull(context.herdr),
    launch_profile: textOrNull(context.launch_profile),
  };
}
