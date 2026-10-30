import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const ROOT = join(import.meta.dir, "..", "..");
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");
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
    ["review pages are not the terse style", source("src/skills/stages.ts"), "not the terse reply style"],
  ];
  for (const [rule, home, phrase] of homes) test(rule, () => expect(home).toContain(phrase));
});

describe("every rule the leader skill no longer carries has a home", () => {
  // Item lines are built inside transactions; their own unit tests check each line whole. Here: the words are in the builder.
  const homes: [string, string, string][] = [
    ["a page that did not open: relay its URL", source("src/lavish/opener.ts"), "relay the URL to open it by hand"],
    ["review_summary: ask to pass or send changes; pass words are theirs to confirm", source("src/lifecycle/review-chat.ts"), "still open: ask the user to pass or send changes"],
    ["review_worker_gone: resume or tell the user", source("src/lifecycle/review-chat.ts"), "flowryn resume ${run.task_id}, or tell the user"],
    ["pass_requested is not an approval", source("src/lifecycle/gate-questions.ts"), "Pass requested on the review page (not an approval)"],
    ["questions_open: ask those first", source("src/policy/chat-questions.ts"), "ask those first: flowryn chat-question"],
    ["review_channel: tell the user, relay the fix, take answers in chat", source("src/lavish/channel.ts"), "(tell the user and relay the fix)"],
    ["review_channel never passes the gate", source("src/lavish/channel.ts"), "it never passes the gate"],
    ["a refused grant names the repin", source("src/policy/grants.ts"), "flowryn leader repin (in their own terminal, not the leader's)"],
    ["harness_unverified names its command, outside the sandbox", source("src/lifecycle/harness-gate.ts"), "${contractsCommand(harness)} (outside the sandbox)"],
    ["human_only contract record: ask the user", source("src/contracts/grant.ts"), "ask the user to run flowryn doctor --contracts in their own terminal"],
    ["pr_conflict: steer or decline", source("src/reconcile/delivery.ts"), "steer it or flowryn decline ${run.task_id}"],
    ["review_unanswered: steer or decline", source("src/reconcile/reviews.ts"), "steer it or flowryn decline ${run.task_id}"],
    ["policy_behind: tell the user before merging", source("src/upkeep/policy-follow.ts"), "tell the user before merging as is"],
    ["checkout_unsynced: tell the user", source("src/upkeep/sync.ts"), "new runs branch from it as it is; tell the user"],
    ["build_failed: tell the user", source("src/upkeep/build.ts"), "(tell the user), the installed binary unchanged"],
    ["merge refusals name their fix", source("src/policy/merge.ts"), "verify it locally, then merge again: flowryn verify"],
    ["a queued verify starts by itself", source("src/cli/commands/verify.ts"), "starts by itself; never run verify again to retry"],
    ["verify takes minutes", help(VERIFY_CLI_VERBS, "verify"), "give the shell call a long timeout, or --detach"],
    ["restart_blocked: tell the user, offer --when-idle", source("src/daemon/restart.ts"), "tell the user, and offer flowryn daemon restart --when-idle"],
    ["binary_broken: tell the user", source("src/daemon/restart.ts"), "tell the user: rebuild it"],
    ["not_supervised: the user fixes it", source("src/daemon/restart.ts"), "ask the user to run flowryn daemon stop"],
    ["plist_drift: the user fixes it", source("src/service/launchd.ts"), "ask the user to run flowryn daemon install"],
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
