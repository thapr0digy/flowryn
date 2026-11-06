import { describe, expect, test } from "bun:test";
import { accountsConfig } from "../../src/config/accounts.ts";
import { parseConfig } from "../../src/config/config.ts";
import { NO_PINS, resolveModelChoice, type ModelPins } from "../../src/config/model-choice.ts";
import { DEFAULT_WORKFLOWS, freezeWorkflow, projectReviewModel, workflowConfigProblems, workflowsConfig, type StageDef } from "../../src/config/workflows.ts";
import { stageChoiceChanges } from "../../src/lifecycle/stages.ts";
import { verifyConfig } from "../../src/verify/config.ts";

/**
 * A stage's own effort and a review stage's model (docs/notes/2026-11-06-effort-and-model-gn.md):
 * the stage's effort sits under the task's own and over the workflow's; a review stage runs on the
 * project's review_model on Claude, and a Pi worker's model is never set by it.
 */

const HOME = "/tmp/fw-stage-effort";

function config(text: string) {
  return parseConfig(`[tools]\nclaude = "/bin/true"\npi = "/bin/true"\n${text}`, HOME);
}

const TIERED = `
[projects.web]
review_model = "sonnet"

[workflows.tiered]
stages = [
  { id = "design", gate = "review", effort = "high" },
  { id = "build", effort = "low" },
  { id = "review", review = true },
  { id = "ship", gate = "merge" },
]

[workflows.tiered.claude]
model = "opus"
effort = "medium"
`;

function stageOf(text: string, id: string): StageDef {
  return workflowsConfig(config(text)).tiered!.stages.find((s) => s.id === id)!;
}

function choose(text: string, stageId: string, opts: { pins?: ModelPins; account?: string } = {}) {
  const c = config(text);
  const account = accountsConfig(c).accounts[opts.account ?? "claude"]!;
  const workflow = freezeWorkflow(workflowsConfig(c).tiered!, projectReviewModel(c, "web"));
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  return resolveModelChoice(c, { pins: opts.pins ?? NO_PINS, workflow, account, stage });
}

describe("config: a stage's effort and review flag", () => {
  test("a stage takes effort low, medium, high or xhigh, and review = true", () => {
    expect(stageOf(TIERED, "design")).toMatchObject({ id: "design", effort: "high" });
    expect(stageOf(TIERED, "review")).toMatchObject({ id: "review", review: true });
    expect(projectReviewModel(config(TIERED), "web")).toBe("sonnet");
  });

  test("a stage without them reads as it always did: no effort or review key", () => {
    const ship = stageOf(TIERED, "ship");
    expect("effort" in ship).toBe(false);
    expect("review" in ship).toBe(false);
    expect(workflowsConfig(config("")).feature).toEqual(DEFAULT_WORKFLOWS.feature!);
  });

  test("a stage never runs at max, and an unknown level or a non-boolean review refuses", () => {
    const stages = (stage: string) => `[workflows.x]\nstages = [${stage}, { id = "ship", gate = "merge" }]`;
    expect(() => workflowsConfig(config(stages('{ id = "build", effort = "max" }')))).toThrow(/never runs at max/);
    expect(() => workflowsConfig(config(stages('{ id = "build", effort = "minimal" }')))).toThrow(/effort must be one of low, medium, high, xhigh/);
    expect(() => workflowsConfig(config(stages('{ id = "build", effort = 3 }')))).toThrow(/effort must be one of/);
    expect(() => workflowsConfig(config(stages('{ id = "build", review = "yes" }')))).toThrow(/review must be true or false/);
  });

  test("a project's review_model must be a model name, and is a known project key", () => {
    expect(() => projectReviewModel(config('[projects.web]\nreview_model = "sonnet; rm -rf"'), "web")).toThrow(/is not a model name/);
    expect(() => projectReviewModel(config("[projects.web]\nreview_model = 7"), "web")).toThrow(/review_model must be a model name/);
    expect(workflowConfigProblems(config('[projects.web]\nreview_model = ""'))).toEqual([expect.stringContaining("review_model must be a model name")]);
    expect(projectReviewModel(config("[projects.web]\nmax_workers = 2"), "web")).toBeNull();
    // verify's own key check knows the key, so a project with it still loads its verify steps.
    expect(verifyConfig(config('[projects.web]\nreview_model = "sonnet"\nverify = ["bun test"]'), "web")?.steps).toEqual(["bun test"]);
  });
});

