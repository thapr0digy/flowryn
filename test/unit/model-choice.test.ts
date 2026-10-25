import { describe, expect, test } from "bun:test";
import { accountsConfig } from "../../src/config/accounts.ts";
import { parseConfig } from "../../src/config/config.ts";
import { checkPins, EFFORT_LEVELS, NO_PINS, resolveModelChoice, type ModelPins } from "../../src/config/model-choice.ts";
import { DEFAULT_WORKFLOWS, workflowsConfig } from "../../src/config/workflows.ts";
import { parsePlan } from "../../src/lifecycle/plans.ts";

/**
 * A worker's model and effort (docs/notes/2026-10-24-model-and-effort-sc.md):
 * dispatch, then the workflow, then the account, then the harness, each value
 * on its own.
 */

const HOME = "/tmp/fw-model-choice";

function config(text: string) {
  return parseConfig(`[tools]\nclaude = "/bin/true"\npi = "/bin/true"\n${text}`, HOME);
}

function choose(text: string, opts: { pins?: ModelPins; workflow?: string; account?: string } = {}) {
  const c = config(text);
  const account = accountsConfig(c).accounts[opts.account ?? "claude"]!;
  return resolveModelChoice(c, { pins: opts.pins ?? NO_PINS, workflow: workflowsConfig(c)[opts.workflow ?? "fix"] ?? null, account });
}

const ALL_LEVELS = `
[workers.claude]
model = "haiku"
effort = "low"
[accounts.work]
harness = "claude"
model = "opus"
effort = "medium"
[workflows.fix.claude]
model = "sonnet"
effort = "high"
`;

describe("precedence: dispatch, then workflow, then account, then harness", () => {
  test("each level alone decides when it is the only one set", () => {
    expect(choose("")).toEqual({ model: null, effort: null, model_source: "harness default", effort_source: "harness default" });
    expect(choose('[workers.claude]\nmodel = "haiku"\neffort = "low"')).toEqual({ model: "haiku", effort: "low", model_source: "[workers.claude]", effort_source: "[workers.claude]" });
    expect(choose('[accounts.work]\nharness = "claude"\nmodel = "opus"\neffort = "max"', { account: "work" })).toEqual({ model: "opus", effort: "max", model_source: "account work", effort_source: "account work" });
    expect(choose('[workflows.fix.claude]\nmodel = "sonnet"\neffort = "high"')).toEqual({ model: "sonnet", effort: "high", model_source: "workflow fix", effort_source: "workflow fix" });
    expect(choose("", { pins: { model: "fable", effort: "xhigh" } })).toEqual({ model: "fable", effort: "xhigh", model_source: "dispatch", effort_source: "dispatch" });
  });

  test("with every level set, dispatch wins, then the workflow beats the account, which beats the harness", () => {
    expect(choose(ALL_LEVELS, { account: "work", pins: { model: "fable", effort: "max" } })).toMatchObject({ model: "fable", effort: "max" });
    expect(choose(ALL_LEVELS, { account: "work" })).toMatchObject({ model: "sonnet", effort: "high", model_source: "workflow fix" });
    expect(choose(ALL_LEVELS, { account: "work", workflow: "feature" })).toMatchObject({ model: "opus", effort: "medium", model_source: "account work" });
  });

  test("model and effort are looked up separately", () => {
    const choice = choose(ALL_LEVELS, { account: "work", pins: { model: null, effort: "max" } });
    expect(choice).toEqual({ model: "sonnet", effort: "max", model_source: "workflow fix", effort_source: "dispatch" });
    const effortOnly = choose('[workflows.fix.claude]\neffort = "high"\n[workers.claude]\nmodel = "haiku"');
    expect(effortOnly).toEqual({ model: "haiku", effort: "high", model_source: "[workers.claude]", effort_source: "workflow fix" });
  });

  test("a declared account's value inherited from [workers.<harness>] is named as the harness's", () => {
    const choice = choose('[workers.claude]\nmodel = "haiku"\n[accounts.work]\nharness = "claude"\neffort = "low"', { account: "work" });
    expect(choice).toEqual({ model: "haiku", effort: "low", model_source: "[workers.claude]", effort_source: "account work" });
  });

  test("a workflow's defaults for the other harness do not apply", () => {
    expect(choose('[workflows.fix.pi]\nmodel = "openai-codex/gpt-5-codex"\neffort = "minimal"')).toMatchObject({ model: null, effort: null });
  });
});

