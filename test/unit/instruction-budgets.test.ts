import { describe, expect, test } from "bun:test";
import { SKILL_BODY, SKILL_DESCRIPTION } from "../../src/bridges/skill.ts";
import { DEFAULT_WORKFLOWS } from "../../src/config/workflows.ts";
import { VERIFY_CLI_VERBS } from "../../src/cli/commands/verify.ts";
import { deliveryLines, REVIEW_TURN_END_REMINDER, steerPointer, STYLE_BLOCK, TURN_END_REMINDER, urgentBlockLine, workerContract, type ContractDelivery } from "../../src/harness/contract-text.ts";
import { LEARNING_VERBS } from "../../src/leader/learning-verbs.ts";
import type { VerbSpec } from "../../src/api/verbs.ts";
import { stageInstructions } from "../../src/lifecycle/stages.ts";
import { WORKER_VERBS } from "../../src/lifecycle/worker.ts";

/**
 * The design's budgets for what a model reads on every turn (design section
 * 12; docs/notes/2026-10-30-trim-the-leader-8n.md), at about 4 characters a
 * token, and the new home of every rule the trim moved out of the leader skill
 * and the worker contract: a moved rule that vanishes from its home fails here.
 */

const nm: ContractDelivery = { kind: "ship", mode: "no-mistakes", defaultBranch: "main", lastStage: { id: "ship", pools: ["validation"] }, harness: "claude" };
const feature = DEFAULT_WORKFLOWS.feature!;
const designText = stageInstructions({ def: feature, index: 0, stage: feature.stages[0]!, last: false }, { stateDir: "/none", delivery: nm });
const shipText = stageInstructions({ def: feature, index: 2, stage: feature.stages[2]!, last: true }, { stateDir: "/none", delivery: nm });
const help = (verbs: readonly VerbSpec[], name: string) => {
  const verb = verbs.find((v) => v.name === name)!;
  return [verb.summary, ...(verb.positionals ?? []).map((p) => p.help ?? "")].join(" ");
};

describe("instruction budgets", () => {
  test("assumption: the leader skill body stays within 1.5k tokens and its description within 60", () => {
    expect(SKILL_BODY.length).toBeLessThanOrEqual(6_000);
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(240);
  });

  test("assumption: the worker contract stays under 400 tokens whole (its own lines: test/unit/harness.test.ts)", () => {
    const text = workerContract("claude", STYLE_BLOCK, { base: "release/2" });
    expect(text.length).toBeLessThanOrEqual(1_600);
  });
});

describe("every rule the worker contract no longer carries has a home", () => {
  const homes: [string, string, string][] = [
    ["stage done, then end the turn", designText, "$FLOWRYN_BIN stage done --review <lavish url>"],
    ["a review's page messages are answered with review reply", designText, "answer with $FLOWRYN_BIN review reply --body-file - (never lavish-axi poll or reply yourself)"],
    ["review reply, at the turn-end guard", REVIEW_TURN_END_REMINDER, "$FLOWRYN_BIN review reply --body-file -"],
    ["a turn with no outcome brings one reminder", TURN_END_REMINDER, "You ended your turn without an outcome"],
    ["the pipeline waits for its stage", designText, "Do not run the no-mistakes pipeline yet"],
    ["delivery steps are the last stage's", shipText, "Drive it with ONE foreground no-mistakes axi run --wait"],
    ["a conflict-only ci gate: merge, never respond", shipText, "never respond (its fix rebases)"],
    ["an ask-user finding goes to the leader", shipText, "$FLOWRYN_BIN ask --nomistakes"],
    ["stage begin before the pipeline", deliveryLines(nm).join("\n"), "Before the pipeline: $FLOWRYN_BIN stage begin ship"],
    ["a waiting steer: inbox, act, ack", steerPointer("m1"), "Run $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack m1."],
    ["a blocked call is redone after an urgent steer", urgentBlockLine("m1", "x"), "redo it if it still applies"],
    ["report progress is only recorded", help(WORKER_VERBS, "report"), "progress is only recorded"],
    ["a finding that needs a decision is a question", help(WORKER_VERBS, "report"), "A finding that needs a decision is a question: ask it instead"],
    ["ask returns at once; the answer is a steer", help(WORKER_VERBS, "ask"), "returns at once, the answer arrives as a steer"],
  ];
  for (const [rule, home, phrase] of homes) test(rule, () => expect(home).toContain(phrase));
});

describe("every rule the leader skill no longer carries has a home", () => {
  // The item lines and refusal hints that took the rest are asserted where each is built: review-opener, review-chat,
  // gate-questions, leader-repin, auto-contract, contract-record, pr-feedback, upkeep (integration), policy-follow,
  // upkeep-sync, upkeep-build, verify, verify (integration), restart; the stage skills' plain-page rule in workflows.
  const homes: [string, string, string][] = [
    ["verify takes minutes", help(VERIFY_CLI_VERBS, "verify"), "give the shell call a long timeout, or --detach"],
    ["learnings: confirm, correct, drop, cap", help(LEARNING_VERBS, "learn"), "past the cap the least recently confirmed is set aside"],
  ];
  for (const [rule, home, phrase] of homes) test(rule, () => expect(home).toContain(phrase));

  test("the skill keeps the rules that are the leader's own", () => {
    for (const phrase of [
      "never name a shared notes file",
      "run `flowryn grant use c7` in the same turn",
      "Reserved ones go to the user",
      "only on the user's word, naming the check",
      "doctor --contracts --verify-only",
      "never in a loop",
      "Never: pass a gate, answer a reserved decision or waive a check the user has not",
    ]) expect(SKILL_BODY).toContain(phrase);
  });
});
