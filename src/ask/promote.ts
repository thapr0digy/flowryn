import { FlowrynError } from "../api/errors.ts";
import { runAccount, type Account } from "../config/accounts.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { workflowFor } from "../config/workflows.ts";
import { tx, type Db } from "../db/db.ts";
import type { EventSource } from "../db/events.ts";
import { checkStart, createRun, taskTitleFrom, type StartDeps } from "../lifecycle/dispatch.ts";
import { mintTaskId } from "../lifecycle/ids.ts";
import { takenIds } from "../lifecycle/plans.ts";
import { getProject, type ProjectRow } from "../lifecycle/projects.ts";
import { getAsk, recordPromoted, type AskRow } from "./store.ts";

/**
 * An ask that needs to write becomes a scout (docs/notes/2026-10-30-ask-a-lightweight-4v.md): a
 * new scout task on the same project, account and model choice, whose body is the question and
 * why the ask could not answer it read-only. The scout starts through the scheduler like any
 * dispatch; the ask closes as promoted and names its task.
 */

/** The states an ask may be promoted from: by its runner while running, or by hand once it ended. */
export const RUNNER_PROMOTES: readonly AskRow["state"][] = ["running"];
export const HAND_PROMOTES: readonly AskRow["state"][] = ["answered", "failed"];

export function scoutBody(ask: AskRow, reason: string): string {
  return `${ask.question}\n\n(Promoted from ask ${ask.id}, which could not answer it read-only: ${reason})`;
}

export interface Promoted {
  task: string;
  run: string;
}

export interface AskPromotion {
  askId: string;
  from: readonly AskRow["state"][];
  project: ProjectRow;
  account: Account;
  version: string;
  base: string;
}

function promotable(ask: AskRow | null, askId: string, from: readonly AskRow["state"][]): AskRow {
  if (!ask) throw new FlowrynError("not_found", `no ask ${askId}`);
  if (!from.includes(ask.state)) throw new FlowrynError("bad_args", `ask ${askId} is ${ask.state}; only one that ended (answered or failed) is promoted by hand`, `flowryn show ${askId}`);
  return ask;
}

/** The checks a dispatch makes, outside the transaction; throws a FlowrynError when the scout cannot start (Herdr down, an untested harness). */
export async function prepareAskPromotion(deps: StartDeps, askId: string, from: readonly AskRow["state"][]): Promise<AskPromotion> {
  const ask = promotable(getAsk(deps.db, askId), askId, from);
  const project = getProject(deps.db, ask.project_id);
  if (!project) throw new FlowrynError("not_found", `ask ${askId}'s project ${ask.project_id} is gone`);
  const account = runAccount(deps.config(), project, ask.account, ask.harness);
  const start = await checkStart(deps, project, account);
  return { askId, from, project, account, version: start.version, base: start.base };
}

/** The scout task and run, and the ask closed as promoted. Call inside a transaction. */
export function applyAskPromotion(db: Db, config: FlowrynConfig, p: AskPromotion, opts: { reason: string; by: string; source: EventSource; costUsd?: number | null }, now: number): Promoted {
  const ask = promotable(getAsk(db, p.askId), p.askId, p.from);
  const body = scoutBody(ask, opts.reason);
  const title = taskTitleFrom(ask.title, body);
  const taskId = mintTaskId(title, takenIds(db));
  const runId = createRun(db, config, {
    taskId,
    title,
    body,
    project: p.project,
    kind: "scout",
    account: p.account,
    pins: { model: ask.model_pin, effort: ask.effort_pin },
    version: p.version,
    base: p.base,
    workflow: workflowFor(config, "scout", "scout"),
    sensitive: false,
    existing: false,
    by: opts.by,
    override: null,
    now,
  });
  recordPromoted(db, p.askId, { task: taskId, run: runId, reason: opts.reason, costUsd: opts.costUsd ?? null, by: opts.by, source: opts.source }, now);
  return { task: taskId, run: runId };
}

/** Both steps, for the runner while its ask is running: the scout starts by itself. */
export async function promoteAsk(deps: StartDeps, askId: string, opts: { reason: string; by: string; source: EventSource; costUsd?: number | null }): Promise<Promoted> {
  const prepared = await prepareAskPromotion(deps, askId, RUNNER_PROMOTES);
  return tx(deps.db, () => applyAskPromotion(deps.db, deps.config(), prepared, opts, deps.now()));
}
