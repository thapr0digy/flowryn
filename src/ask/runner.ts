import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { askConfig } from "../config/ask.ts";
import { runAccount, workersFor } from "../config/accounts.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { resolveModelChoice } from "../config/model-choice.ts";
import { workersConfig } from "../config/workers.ts";
import { tx, type Db } from "../db/db.ts";
import type { StartDeps } from "../lifecycle/dispatch.ts";
import { getProject } from "../lifecycle/projects.ts";
import { runBounded, type BoundedOptions, type BoundedResult } from "../runtime/bounded.ts";
import { scrubbedEnv } from "../runtime/child-env.ts";
import { usageGate } from "../sched/usage.ts";
import { askArgs, askContract, askEnv, capBytes, PiMeter, readClaudeResult, scoutRequest, type AskOutcome } from "./harness.ts";
import { promoteAsk } from "./promote.ts";
import { getAsk, markStarted, queuedAsks, recordAnswer, recordFailed, recoverInterrupted, runningAsks, type AskRow } from "./store.ts";

/**
 * The headless runner (docs/notes/2026-10-30-ask-a-lightweight-4v.md; design-v3's post-v1
 * "headless triage runner" shape): one print-mode model call per ask, through runBounded (its
 * own process group, a deadline, the owned ledger), with no pane, worktree or branch. The
 * scheduler's pass drains the queue; each call runs in the background and records its end.
 */

export interface AskDeps {
  db: Db;
  config(): FlowrynConfig;
  now(): number;
  log(message: string): void;
  /** For a promotion: the same start checks a dispatch makes. */
  startDeps: StartDeps;
  /** An ask ended (a slot is free, a scout may wait for its grant): look at the queues again. */
  kick(): void;
  /** `<state_dir>/asks`: one directory per ask (its contract, a cut answer's whole text). */
  root: string;
  /** The environment calls start from (default: the daemon's, scrubbed). */
  env?: Record<string, string>;
  /** Tests: the call itself (default: runBounded). */
  call?(argv: string[], opts: BoundedOptions): Promise<BoundedResult>;
}

export function askRoot(config: Pick<FlowrynConfig, "state_dir">): string {
  return join(config.state_dir, "asks");
}

/** Calls this daemon is running, by ask id: their abort, for a drop. */
const active = new Map<string, AbortController>();
const finished = new Set<Promise<void>>();
let stopping = false;

/** Asks with a call in this process. */
export function activeAsks(): string[] {
  return [...active.keys()];
}