describe("Pi providers", () => {
  const PI = `
[accounts.chatgpt]
harness = "pi"
provider = "openai-codex"
model = "openai-codex/gpt-5-codex"
[workflows.fix.pi]
model = "anthropic/claude-sonnet"
effort = "high"
`;

  test("a workflow model for another provider is skipped, with why, and its effort still applies", () => {
    const choice = choose(PI, { account: "chatgpt" });
    expect(choice.model).toBe("openai-codex/gpt-5-codex");
    expect(choice.model_source).toBe("account chatgpt (workflow fix's anthropic/claude-sonnet is not a openai-codex model)");
    expect(choice).toMatchObject({ effort: "high", effort_source: "workflow fix" });
  });

  test("the implicit pi account spends no fixed provider, so any workflow model applies", () => {
    expect(choose('[workflows.fix.pi]\nmodel = "anthropic/claude-sonnet"', { account: "pi" })).toMatchObject({ model: "anthropic/claude-sonnet", model_source: "workflow fix" });
  });

  test("dispatch refuses a model of another provider on a declared account", () => {
    const account = accountsConfig(config(PI)).accounts.chatgpt!;
    expect(() => checkPins({ model: "anthropic/claude-sonnet", effort: null }, account)).toThrow(/not a openai-codex model/);
    expect(() => checkPins({ model: "openai-codex/gpt-5", effort: "minimal" }, account)).not.toThrow();
  });
});

describe("checks", () => {
  const claude = accountsConfig(config("")).accounts.claude!;
  const pi = accountsConfig(config("")).accounts.pi!;

  test("effort levels are each harness's own", () => {
    for (const level of EFFORT_LEVELS.claude) expect(() => checkPins({ model: null, effort: level }, claude)).not.toThrow();
    for (const level of EFFORT_LEVELS.pi) expect(() => checkPins({ model: null, effort: level }, pi)).not.toThrow();
    expect(() => checkPins({ model: null, effort: "minimal" }, claude)).toThrow(/claude effort must be one of low, medium, high, xhigh, max/);
    expect(() => checkPins({ model: null, effort: "huge" }, pi)).toThrow(/pi effort must be one of/);
  });

  test("a model name is one word a shell cannot split or expand", () => {
    for (const ok of ["sonnet", "claude-opus-5-5", "claude-opus-5-5[1m]", "openai-codex/gpt-5-codex", "sonnet:high", "us.anthropic.claude@2"]) {
      expect(() => checkPins({ model: ok, effort: null }, claude)).not.toThrow();
    }
    for (const bad of ["", "son net", "x;rm -rf /", "$(id)", "`id`", "-flag", "a'b", "a\nb", "x".repeat(129)]) {
      expect(() => checkPins({ model: bad, effort: null }, claude)).toThrow(/is not a model name/);
    }
  });
});

describe("existing config", () => {
  test("an account's or [workers]'s effort is not checked against the list, so no config that loaded before starts failing", () => {
    expect(choose('[accounts.work]\nharness = "claude"\neffort = "turbo"', { account: "work" })).toMatchObject({ effort: "turbo", effort_source: "account work" });
  });
});

describe("[workflows.<id>.<harness>]", () => {
  test("a table without stages on a built-in workflow keeps its stages and adds the defaults", () => {
    const wf = workflowsConfig(config('[workflows.feature.claude]\nmodel = "opus"\n[workflows.feature.pi]\neffort = "high"')).feature!;
    expect(wf.stages).toEqual(DEFAULT_WORKFLOWS.feature!.stages);
    expect(wf.models).toEqual({ claude: { model: "opus", effort: null }, pi: { model: null, effort: "high" } });
  });

  test("a workflow of your own still needs stages, and may carry defaults beside them", () => {
    expect(() => workflowsConfig(config('[workflows.mine.claude]\nmodel = "opus"'))).toThrow(/stages must be a list/);
    const wf = workflowsConfig(config('[workflows.mine]\nstages = [{ id = "build" }, { id = "ship", gate = "merge" }]\n[workflows.mine.claude]\neffort = "low"')).mine!;
    expect(wf.models).toEqual({ claude: { model: null, effort: "low" } });
  });

  test("bad values and unknown keys refuse the config", () => {
    expect(() => workflowsConfig(config('[workflows.fix.claude]\neffort = "minimal"'))).toThrow(/claude effort must be one of/);
    expect(() => workflowsConfig(config('[workflows.fix.claude]\nmodel = "a b"'))).toThrow(/is not a model name/);
    expect(() => workflowsConfig(config('[workflows.fix.claude]\nextra_args = ["--x"]'))).toThrow(/extra_args is not a known setting/);
    expect(() => workflowsConfig(config('[workflows.fix.codex]\nmodel = "x"'))).toThrow(/codex is not a known setting/);
  });
});

describe("plan phase lines", () => {
  test("model: and effort: lines are read beside account:", () => {
    const plan = parsePlan("## One\nmodel: opus\neffort: high\naccount: work\nDo it.\n\n## Two\nThen this.\n");
    expect(plan.phases[0]).toMatchObject({ model: "opus", effort: "high", account: "work", body: "Do it." });
    expect(plan.phases[1]).toMatchObject({ model: null, effort: null });
    expect(() => parsePlan("## One\nmodel: $(id)\nx\n")).toThrow(/is not a model name/);
  });
});
