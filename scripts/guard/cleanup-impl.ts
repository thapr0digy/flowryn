#!/usr/bin/env bun
/**
 * Flowryn's cleanup procedure in the second fixture set's contract
 * (fixtures/cleanup-order/README.md): `cleanup-impl.ts <scenario-dir>` runs
 * the whole cleanup the daemon runs (verdict, index.lock, the parked
 * no-mistakes run, the process reap, the worktree removal) against the
 * scenario, with whatever git, lsof, ps and no-mistakes are first on PATH
 * (the case's fakes), and prints one JSON outcome.
 *
 *   fixtures/cleanup-order/run.sh --impl "bun $PWD/scripts/guard/cleanup-impl.ts"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLEANUP, type CleanupConfig } from "../../src/config/delivery.ts";
import { runCleanup } from "../../src/policy/cleanup.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { psRunnerAt } from "../../src/runtime/proc.ts";

interface Scenario {
  delivery_mode: "no-mistakes" | "direct-PR" | "local-only";
  task_branch: string;
  default_branch: string;
  paths: { worktree: string; primary: string };
  inputs: { kind: "ship" | "scout"; recorded_pr_url: string | null; discard_approval: { action?: string; channel?: string } | null };
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: cleanup-impl.ts <scenario-dir>");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(process.env.FLOWRYN_SCENARIO ?? join(dir, "scenario.json"), "utf8")) as Scenario;
const tuning = JSON.parse(readFileSync(process.env.FLOWRYN_TUNING ?? join(dir, "tuning.json"), "utf8")) as Partial<CleanupConfig>;
const config: CleanupConfig = { ...DEFAULT_CLEANUP, ...tuning };
const approval = scenario.inputs.discard_approval;
const steps: string[] = [];

const outcome = await runCleanup(
  {
    guard: {
      mode: scenario.delivery_mode,
      kind: scenario.inputs.kind,
      worktree: scenario.paths.worktree,
      branch: scenario.task_branch,
      defaultBranch: scenario.default_branch,
      repo: null,
      recordedPrUrl: scenario.inputs.recorded_pr_url,
      discardApproved: approval?.action === "discard" && approval.channel === "human",
    },
    primary: scenario.paths.primary,
  },
  {
    git: gitRunner(Bun.which("git") ?? "git"),
    forge: null,
    webUrl: "https://github.com",
    lsof: Bun.which("lsof"),
    noMistakes: Bun.which("no-mistakes"),
    ps: psRunnerAt(Bun.which("ps") ?? "/bin/ps"),
    config,
    log: (line) => {
      steps.push(line);
      console.error(`cleanup: ${line}`);
    },
  },
);
console.log(
  JSON.stringify({
    outcome: outcome.outcome,
    reason_class: outcome.reason,
    detail: outcome.detail,
    lock: outcome.lock,
    aborted: outcome.aborted,
    reaped: outcome.reaped,
    branch_deleted: outcome.branchDeleted,
    steps: outcome.steps,
  }),
);
