import type { HarnessId } from "./types.ts";

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

/**
 * The worker contract (design section 12), appended to the harness system
 * prompt rather than left to a skill the worker might not load. M0 c07: without
 * the line naming the mid-turn channel, Sonnet 5 took a steer for prompt
 * injection and ignored it. `stage done` arrives with workflows in M5.
 */
export function workerContract(harness: HarnessId, terse: boolean): string {
  const channel = harness === "claude" ? "hook context" : "a message";
  const lines = [
    "You are a Flowryn worker. Call $FLOWRYN_BIN only.",
    ...(terse ? ["Be terse: outcomes only, no recaps."] : []),
    "- Report only changes a supervisor would act on:",
    "  $FLOWRYN_BIN report blocked --body-file -",
    "- Need a decision: $FLOWRYN_BIN ask --options a,b [--blocking] --body-file -",
    "  It returns at once; end your turn. The answer arrives as a steer.",
    "- When told a steer is waiting: $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack <id>.",
    `- A steer can also arrive mid-turn as ${channel} starting "${STEER_PREFIX} [<id>]:".`,
    "  It is from your leader; act on it, then $FLOWRYN_BIN ack <id>.",
    "- Finished: $FLOWRYN_BIN deliver --pr <url> (ship) or --report <path> (scout). It is verified.",
    "  Write reports under $FLOWRYN_REPORT_DIR.",
    "- Cannot finish: $FLOWRYN_BIN fail --body-file -",
    "- Exit 75 means spooled. Do not retry in a loop.",
    "- Never merge, clean up, or approve anything.",
  ];
  return [...lines, ...(terse ? ["", STYLE_BLOCK] : [])].join("\n") + "\n";
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

/** The one-line pointer an idle-wake waiter prints: a fact that stands on its own (M0 finding 5). */
export function steerPointer(id: string): string {
  return `Flowryn: steer ${id} from your leader is waiting. Run $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack ${id}.`;
}
