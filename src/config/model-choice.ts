import { FlowrynError } from "../api/errors.ts";
import type { HarnessId } from "../harness/types.ts";
import type { Account } from "./accounts.ts";
import { table, type FlowrynConfig } from "./config.ts";
import type { WorkflowDef } from "./workflows.ts";

/**
 * A worker's model and effort (docs/notes/2026-10-24-model-and-effort-sc.md).
 * Each is looked up on its own, first set wins: the task's own choice
 * (`dispatch --model/--effort`, a plan phase's lines), the workflow's default
 * for the harness (`[workflows.<id>.<harness>]`), the account's
 * (`[accounts.<id>]`), the harness's (`[workers.<harness>]`). Plain lookups:
 * the launcher resolves at every launch, so a resume keeps the task's choice
 * and follows later config edits for the rest, as an account's model always did.
 */

/** The values each harness's own CLI takes (claude --help 2.1.x: --effort; pi --help 0.87.1: --thinking). */
export const EFFORT_LEVELS: Record<HarnessId, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/** Every effort level some harness takes, for shell completion of --effort. */
export const EFFORT_CHOICES: readonly string[] = [...new Set(Object.values(EFFORT_LEVELS).flat())];

/**
 * A model name as it is typed into the worker's pane: an alias, a full id, a
 * `[1m]` suffix, Pi's `<provider>/<id>` and its `:<thinking>` suffix. Nothing
 * a shell would read as more than one word.
 */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export interface ModelPins {
  model: string | null;
  effort: string | null;
}

export interface ModelChoice {
  model: string | null;
  effort: string | null;
  /** Where each came from: dispatch, workflow <id>, account <id>, [workers.<harness>], or harness default. */
  model_source: string;
  effort_source: string;
}

export const NO_PINS: ModelPins = { model: null, effort: null };

export function checkModelName(model: string, where: string, code: "bad_args" | "config_invalid" = "bad_args"): string {
  if (!MODEL.test(model)) throw new FlowrynError(code, `${where}: ${JSON.stringify(model)} is not a model name (letters, digits and . _ : / @ [ ] -, at most 128)`);
  return model;
}

export function checkEffort(effort: string, harness: HarnessId, where: string, code: "bad_args" | "config_invalid" = "bad_args"): string {
  if (!EFFORT_LEVELS[harness].includes(effort)) throw new FlowrynError(code, `${where}: ${harness} effort must be one of ${EFFORT_LEVELS[harness].join(", ")}`);
  return effort;
}

/** A declared Pi account spends one provider, so a model under another provider cannot run on it. */
export function modelFits(model: string, account: Account): boolean {
  return account.harness !== "pi" || account.provider === null || model.startsWith(`${account.provider}/`);
}

/** Refuse a task's own choice that cannot run on the account: a bad name, an effort the harness lacks, a Pi model of another provider. */
export function checkPins(pins: ModelPins, account: Account, where = "dispatch"): void {
  if (pins.model !== null) {
    checkModelName(pins.model, `${where} model`);
    if (!modelFits(pins.model, account)) {
      throw new FlowrynError("bad_args", `${where} model ${pins.model} is not a ${account.provider} model, and account ${account.id} spends ${account.provider}`, `use ${account.provider}/<model id>, or another account`);
    }
  }
  if (pins.effort !== null) checkEffort(pins.effort, account.harness, `${where} effort`);
}

function flagValue(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new FlowrynError("bad_args", `--${name} needs a value`);
  return value.trim();
}

/** The task's own choice from --model and --effort: absent is null, empty refuses. */
export function pinsOf(model: unknown, effort: unknown): ModelPins {
  return { model: flagValue(model, "model"), effort: flagValue(effort, "effort") };
}

/** Each pin of `over` that is set wins over `under`'s. */
export function overPins(over: ModelPins, under: ModelPins): ModelPins {
  return { model: over.model ?? under.model, effort: over.effort ?? under.effort };
}

/** Whether `[accounts.<id>]` sets the key itself; otherwise a declared account's value came from `[workers.<harness>]`. */
function accountSets(config: FlowrynConfig, account: Account, key: "model" | "effort"): boolean {
  if (!account.declared) return false;
  const raw = table(table(config.extra.accounts, "[accounts]")[account.id], `[accounts.${account.id}]`);
  return raw[key] !== undefined;
}

export function resolveModelChoice(config: FlowrynConfig, input: { pins: ModelPins; workflow: WorkflowDef | null; account: Account }): ModelChoice {
  const { pins, workflow, account } = input;
  const defaults = workflow?.models?.[account.harness] ?? NO_PINS;
  const below = (key: "model" | "effort"): string => {
    if (account[key] === null) return "harness default";
    return accountSets(config, account, key) ? `account ${account.id}` : `[workers.${account.harness}]`;
  };

  let model: string | null;
  let modelSource: string;
  if (pins.model !== null) [model, modelSource] = [pins.model, "dispatch"];
  else if (defaults.model !== null && modelFits(defaults.model, account)) [model, modelSource] = [defaults.model, `workflow ${workflow!.id}`];
  else {
    [model, modelSource] = [account.model, below("model")];
    // Recorded, not refused: a workflow's Pi model for another provider would make the workflow unusable on this account.
    if (defaults.model !== null) modelSource += ` (workflow ${workflow!.id}'s ${defaults.model} is not a ${account.provider} model)`;
  }

  let effort: string | null;
  let effortSource: string;
  if (pins.effort !== null) [effort, effortSource] = [pins.effort, "dispatch"];
  else if (defaults.effort !== null) [effort, effortSource] = [defaults.effort, `workflow ${workflow!.id}`];
  else [effort, effortSource] = [account.effort, below("effort")];

  return { model, effort, model_source: modelSource, effort_source: effortSource };
}

/** A pinned model the account cannot serve (its config changed since dispatch): the launch refuses rather than guess. */
export function checkPinsAtLaunch(pins: ModelPins, account: Account): void {
  if (pins.model !== null && !modelFits(pins.model, account)) {
    throw new FlowrynError("config_invalid", `the task chose model ${pins.model}, but account ${account.id} now spends ${account.provider}`, "cancel the run, or put the account's provider back");
  }
}

/** "sonnet (workflow fix)", for the task view. */
export function choiceLine(value: string | null, source: string): string {
  return value === null ? `default (${source})` : `${value} (${source})`;
}
