import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import type { ContractResult } from "./runner.ts";

/** Write a contract run's result to `<data_dir>/contracts/` and return the path. */
export function dataDirReport(config: FlowrynConfig, result: ContractResult): string {
  const dir = join(config.data_dir, "contracts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${result.harness}-${result.version}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  return path;
}
