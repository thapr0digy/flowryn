import type { WorkersConfig } from "../config/workers.ts";
import type { PaneProcess } from "../runtime/herdr/runtime.ts";

/** Design section 5: one adapter per harness, implemented twice in v1. */
export const HARNESS_IDS = ["claude", "pi"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/** What an adapter needs to know about a run to launch or resume it. */
export interface RunContext {
  runId: string;
  taskId: string;
  kind: "ship" | "scout";
  /** The run's worktree root (absolute, resolved). */
  worktree: string;
  /** The project's registered checkout. */
  projectPath: string;
  /** Private per-run directory under the state dir: settings, instructions, logs. */
  runDir: string;
  /** Harness session id Flowryn chose at dispatch (both harnesses accept a preassigned id). */
  sessionId: string;
  /** Full task text (multi-line), written to a file because Herdr refuses control characters in arguments. */
  instructionsFile: string;
  /** The worker contract and style block, appended to the harness system prompt. */
  contractFile: string;
  /** One line summarising the task, sent as the positional prompt. */
  promptLine: string;
  /** Absolute path of the flowryn binary (or its wrapper) the worker calls. */
  flowrynBin: string;
  /** The harness binary Flowryn resolved from [tools]. */
  binary: string;
  /** The daemon socket the worker's CLI calls; a sandboxed shell tool must be allowed to reach it. */
  daemonSocket: string;
  /** Directories the worker's CLI and reports write outside the worktree (its spool, its report directory). */
  writable: string[];
  /** Paths the worker's sandbox must never write, even inside a writable one (the project's git hooks and config). */
  readOnly: string[];
  /** The Claude plugin holding the stage skills (design section 11); Pi reads the SKILL.md a stage names. */
  stagePlugin?: string;
}

export interface PlanFile {
  path: string;
  content: string;
  mode?: number;
}

/** Everything a launch or resume needs: Herdr agent.start arguments, pane env, and files to write first. */
export interface LaunchPlan {
  kind: HarnessId;
  args: string[];
  env: Record<string, string>;
  files: PlanFile[];
}

export interface Trust {
  ok: boolean;
  /** Whether anything was written to the harness's own config. */
  wrote: boolean;
  detail: string;
}

/** What a harness lifecycle event means (design section 5, translate). */
export type Signal = "started" | "busy" | "tool" | "turn_ended" | "failed" | "ended";

/** Hook verbs a worker's hooks or extension call, and the signal each carries. */
export const HOOK_SIGNALS = {
  "worker-start": "started",
  prompt: "busy",
  "pre-tool": "tool",
  "post-tool": "tool",
  stop: "turn_ended",
  "stop-failure": "failed",
  "session-end": "ended",
} as const satisfies Record<string, Signal>;
export type HookName = keyof typeof HOOK_SIGNALS;

export interface Verified {
  ok: boolean;
  evidence: "hook" | "process" | "transcript" | "timeout";
  detail?: string;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** Busy truth comes from harness events, never screen text. */
  readonly busySource: "hooks" | "extension";
  /** How the daemon interrupts a busy worker: the interrupt key through Herdr, or the extension's abort. */
  readonly interruptVia: "keys" | "extension";
  launch(run: RunContext, config: WorkersConfig): LaunchPlan;
  resume(run: RunContext, config: WorkersConfig): LaunchPlan;
  /** Register or check trust before launch; never answer a dialog with keys. */
  preTrust(run: RunContext, config: WorkersConfig): Promise<Trust>;
  /** Is this pane process the harness we launched (and not, say, a shell hook's child)? */
  matchesProcess(process: PaneProcess, binary: string): boolean;
  /** The installed harness version, from `<binary> --version`. */
  parseVersion(output: string): string | null;
  translate(hook: HookName): Signal;
}
