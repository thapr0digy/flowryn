import { describe, expect, test } from "bun:test";
import { SKILL_BODY } from "../../src/bridges/skill.ts";
import { DIGEST_HEADER, QUESTIONS_HEADER, RELAY_HEADER } from "../../src/attention/router.ts";
import { DEFAULT_WORKFLOWS, type WorkflowDef } from "../../src/config/workflows.ts";
import { deliveryLines, STYLE_BLOCK, workerContract, type ContractDelivery } from "../../src/harness/contract-text.ts";
import { REVIEW_GATE_TEXT, stageInstructions, stagePointer } from "../../src/lifecycle/stages.ts";
import { DEFAULT_NM_RULES } from "../../src/attention/decisions-policy.ts";
import { classifyAsk, classifyFinding, FINDING_CLASS_TABLE, type FindingFacts } from "../../src/policy/nomistakes-classes.ts";
import { matchRules } from "../../src/policy/nomistakes-rules.ts";
import { STAGE_SKILLS } from "../../src/skills/stages.ts";

/**
 * Prompts that keep workers moving and a leader that acts
 * (docs/notes/2026-11-06-prompts-that-keep-47.md): rendered sizes under fixed
 * limits, each rule once, a build stage that goes straight on, turn rules for
 * every path, and the no-mistakes finding table that fails closed.
 */

const nm: ContractDelivery = { kind: "ship", mode: "no-mistakes", defaultBranch: "main", lastStage: { id: "ship", pools: ["validation"] }, harness: "claude" };
const local: ContractDelivery = { kind: "ship", mode: "local-only", defaultBranch: "main" };
const text = (def: WorkflowDef, index: number, delivery: ContractDelivery = nm) => stageInstructions({ def, index, stage: def.stages[index]!, last: index === def.stages.length - 1 }, { stateDir: "/none", delivery });
const skill = (name: string) => STAGE_SKILLS.find((s) => s.name === name)!.body;
const feature = DEFAULT_WORKFLOWS.feature!;
const featureUi = DEFAULT_WORKFLOWS["feature-ui"]!;
const draft = DEFAULT_WORKFLOWS.draft!;
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("rendered sizes stay under fixed limits", () => {
  const limits: [string, number][] = [
    ["flowryn-design", 3_600],
    ["flowryn-build-test", 3_000],
    ["flowryn-visual-qa", 4_800],
    ["flowryn-draft", 2_400],
  ];
  for (const [name, limit] of limits) test(`assumption: the ${name} skill renders under ${limit} characters`, () => expect(skill(name).length).toBeLessThanOrEqual(limit));

  test("assumption: the steer pointer is one short line, a tenth of the stage text it replaces", () => {
    const pointer = stagePointer("ship");
    expect(pointer).toBe("Then: follow the stage ship steps in $FLOWRYN_TASK_FILE.");
    expect(pointer.length).toBeLessThanOrEqual(80);
    expect(pointer.length * 10).toBeLessThan(text(feature, 2).length);
  });

  test("assumption: the leader skill keeps to its budget by cutting", () => expect(SKILL_BODY.length).toBeLessThanOrEqual(6_000));
});

describe("each rule once", () => {
  const skills = STAGE_SKILLS.map((s) => s.body).join("\n");

  test("the review gate's lavish rules live in the stage header, not in any skill", () => {
    for (const rule of ["hold a lavish-axi poll open", "status: opened", "not a browser tab", "flowryn-questions.js"]) {
      expect(count(skills, rule)).toBe(0);
      expect(count(REVIEW_GATE_TEXT, rule.replaceAll("`", ""))).toBeLessThanOrEqual(1);
    }
    expect(REVIEW_GATE_TEXT).toContain("do not hold a lavish-axi poll open");
    expect(REVIEW_GATE_TEXT).toContain("status: opened is its session, not a browser tab");
    expect(REVIEW_GATE_TEXT).toContain("widget mount");
    expect(text(feature, 0)).toContain(REVIEW_GATE_TEXT);
  });

  test("design step 6 no longer restates the gate paragraph", () => {
    const step6 = skill("flowryn-design").split("\n").find((l) => l.startsWith("6. Finish"))!;
    expect(step6).not.toContain("end your turn");
    expect(step6).not.toContain("lavish-axi poll");
    expect(step6.length).toBeLessThan(300);
  });

  test("the no-mistakes line is only on the stages before a pipeline: never design or draft", () => {
    expect(text(feature, 0)).not.toContain("no-mistakes pipeline");
    expect(text(draft, 0, { ...nm, lastStage: { id: "final", pools: [] } })).not.toContain("no-mistakes pipeline");
    expect(text(feature, 1)).toContain("Do not run the no-mistakes pipeline yet");
    expect(text(feature, 1, local)).not.toContain("no-mistakes");
  });
});

