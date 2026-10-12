import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import type { ReportStamp } from "./grant.ts";
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
