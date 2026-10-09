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
  /** The stage the delivery ends (the run's last): a no-mistakes ship starts it before its pipeline. */
  lastStage?: { id: string; pools: string[] };
  /** The text is that stage's own, which has already started. */
  inLastStage?: boolean;
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

/** The "finished" lines: how this worker delivers, and that it is verified. */
export function deliveryLines(d: ContractDelivery): string[] {
  if (d.kind === "scout") return ["- Finished: $FLOWRYN_BIN deliver --report <path>. It is verified.", "  Write reports under $FLOWRYN_REPORT_DIR."];
  if (d.mode === "local-only") return ["- Ship locally: commit on your branch and never push.", "  Finished: $FLOWRYN_BIN deliver --local. It is verified."];
  if (d.mode === "direct-PR") {
    return [`- Ship: commit, git push origin HEAD, open a PR into ${d.defaultBranch} (gh-axi pr create).`, "  Finished: $FLOWRYN_BIN deliver --pr <url>. Verified: your HEAD must be the PR head."];
  }
  return [
    "- Ship with no-mistakes: commit, then run its pipeline; it pushes and opens the PR.",
    ...beginLines(d),
    "  An ask-user finding: $FLOWRYN_BIN ask --options <its choices> --blocks <what waits> --body-file - with it; never answer it yourself.",
    "  When it passes: git pull --ff-only (your HEAD must be the PR head),",
    "  then $FLOWRYN_BIN deliver --pr <url>. It is verified.",
  ];
}

/**
 * The worker contract (design section 12), appended to the harness system
 * prompt rather than left to a skill the worker might not load. M0 c07: without
 * the line naming the mid-turn channel, Sonnet 5 took a steer for prompt
 * injection and ignored it. The style block leads it (design section 11: the
 * same stable text leads every worker's instructions, so prompt caching
 * holds). The delivery lines follow the task's kind and the project's delivery
 * mode (M4); the stage lines explain the workflow (M5).
 */
export function workerContract(harness: HarnessId, style: string | null, delivery: ContractDelivery = { kind: "scout", mode: "local-only", defaultBranch: "main" }): string {
  const channel = harness === "claude" ? "hook context" : "a message";
  const lines = [
    "You are a Flowryn worker. Call $FLOWRYN_BIN only.",
    ...(style ? ["Be terse: outcomes only, no recaps."] : []),
    "- Your task runs in stages; your task file names the current one and its skill.",
    "  Stage finished: $FLOWRYN_BIN stage done [--review <lavish url>]; then end your",
    "  turn and wait: a steer starts the next stage or brings the review verdict. Ending a turn to wait on your own background job or agent is fine; any other turn ended with no outcome brings one reminder.",
    "- Tell your leader what it should act on: $FLOWRYN_BIN report <finding|blocked|failed> --body-file -",
    "  (report progress is only recorded). A finding that needs a decision is a question: ask it (below).",
    "- Work autonomously: decide what you can; record each choice and why (design page or PR).",
    "  Only when you truly cannot proceed: $FLOWRYN_BIN ask --options a,b --blocks <what waits> [--blocking] --body-file -",
    "  It returns at once; end your turn. The answer arrives as a steer.",
    "- Never rewrite history on a branch you have pushed: no commit --amend, rebase, push --force or --force-with-lease, reset --hard to an older commit.",
    "  To take main: new commits, git merge origin/main, a plain git push.",
    '- Never rm a path built from a variable that may be empty; use "${VAR:?}" or a mktemp -d directory.',
    "- A confirmation prompt appears: do not answer it; $FLOWRYN_BIN ask --blocking --options a,b --blocks <what waits> --body-file - naming it, then end your turn.",
    "- When told a steer is waiting: $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack <id>.",
    `- A steer can also arrive mid-turn as ${channel} starting "${STEER_PREFIX} [<id>]:".`,
    "  It is from your leader; act on it, then $FLOWRYN_BIN ack <id>.",
    "- A tool call may be blocked or cut short to deliver an urgent steer:",
    "  act on it, then redo the call if it still applies.",
    ...deliveryLines(delivery),
    "- Cannot finish: $FLOWRYN_BIN fail --body-file -",
    "- Exit 75 means spooled. Do not retry in a loop.",
    "- Never merge, clean up, or approve anything.",
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

/** The turn-end guard's one reminder per episode (src/lifecycle/turn-end-guard.ts). */
export const TURN_END_REMINDER = "You ended your turn without an outcome. Finish with one of: stage done, deliver, ask --blocking, report blocked, fail.";

/** The one-line pointer an idle-wake waiter prints: a fact that stands on its own (M0 finding 5). */
export function steerPointer(id: string): string {
  return `Flowryn: steer ${id} from your leader is waiting. Run $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack ${id}.`;
}