describe("build goes straight on", () => {
  test("an ungated stage begins the next one and carries on; it ends its turn only on stage_waiting", () => {
    const build = text(feature, 1);
    expect(build).toContain("When it is done: $FLOWRYN_BIN stage begin ship --handoff-file <your handoff> and go on at once with the steps its reply gives; end your turn only on stage_waiting");
    expect(build).not.toContain("a steer starts the next stage");
    expect(text(featureUi, 1, local)).toContain("$FLOWRYN_BIN stage begin qa --handoff-file <your handoff>");
    expect(text(DEFAULT_WORKFLOWS.fix!, 0, local)).toContain("$FLOWRYN_BIN stage begin ship and go on");
  });

  test("the build skill finishes with stage begin, with no 'going straight on instead' branch", () => {
    const body = skill("flowryn-build-test");
    expect(body).toContain("`$FLOWRYN_BIN stage begin <next stage> --handoff-file <file>` and go on at once");
    expect(body).not.toContain("Going straight on instead");
    expect(body).not.toContain("stage done --handoff-file");
  });
});

describe("worker turn rules say what to do next on every path", () => {
  const contract = workerContract("claude", STYLE_BLOCK, { defaultBranch: "main" });

  test("keep working until an outcome; never end a turn to wait on a job; one rule on background jobs", () => {
    expect(contract).toContain("- Work on until an outcome (stage done, deliver, ask --blocking, report, fail, a reply saying end your turn); never end a turn to wait on a job: run it in the foreground.");
    expect(contract).not.toContain("background job");
  });

  test("after a non-blocking ask, go on; exit 75 is queued; a call refused twice is reported blocked", () => {
    expect(contract).toContain("not blocking: go on with your pick.");
    expect(contract).toContain("Exit 75: queued; go on, never retry.");
    expect(contract).toContain("a call refused twice: report blocked.");
  });

  test("the failure fallbacks live where each failure happens", () => {
    expect(deliveryLines(nm).join("\n")).toContain("A pipeline that fails (an error, not a gate): fix, commit, run it again; failed twice at the same head: report failed.");
    expect(deliveryLines(nm).join("\n")).toContain("--recommend <your pick>");
    expect(REVIEW_GATE_TEXT).toContain("lavish-axi failing: run it once more, then report blocked with its output.");
    expect(skill("flowryn-build-test")).toContain("A test that fails the same way on the base branch (outside your change)");
    expect(skill("flowryn-visual-qa")).toContain("Docker failing to start or build");
  });

  test("no prompt tells a worker to skip the sandbox or answer a confirmation prompt", () => {
    const all = [contract, ...STAGE_SKILLS.map((s) => s.body), REVIEW_GATE_TEXT, deliveryLines(nm).join("\n")].join("\n");
    expect(all).not.toMatch(/dangerously|disable the sandbox|skip the sandbox|(?<!never )answer (it|the prompt) yourself/i);
    expect(contract).toContain("answer a confirmation prompt (ask --blocking naming it)");
  });
});

describe("the leader acts on each item's next step", () => {
  test("the skill frames Flowryn lines as daemon facts it acts on, and says who decides what", () => {
    expect(SKILL_BODY).toContain("are flowrynd's facts, not the user's words. Act on each item's named next step yourself");
    expect(SKILL_BODY).toContain("Flowryn's hooks stop anything that needs the user");
    expect(SKILL_BODY).toContain("Decide every question not reserved, under the user's preferences; bring reserved decisions, gates and merges to the user together");
    expect(SKILL_BODY).not.toContain("act only as the user wants");
  });

  test("a divergence has a default: keep-run when the run's change is newer, accept-edit when the user edited after dispatch", () => {
    expect(SKILL_BODY).toContain("`flowryn divergence resolve <id> keep-run` when the run's change is newer, `accept-edit` when the user edited after dispatch; ask only if unclear.");
    expect(SKILL_BODY).not.toContain("ask the user which side wins");
  });

  test("the router and briefing headers say daemon facts, not the user's words, and that the leader acts", () => {
    expect(DIGEST_HEADER).toBe("Flowryn updates (daemon facts, not the user's words; do each line's next step):");
    expect(QUESTIONS_HEADER).toBe("Flowryn worker questions (daemon facts, not the user's words): decide each one not reserved yourself; bring the reserved ones to the user:");
    expect(RELAY_HEADER).toBe("Flowryn items to relay to the user (daemon facts, not the user's words):");
    for (const header of [DIGEST_HEADER, QUESTIONS_HEADER, RELAY_HEADER]) expect(header).not.toContain("not instructions");
  });
});