/** A drop: end the ask's call (its row is already cancelled). */
export function abortAsk(id: string): boolean {
  const controller = active.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Daemon stop: end every call and leave its row running, so the next start queues it again. */
export async function stopAsks(): Promise<void> {
  stopping = true;
  for (const controller of active.values()) controller.abort();
  await Promise.allSettled([...finished]);
}

/** Tests: a fresh daemon in the same process. */
export function resetAskRunner(): void {
  stopping = false;
  active.clear();
  finished.clear();
}

/** Every call this process started has recorded its end (tests). */
export async function settledAsks(): Promise<void> {
  while (finished.size > 0) await Promise.allSettled([...finished]);
}

/**
 * Daemon startup: a row still running belongs to a daemon that is gone (the owned ledger ended
 * its process group). An ask changes nothing, so it is queued again once, then failed.
 */
export function recoverAsks(db: Db, now: number): { requeued: string[]; failed: string[] } {
  const out = { requeued: [] as string[], failed: [] as string[] };
  for (const ask of runningAsks(db)) {
    if (active.has(ask.id)) continue;
    const verdict = tx(db, () => recoverInterrupted(db, ask, now));
    out[verdict].push(ask.id);
  }
  return out;
}

/**
 * Start queued asks, oldest first, while fewer than [ask] max_concurrent run. An ask whose
 * account is paused for its usage limit waits, without holding up the others. Returns how many started.
 */
export function drainAsks(deps: AskDeps, stopped: () => boolean = () => false): number {
  const { db } = deps;
  const max = askConfig(deps.config()).max_concurrent;
  let started = 0;
  for (const ask of queuedAsks(db)) {
    if (stopped() || stopping) break;
    if (runningAsks(db).length >= max) break;
    if (usageGate(db, deps.now(), ask.account, null) !== "open") continue;
    if (!tx(db, () => markStarted(db, ask.id, deps.now()))) continue;
    launchAsk(deps, getAsk(db, ask.id)!);
    started++;
  }
  return started;
}

function launchAsk(deps: AskDeps, ask: AskRow): void {
  const controller = new AbortController();
  active.set(ask.id, controller);
  const done = runAsk(deps, ask, controller)
    .catch((error: unknown) => {
      deps.log(`ask ${ask.id}: ${(error as Error).message}`);
      if (!stopping) fail(deps, ask.id, `the runner failed: ${(error as Error).message}`, null);
    })
    .finally(() => {
      active.delete(ask.id);
      finished.delete(done);
      deps.kick();
    });
  finished.add(done);
}

function fail(deps: AskDeps, id: string, reason: string, costUsd: number | null, hint = `dispatch it again, or flowryn promote ${id}`): void {
  tx(deps.db, () => recordFailed(deps.db, id, { reason, costUsd, hint }, deps.now()));
}

function dollars(n: number): string {
  return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
}

/** The output Pi streams can repeat each partial message, so only this much is kept; the meter reads every chunk. */
const PI_KEPT_BYTES = 1024 * 1024;
/** Claude prints one JSON result: a few times the largest answer is plenty. */
const CLAUDE_KEPT_BYTES = 4 * 1024 * 1024;

async function runAsk(deps: AskDeps, ask: AskRow, controller: AbortController): Promise<void> {
  const config = deps.config();
  const settings = askConfig(config);
  const project = getProject(deps.db, ask.project_id);
  if (!project) return fail(deps, ask.id, `its project ${ask.project_id} is gone`, null, "dispatch it on another project");
  const account = runAccount(config, project, ask.account, ask.harness);
  const choice = resolveModelChoice(config, { pins: { model: ask.model_pin, effort: ask.effort_pin }, workflow: null, account });
  const workers = workersFor(workersConfig(config), account, choice);
  const binary = resolveTool(config, ask.harness);
  if (!binary) return fail(deps, ask.id, `${ask.harness} is not installed or not in [tools]`, null, "install it, then dispatch again");
  const dir = join(deps.root, ask.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const contractFile = join(dir, "contract.md");
  writeFileSync(contractFile, `${askContract(settings.max_answer_bytes)}\n`, { mode: 0o600 });

  const argv = askArgs({ harness: ask.harness, binary, workers, contractFile, maxUsd: ask.max_usd });
  const env = askEnv(ask.harness, workers, deps.env ?? scrubbedEnv(process.env));
  const meter = ask.harness === "pi" ? new PiMeter() : null;
  let overCap = false;
  const onStdout = meter
    ? (chunk: Uint8Array) => {
        if (meter.feed(chunk) > ask.max_usd && !overCap) {
          overCap = true;
          controller.abort();
        }
      }
    : undefined;
  const call = deps.call ?? runBounded;
  const result = await call(argv, {
    label: `ask ${ask.id}`,
    timeoutMs: settings.timeout_ms,
    cwd: project.path,
    env,
    stdin: ask.question,
    signal: controller.signal,
    maxOutputBytes: meter ? PI_KEPT_BYTES : CLAUDE_KEPT_BYTES,
    ...(onStdout ? { onStdout } : {}),
  });
  // A daemon stop leaves the row running for the next start; a drop already cancelled it.
  if (stopping || getAsk(deps.db, ask.id)?.state !== "running") return;
  const outcome: AskOutcome = meter ? meter.outcome() : readClaudeResult(result.stdout);
  if (overCap) return fail(deps, ask.id, `it spent ${dollars(meter!.costUsd)}, over its ${dollars(ask.max_usd)} cap`, meter!.costUsd, `dispatch it again with a higher --max-usd, or as a scout`);
  if (result.timedOut) return fail(deps, ask.id, `no answer within ${Math.round(settings.timeout_ms / 60_000)} min`, outcome.costUsd, "dispatch it again narrower, or as a scout");
  if (result.spawnError !== null) return fail(deps, ask.id, `${ask.harness} did not start: ${result.spawnError}`, null);
  if (outcome.kind === "over_cap") return fail(deps, ask.id, `it reached its ${dollars(ask.max_usd)} cap (${outcome.detail})`, outcome.costUsd, "dispatch it again with a higher --max-usd, or as a scout");
  if (outcome.kind === "error") return fail(deps, ask.id, `${outcome.detail}${result.code !== 0 ? ` (exit ${result.code})` : ""}`, outcome.costUsd);
  const reason = scoutRequest(outcome.text);
  if (reason !== null && ask.no_promote === 0) return promote(deps, ask, reason, outcome.costUsd);
  const kept = capBytes(outcome.text.trim(), settings.max_answer_bytes);
  let path: string | null = null;
  if (kept.cut) {
    path = join(dir, "answer.md");
    writeFileSync(path, outcome.text, { mode: 0o600 });
  }
  const text = kept.cut ? `${kept.text}\n\n[cut at ${settings.max_answer_bytes} bytes; the whole answer is in ${path}]` : kept.text;
  tx(deps.db, () => recordAnswer(deps.db, ask.id, { text, path, costUsd: outcome.costUsd }, deps.now()));
}

async function promote(deps: AskDeps, ask: AskRow, reason: string, costUsd: number | null): Promise<void> {
  try {
    const promoted = await promoteAsk(deps.startDeps, ask.id, { reason, by: "ask", source: "daemon", costUsd });
    deps.log(`ask ${ask.id}: promoted to scout ${promoted.task}`);
  } catch (error) {
    const why = error instanceof FlowrynError ? error.message : (error as Error).message;
    fail(deps, ask.id, `it needs a scout (${reason}), which could not start: ${why}`, costUsd, `flowryn promote ${ask.id} once that is fixed`);
  }
}
