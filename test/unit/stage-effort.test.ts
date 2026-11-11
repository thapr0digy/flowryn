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

function stages(stage: string): string {
  return `[workflows.x]\nstages = [${stage}, { id = "ship", gate = "merge" }]`;
}

type RunChoice = { harness: "claude" | "pi"; model: string | null; effort: string | null; model_pin: string | null; effort_pin: string | null };

function run(over: Partial<RunChoice> = {}): RunChoice {
  return { harness: "claude", model: "opus", effort: "high", model_pin: null, effort_pin: null, ...over };
}

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

/**
 * A stage's own Claude model (the user's 2026-11-10 ask: Opus on the design stage, Sonnet on the build stage):
 * under the task's own and a review stage's review_model, over the workflow's; frozen with the run; Pi ignores it.
 */
const SPLIT = `
[projects.web]
review_model = "claude-haiku-5-5"

[workflows.tiered]
stages = [
  { id = "design", gate = "review", effort = "high", model = "claude-opus-5-5" },
  { id = "build", effort = "medium", model = "claude-sonnet-5-5" },
  { id = "review", review = true, model = "claude-opus-5-5" },
  { id = "ship", gate = "merge" },
]

[workflows.tiered.claude]
model = "opus"
`;

describe("config: a stage's model", () => {
  test("a stage takes a model name; a stage without one has no model key", () => {
    expect(stageOf(SPLIT, "design")).toMatchObject({ id: "design", effort: "high", model: "claude-opus-5-5" });
    expect(stageOf(SPLIT, "build")).toMatchObject({ model: "claude-sonnet-5-5" });
    expect("model" in stageOf(SPLIT, "ship")).toBe(false);
  });

  test("an empty, non-string or malformed stage model refuses with config_invalid", () => {
    for (const bad of ['model = ""', "model = 5", 'model = "sonnet; rm -rf ~"', 'model = "two words"', 'model = "-sonnet"']) {
      let code: string | undefined;
      try {
        workflowsConfig(config(stages(`{ id = "build", ${bad} }`)));
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("config_invalid");
    }
    expect(() => workflowsConfig(config(stages('{ id = "build", model = "a b" }')))).toThrow(/is not a model name/);
    expect(() => workflowsConfig(config(stages('{ id = "build", model = "" }')))).toThrow(/model must be a model name/);
  });

  test("freezing keeps each stage's model with the run's workflow, through its JSON form", () => {
    const frozen = freezeWorkflow(workflowsConfig(config(SPLIT)).tiered!, "claude-haiku-5-5");
    const stored = JSON.parse(JSON.stringify(frozen)) as typeof frozen;
    expect(stored.stages.map((s) => s.model ?? null)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5", null]);
  });
});

describe("lookup: the stage's model", () => {
  test("the stage's model beats the workflow's; a stage without one takes the workflow's", () => {
    expect(choose(SPLIT, "design")).toEqual({ model: "claude-opus-5-5", effort: "high", model_source: "stage design", effort_source: "stage design" });
    expect(choose(SPLIT, "build")).toMatchObject({ model: "claude-sonnet-5-5", model_source: "stage build", effort: "medium" });
    expect(choose(SPLIT, "ship")).toMatchObject({ model: "opus", model_source: "workflow tiered" });
  });

  test("the task's own model beats the stage's", () => {
    expect(choose(SPLIT, "build", { pins: { model: "fable", effort: null } })).toMatchObject({ model: "fable", model_source: "dispatch" });
  });

  test("a review stage's review_model beats the stage's own model and the task's", () => {
    expect(choose(SPLIT, "review")).toMatchObject({ model: "claude-haiku-5-5", model_source: "review_model (stage review)" });
    expect(choose(SPLIT, "review", { pins: { model: "fable", effort: null } })).toMatchObject({ model: "claude-haiku-5-5" });
    // Without a review_model the review stage's own model applies.
    expect(choose(SPLIT.replace('review_model = "claude-haiku-5-5"', "max_workers = 3"), "review")).toMatchObject({ model: "claude-opus-5-5", model_source: "stage review" });
  });

  test("a Pi worker ignores a stage's model", () => {
    const pi = choose(SPLIT, "build", { account: "pi" });
    expect(pi.model).toBeNull();
    expect(pi.model_source).toBe("harness default");
  });
});

describe("a stage start relaunches the live worker when the stage's model changes", () => {
  const frozen = freezeWorkflow(workflowsConfig(config(SPLIT)).tiered!, null);
  const at = (id: string) => frozen.stages.find((s) => s.id === id)!;

  test("design (opus) to build (sonnet) relaunches; a worker already on the build model does not", () => {
    expect(stageChoiceChanges(run({ model: "claude-opus-5-5", effort: "medium" }), at("design"), at("build"))).toBe(true);
    expect(stageChoiceChanges(run({ model: "claude-sonnet-5-5", effort: "medium" }), at("design"), at("build"))).toBe(false);
  });

  test("a stage that sets no model after one that did counts as a change", () => {
    expect(stageChoiceChanges(run({ model: "claude-sonnet-5-5", effort: "medium" }), at("build"), { ...at("ship"), effort: "medium" })).toBe(true);
  });

  test("the task's own model is never relaunched for a stage's model", () => {
    expect(stageChoiceChanges(run({ model: "fable", model_pin: "fable", effort: "medium" }), at("design"), at("build"))).toBe(false);
  });

  test("a Pi worker is never relaunched for a stage's model", () => {
    expect(stageChoiceChanges(run({ harness: "pi", model: null, effort: "medium" }), at("design"), at("build"))).toBe(false);
  });
});
