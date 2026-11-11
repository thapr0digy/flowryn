import { runAccount } from "../config/accounts.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { choiceLine, resolveModelChoice } from "../config/model-choice.ts";
import { currentWorkflow } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { getProject } from "./projects.ts";
import type { RunRow } from "./runs.ts";
import { runWorkflow } from "./stages.ts";

/**
 * Each stage of a run's frozen workflow with the model and effort a launch for it resolves to now
 * (docs/notes/2026-11-06-effort-and-model-gn.md): "build: sonnet (workflow fix) · low (stage build)".
 * The stage the worker runs is shown by `model` and `effort` as its launch recorded them; these lines
 * are the lookup, so a config edit since shows here first. A run whose account or workflow config no
 * longer resolves gets one line that says why, never a guess.
 */
export function stageChoiceLines(db: Db, config: FlowrynConfig, run: RunRow & { project_id: string }, kind: "ship" | "scout"): string[] {
  try {
    const project = getProject(db, run.project_id);
    if (!project) return [`unknown: project ${run.project_id} is gone`];
    const account = runAccount(config, project, run.account, run.harness);
    const workflow = currentWorkflow(config, run.workflow);
    const pins = { model: run.model_pin, effort: run.effort_pin };
    const { stages } = runWorkflow(db, run, kind);
    const lines = stages.map((stage) => {
      const choice = resolveModelChoice(config, { pins, workflow, account, stage });
      return `${stage.id}: ${choiceLine(choice.model, choice.model_source)} · ${choiceLine(choice.effort, choice.effort_source)}`;
    });
    // A stage's model is Claude's only: say so where a Pi run's workflow sets one, so the lines above are not misread.
    if (account.harness === "pi" && stages.some((s) => s.model)) lines.push("note: a stage's model applies to Claude only; this Pi run ignores it");
    return lines;
  } catch (error) {
    return [`unknown: ${(error as Error).message}`];
  }
}

/** "opus · high": what the run's worker launched with, for one fleet cell. */
export function choiceCell(run: Pick<RunRow, "model" | "effort">): string {
  return `${run.model ?? "default"} · ${run.effort ?? "default"}`;
}
