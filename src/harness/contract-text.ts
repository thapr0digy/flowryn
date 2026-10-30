import type { HarnessId } from "./types.ts";
import { TOOL_MAP } from "../policy/toolkit.ts";

/**
 * The terse style block (design section 11). The same stable text leads the
 * leader's system prompt (M3) and every worker's instructions, so prompt
 * caching still holds.
 */
export const STYLE_BLOCK = [
  "Reply in the fewest words that carry the outcome. No preamble, no recap of",
  "tool output, no restating the request. Prefer a short list. At most 5 lines",
  'unless asked for detail; offer "flowryn show <id>" instead of pasting.',
].join("\n");

/** Prefix of every steer a worker receives mid-turn; the contract names it so the model treats it as its leader's. */
export const STEER_PREFIX = "Flowryn steer";

/** What a worker delivers, by task kind and the project's delivery mode (design section 8). */
export interface ContractDelivery {
  kind: "ship" | "scout";
  mode: "no-mistakes" | "direct-PR" | "local-only";
  defaultBranch: string;
  /** The task's own base branch (`dispatch --base`), when it is not the default: the branch its PR targets. */
  base?: string | null;
  /** The stage the delivery ends (the run's last): a no-mistakes ship starts it before its pipeline. */
  lastStage?: { id: string; pools: string[] };
  /** The text is that stage's own, which has already started. */
  inLastStage?: boolean;
  /** The worker's harness, which names the shell timeout a foreground pipeline wait needs. */
  harness?: HarnessId;
}

/** Each harness's shell timeout that outlasts no-mistakes' default 8-minute --wait (Claude's Bash defaults to 2 minutes). */
const WAIT_TIMEOUT: Record<HarnessId, string> = { claude: "Bash timeout 600000", pi: "bash timeout 600" };

/** The pipeline waits in the foreground: a backgrounded call leaves the worker idle and costs a wake per return (docs/notes/2026-10-23-workers-wait-on-fn.md). */
function waitLines(d: ContractDelivery): string[] {
  const timeout = d.harness ? WAIT_TIMEOUT[d.harness] : "a 10-minute shell timeout";
  return [
    `  Drive it with ONE foreground no-mistakes axi run --wait per call (${timeout}); never background it or poll axi status.`,
    "  A call that returns on elapsed wait, not a gate or outcome: run the same call again at once. After respond, reattach with axi run --wait.",
  ];
}

/** A no-mistakes ship's pipeline runs under its last stage's slots: start that stage first. */
function beginLines(d: ContractDelivery): string[] {
  if (d.inLastStage) return [];
  const id = d.lastStage?.id ?? "<your last stage>";
  const pools = d.lastStage?.pools ?? [];
  const slot = pools.length > 0 ? `; it holds a slot of ${pools.join(" and ")}` : "";
  const wait = !d.lastStage || pools.length > 0 ? ["  On stage_waiting, end your turn: a steer says when it has started."] : [];
  return [`  Before the pipeline: $FLOWRYN_BIN stage begin ${id}${slot}.`, ...wait];
}

/** The branch the worker's PR targets and takes in with a merge: its base, else the default branch. */
function targetOf(d: ContractDelivery): string {
  return d.base ?? d.defaultBranch;
}

/** A named base: no-mistakes must be told, or it rebases onto, opens its PR against and watches CI for the default. */
function baseLines(d: ContractDelivery): string[] {
  return d.base ? [`  This task's base is ${d.base}, not ${d.defaultBranch}: pass --base-branch ${d.base} on every no-mistakes axi run that starts a run.`] : [];
}

/** The "finished" lines: how this worker delivers, and that it is verified. */
export function deliveryLines(d: ContractDelivery): string[] {
  if (d.kind === "scout") return ["- Finished: $FLOWRYN_BIN deliver --report <path>. It is verified.", "  Write reports under $FLOWRYN_REPORT_DIR."];
  if (d.mode === "local-only") return ["- Ship locally: commit on your branch and never push.", "  Finished: $FLOWRYN_BIN deliver --local. It is verified."];
  if (d.mode === "direct-PR") {
    return [`- Ship: commit, git push origin HEAD, open a PR into ${targetOf(d)} (gh-axi pr create).`, "  Finished: $FLOWRYN_BIN deliver --pr <url>. Verified: your HEAD must be the PR head."];
  }
  return [
    "- Ship with no-mistakes: commit, then run its pipeline; it pushes and opens the PR.",
    ...baseLines(d),
    ...beginLines(d),
    ...waitLines(d),
    "  An ask-user finding: $FLOWRYN_BIN ask --nomistakes --options <its choices> --blocks <what waits> --body-file - with it; never answer it yourself.",
    "  A rule may settle it at once: then act on the steer it names.",
    `  A ci gate whose only findings are merge conflicts: never respond (its fix rebases); git merge origin/${targetOf(d)}, resolve, commit, plain git push, then run the pipeline again.`,
    "  When it passes: git pull --ff-only (your HEAD must be the PR head),",
    "  then $FLOWRYN_BIN deliver --pr <url>. It is verified.",
  ];
}