describe("lookup: the stage's effort and the review model", () => {
  test("the stage's effort beats the workflow's; a stage without one takes the workflow's", () => {
    expect(choose(TIERED, "design")).toEqual({ model: "opus", effort: "high", model_source: "workflow tiered", effort_source: "stage design" });
    expect(choose(TIERED, "build")).toMatchObject({ effort: "low", effort_source: "stage build" });
    expect(choose(TIERED, "ship")).toMatchObject({ effort: "medium", effort_source: "workflow tiered" });
  });

  test("the task's own effort wins over the stage's", () => {
    expect(choose(TIERED, "design", { pins: { model: null, effort: "xhigh" } })).toMatchObject({ effort: "xhigh", effort_source: "dispatch" });
  });

  test("a review stage runs on the project's review_model, over the builder's model and the task's own", () => {
    expect(choose(TIERED, "review")).toMatchObject({ model: "sonnet", model_source: "review_model (stage review)" });
    expect(choose(TIERED, "review", { pins: { model: "fable", effort: null } })).toMatchObject({ model: "sonnet" });
    expect(choose(TIERED, "build", { pins: { model: "fable", effort: null } })).toMatchObject({ model: "fable", model_source: "dispatch" });
  });

  test("without review_model the review stage runs on the builder's model", () => {
    const text = TIERED.replace('review_model = "sonnet"', "max_workers = 3");
    expect(choose(text, "review")).toMatchObject({ model: "opus", model_source: "workflow tiered" });
  });

  test("a Pi worker's model is left unset at a review stage: review_model is Claude's only", () => {
    const pi = choose(TIERED, "review", { account: "pi" });
    expect(pi.model).toBeNull();
    expect(pi.model_source).toBe("harness default");
    expect(choose(TIERED, "design", { account: "pi" })).toMatchObject({ effort: "high", effort_source: "stage design" });
  });

  test("freezing puts the review model on review stages only, and leaves a workflow without one as it was", () => {
    const wf = workflowsConfig(config(TIERED)).tiered!;
    const frozen = freezeWorkflow(wf, "sonnet");
    expect(frozen.stages.map((s) => s.review_model ?? null)).toEqual([null, null, "sonnet", null]);
    expect(freezeWorkflow(wf, null)).toBe(wf);
    expect(freezeWorkflow(DEFAULT_WORKFLOWS.feature!, "sonnet")).toBe(DEFAULT_WORKFLOWS.feature!);
  });
});

describe("a stage start relaunches the live worker only when its model or effort changes", () => {
  const frozen = freezeWorkflow(workflowsConfig(config(TIERED)).tiered!, "sonnet");
  const at = (id: string) => frozen.stages.find((s) => s.id === id)!;
  const run = (over: Partial<{ harness: "claude" | "pi"; model: string | null; effort: string | null; model_pin: string | null; effort_pin: string | null }> = {}) => ({
    harness: "claude" as const,
    model: "opus",
    effort: "high",
    model_pin: null,
    effort_pin: null,
    ...over,
  });

  test("design (high) to build (low) changes; to a stage asking what the worker already runs does not", () => {
    expect(stageChoiceChanges(run(), at("design"), at("build"))).toBe(true);
    expect(stageChoiceChanges(run({ effort: "low" }), at("design"), at("build"))).toBe(false);
  });

  test("a stage that sets nothing after one that did counts as a change, so the launch looks the defaults up again", () => {
    expect(stageChoiceChanges(run({ effort: "low" }), at("build"), at("ship"))).toBe(true);
    expect(stageChoiceChanges(run(), at("ship"), at("ship"))).toBe(false);
  });

  test("the task's own effort is never overridden, so a stage effort alone never relaunches it", () => {
    expect(stageChoiceChanges(run({ effort: "medium", effort_pin: "medium" }), at("design"), at("build"))).toBe(false);
  });

  test("a review stage's model relaunches a Claude worker on another model, never a Pi one", () => {
    expect(stageChoiceChanges(run({ effort: "medium" }), at("ship"), at("review"))).toBe(true);
    expect(stageChoiceChanges(run({ effort: "medium", model: "sonnet" }), at("ship"), at("review"))).toBe(false);
    expect(stageChoiceChanges(run({ harness: "pi", model: null, effort: "medium" }), at("ship"), at("review"))).toBe(false);
  });

  test("a workflow frozen before stage effort existed (no keys) never relaunches", () => {
    const old = DEFAULT_WORKFLOWS.feature!.stages;
    expect(stageChoiceChanges(run(), old[0]!, old[1]!)).toBe(false);
  });
});
