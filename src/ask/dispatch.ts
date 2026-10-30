import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type HandlerResult } from "../api/verbs.ts";
import type { Account } from "../config/accounts.ts";
import { askConfig, checkUsd } from "../config/ask.ts";
import type { ModelPins } from "../config/model-choice.ts";
import { gateHarness, harnessRefusal } from "../lifecycle/harness-gate.ts";
import { accountFor, pinsFor, startDepsOf, taskTitleFrom } from "../lifecycle/dispatch.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { getAsk, insertAsk } from "./store.ts";

/**
 * `flowryn dispatch <project> --kind ask --body-file -`: queue a question for a headless,
 * read-only model call (docs/notes/2026-10-30-ask-a-lightweight-4v.md). No backlog task, run,
 * pane, worktree or branch; the answer lands as an answer_ready item.
 */

/** The flags that shape a task, which an ask has none of. */
const TASK_ONLY_FLAGS = ["task", "after", "blocked-by", "auto", "base", "workflow", "mode", "mode-reason", "sensitive"] as const;
/** The longest question an ask takes: it goes on the model call's stdin whole. */
const MAX_QUESTION = 32_000;

export interface AskPlan {
  mode: "ask";
  project: ProjectRow;
  account: Account;
  pins: ModelPins;
  maxUsd: number;
}

export async function prepareAsk(ctx: HandlerCtx, args: Record<string, unknown>, project: ProjectRow): Promise<AskPlan> {
  const given = TASK_ONLY_FLAGS.filter((flag) => args[flag] !== undefined && args[flag] !== false && !(Array.isArray(args[flag]) && (args[flag] as unknown[]).length === 0));
  if (given.length > 0) throw new FlowrynError("bad_args", `an ask takes no ${given.map((f) => `--${f}`).join(", ")}: it is one question with no task, worktree or branch`, "dispatch it as a scout or ship instead");
  const config = ctx.config();
  const account = accountFor(config, project, args);
  const pins = pinsFor(args, account);
  const rawUsd = stringArg(args as never, "max-usd");
  const maxUsd = rawUsd === undefined ? askConfig(config).max_usd : checkUsd(Number(rawUsd), "--max-usd");
  // The same harness gate as a worker: the contract suite proves the ask's print-mode call too.
  const deps = startDepsOf(ctx);
  const check = await gateHarness(ctx.db, config, account.harness, deps.harnessVersion, "cli", "dispatch", ctx.now);
  if (check.state !== "verified") throw harnessRefusal(check, ctx.db, config);
  return { mode: "ask", project, account, pins, maxUsd };
}

export function applyAsk(ctx: HandlerCtx, args: Record<string, unknown>, plan: AskPlan): HandlerResult {
  const question = sanitizeBlock(stringArg(args as never, "body") ?? "").trim();
  if (question.length === 0) throw new FlowrynError("bad_args", "the ask needs a question", "pass --body-file - with the question on stdin");
  if (question.length > MAX_QUESTION) throw new FlowrynError("bad_args", `the question is over ${MAX_QUESTION} characters; dispatch it as a scout`);
  const title = taskTitleFrom(stringArg(args as never, "title"), question);
  const ask = insertAsk(ctx.db, {
    projectId: plan.project.id,
    title,
    question,
    harness: plan.account.harness,
    account: plan.account.id,
    model: plan.pins.model,
    effort: plan.pins.effort,
    maxUsd: plan.maxUsd,
    noPromote: boolArg(args as never, "no-promote"),
    by: ctx.caller.role,
    now: ctx.now(),
  });
  return {
    data: { ask: ask.id, project: plan.project.id, harness: plan.account.harness, account: plan.account.id, max_usd: plan.maxUsd, promote: ask.no_promote ? "off" : "on", state: "queued" },
    hints: [`flowryn show ${ask.id}`],
  };
}

/** After the scheduler's pass: whether the call started. */
export function withAskState(ctx: HandlerCtx, result: HandlerResult): HandlerResult {
  const id = typeof result.data.ask === "string" ? result.data.ask : null;
  const ask = id ? getAsk(ctx.db, id) : null;
  return ask ? { ...result, data: { ...result.data, state: ask.state } } : result;
}