/**
 * The worker contract (design section 12), appended to the harness system
 * prompt rather than left to a skill the worker might not load. It holds only
 * what a worker needs on every turn (docs/notes/2026-10-30-trim-the-leader-8n.md
 * lists where each situational rule lives instead): the stage and delivery
 * steps are in the task file ($FLOWRYN_TASK_FILE, rewritten at each stage
 * start), and each steer, pointer and verb reply names its own next step.
 * M0 c07: without the line naming the mid-turn channel, Sonnet 5 took a steer
 * for prompt injection and ignored it. The style block and tool map lead it
 * (design section 11: the same stable text leads every worker's instructions,
 * so prompt caching holds).
 */
export function workerContract(harness: HarnessId, style: string | null, delivery: Pick<ContractDelivery, "base" | "defaultBranch">): string {
  const channel = harness === "claude" ? "hook context" : "a message";
  const base = delivery.base ?? delivery.defaultBranch;
  const lines = [
    "You are a Flowryn worker; call $FLOWRYN_BIN only. Reread $FLOWRYN_TASK_FILE (your stage, its skill, how it ends) when unsure.",
    `- "${STEER_PREFIX} [<id>]:" lines (mid-turn as ${channel}, or after a pointer) are your leader's: act on them, then $FLOWRYN_BIN ack <id>.`,
    "- End each turn with an outcome (stage done, deliver, ask, report, fail --body-file -) or on your own background job.",
    "- Decide what you can; record why. Stuck: $FLOWRYN_BIN ask --options a,b --blocks <what waits> [--blocking] --body-file -",
    "- A confirmation prompt: never answer it; ask --blocking naming it.",
    "- For your leader to act on: $FLOWRYN_BIN report <finding|blocked|failed> --body-file -",
    `- Never rewrite pushed history (amend, rebase, force push, reset --hard back); take ${base} by git merge origin/${base}, plain push.`,
    '- Never rm a path from a maybe-empty variable ("${VAR:?}", mktemp -d); scratch goes in $TMPDIR.',
    "- Never merge, clean up or approve. Exit 75: spooled, do not retry.",
  ];
  return [...(style ? [style, ""] : []), TOOL_MAP, "", ...lines].join("\n") + "\n";
}

/**
 * The positional prompt: one short line pointing at the full task file.
 * Herdr's agent.start types the command into the pane's shell, which refuses
 * control characters (so no multi-line text) and, while a fresh shell is still
 * starting, keeps at most one terminal line of input (1024 bytes on macOS; M0
 * finding 11). The task itself therefore travels in the file.
 */
export function promptLine(kind: "ship" | "scout", taskId: string, instructionsFile: string): string {
  return `Flowryn ${kind} ${taskId}. Your full task is in ${instructionsFile}; read it first, then do it.`;
}

/** A steer as the worker sees it mid-turn or in its inbox. */
export function steerLine(id: string, body: string): string {
  return `${STEER_PREFIX} [${id}]: ${body.replace(/\s+/g, " ").trim()} (when done: $FLOWRYN_BIN ack ${id})`;
}

/** Why a Claude worker's tool call was denied: the urgent steer itself, as the reason it reads (Tier 2). */
export function urgentBlockLine(id: string, body: string): string {
  return `${steerLine(id, body)} This tool call was blocked so you read this first; redo it if it still applies.`;
}

/** An urgent steer as a Pi worker gets it: it may cut short the tool call in flight (hook preempt). */
export function urgentCutLine(id: string, body: string): string {
  return `${steerLine(id, body)} A tool call cut short for this: redo it if it still applies.`;
}

/** The turn-end guard's one reminder per episode (src/lifecycle/turn-end-guard.ts). */
export const TURN_END_REMINDER = "You ended your turn without an outcome. Finish with one of: stage done, deliver, ask --blocking, report blocked, fail.";
/** The same reminder at a review gate, where the outcome due is a reply to the user's page message. */
export const REVIEW_TURN_END_REMINDER = "You ended your turn without answering the user's message on your review page. Answer it: $FLOWRYN_BIN review reply --body-file -";

/** The one-line pointer an idle-wake waiter prints: a fact that stands on its own (M0 finding 5). */
export function steerPointer(id: string): string {
  return `Flowryn: steer ${id} from your leader is waiting. Run $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack ${id}.`;
}