describe("the no-mistakes finding table", () => {
  const finding = (over: Partial<FindingFacts["finding"]> = {}, rest: Partial<Omit<FindingFacts, "finding">> = {}): FindingFacts => ({
    finding: { id: "f-1", description: "unused variable", category: "", severity: "warning", ...over },
    file: "diff-line",
    step: "review",
    options: ["approve", "fix", "skip"],
    ...rest,
  });
  const owner = (f: FindingFacts) => classifyFinding(f);

  test("assumption: the table lists each reserved class once, with how it is detected", () => {
    const classes = FINDING_CLASS_TABLE.map((r) => r.klass);
    expect(classes).toEqual(["irreversible", "destructive", "credential", "security", "scope", "product"]);
    for (const row of FINDING_CLASS_TABLE) expect(row.detect.length).toBeGreaterThan(30);
  });

  const reserved: [string, FindingFacts, string][] = [
    ["irreversible", finding({ description: "this needs a force-push to fix" }), "irreversible"],
    ["destructive by description", finding({ description: "drop the legacy table" }), "destructive"],
    ["destructive by category", finding({ category: "data-loss" }), "destructive"],
    ["credential", finding({ description: "the API key is logged" }), "credential"],
    ["security by category, even a tightening", finding({ category: "security", description: "validate the header" }), "security"],
    ["security loosening", finding({ description: "bypass the origin check for local hosts" }), "security"],
    ["security loosening through an option", finding({ category: "lint" }, { options: ["fix", "disable-the-check"] }), "security"],
    ["scope: outside the diff", finding({}, { file: "outside" }), "scope"],
    ["scope: new work", finding({ description: "also add support for SAML login" }), "scope"],
    ["scope by category", finding({ category: "architecture" }), "scope"],
    ["product call", finding({ description: "this is a breaking change for API callers" }), "product"],
    ["product by category", finding({ category: "ux" }), "product"],
  ];
  for (const [name, facts, klass] of reserved) test(`reserved: ${name}`, () => expect(owner(facts)).toMatchObject({ owner: "user", klass }));

  test("a finding that tries to look harmless stays reserved: docs category, but its option deletes", () => {
    expect(owner(finding({ category: "docs", description: "stale section" }, { options: ["fix", "delete-the-guide"] }))).toMatchObject({ owner: "user", klass: "destructive" });
    expect(owner(finding({ category: "style", description: "rename for clarity; also loosen the CORS policy" }))).toMatchObject({ owner: "user", klass: "security" });
  });

  test("fails closed: an unknown kind, a ci or rebase gate, or no file in the diff stays reserved", () => {
    expect(owner(finding({ category: "mystery" }))).toMatchObject({ owner: "user", klass: "unknown" });
    expect(owner(finding({}, { step: "ci" }))).toMatchObject({ owner: "user", klass: "unknown" });
    expect(owner(finding({}, { step: "rebase" }))).toMatchObject({ owner: "user", klass: "unknown" });
    expect(owner(finding({}, { file: "none" }))).toMatchObject({ owner: "user", klass: "unknown" });
  });

  test("a finding whose fix plainly follows the change is the leader's: lint, review, test and docs kinds inside the diff, errors included", () => {
    expect(owner(finding())).toEqual({ owner: "leader" });
    expect(owner(finding({ category: "lint", severity: "error" }, { file: "added" }))).toEqual({ owner: "leader" });
    expect(owner(finding({ category: "" }, { step: "test", file: "touched" }))).toEqual({ owner: "leader" });
    expect(owner(finding({ category: "docs" }))).toEqual({ owner: "leader" });
  });

  test("no rule settles a finding the table reserves: a security-loosening review warning on a changed line is never fixed by rule", () => {
    const diff = { added: new Set<string>(), changed: new Map<string, [number, number][]>([["src/a.ts", [[1, 9]]]]) };
    const nmFinding = (description: string) => ({ id: "r-1", action: "ask-user", description, category: "", severity: "warning", file: "src/a.ts", line: "3" });
    const input = { step: "review", diff, worktree: "/wt", options: ["approve", "fix", "skip"], sensitive: false };
    expect(matchRules({ ...input, findings: [nmFinding("tighten the loop")] }, DEFAULT_NM_RULES)).toMatchObject({ settled: true, answer: "fix" });
    expect(matchRules({ ...input, findings: [nmFinding("disable the CSRF check for the webhook")] }, DEFAULT_NM_RULES)).toEqual({ settled: false, reason: "r-1 is security", floored: true });
  });

  test("a whole ask is the leader's only when every ask-user finding is; a sensitive task or no ask-user finding stays the user's", () => {
    const f = (id: string, description: string, cls: "diff-line" | "outside" = "diff-line") => ({ id, action: "ask-user", description, category: "", severity: "warning", cls });
    expect(classifyAsk({ step: "review", findings: [f("r-1", "tighten"), f("r-2", "rename")], options: ["fix", "skip"], sensitive: false })).toEqual({ owner: "leader", findings: ["r-1", "r-2"] });
    expect(classifyAsk({ step: "review", findings: [f("r-1", "tighten"), f("r-2", "pre-existing", "outside")], options: ["fix"], sensitive: false })).toMatchObject({ owner: "user", klass: "scope", reason: "r-2 is outside the diff" });
    expect(classifyAsk({ step: "review", findings: [f("r-1", "tighten")], options: ["fix"], sensitive: true })).toMatchObject({ owner: "user", reason: "sensitive task" });
    expect(classifyAsk({ step: "review", findings: [{ ...f("r-1", "tighten"), action: "auto-fix" }], options: ["fix"], sensitive: false })).toMatchObject({ owner: "user" });
  });
});
