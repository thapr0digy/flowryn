import { basename, join } from "node:path";
import type { WorkersConfig } from "../../config/workers.ts";
import type { PaneProcess } from "../../runtime/herdr/runtime.ts";
import { HOOK_SIGNALS, type HarnessAdapter, type HookName, type LaunchPlan, type RunContext, type Trust } from "../types.ts";
import { RESUME_PROMPT } from "../claude/adapter.ts";
import { workerTmpEnv } from "../../lifecycle/run-tmp.ts";
// Embedded by `bun build --compile` (a $bunfs path there); the source path in development.
import extensionAsset from "./extension/flowryn-worker.ts" with { type: "file" };

const EXTENSION_FILE = "flowryn-worker.ts";

let extensionSource: string | null = null;

/** The worker extension's source, read once from the embedded asset. */
export async function loadExtensionSource(): Promise<string> {
  if (extensionSource === null) extensionSource = await Bun.file(extensionAsset as unknown as string).text();
  return extensionSource;
}

/** For callers that already loaded it (the launcher preloads before planning). */
export function extensionSourceSync(): string {
  if (extensionSource === null) throw new Error("the Pi worker extension source was not loaded; call loadExtensionSource() first");
  return extensionSource;
}

function plan(run: RunContext, config: WorkersConfig, prompt: string, includeTask: boolean): LaunchPlan {
  const pi = config.pi;
  const extensionPath = join(run.runDir, EXTENSION_FILE);
  const args = ["--session-id", run.sessionId];
  if (pi.session_dir) args.push("--session-dir", pi.session_dir);
  args.push("-e", extensionPath);
  for (const extension of pi.extensions) args.push("-e", extension);
  // A declared account names its provider, so Pi cannot resolve the model under another signed-in provider.
  if (pi.provider) args.push("--provider", pi.provider);
  if (pi.model) args.push("--model", pi.model);
  if (pi.effort) args.push("--thinking", pi.effort);
  if (pi.no_extensions) args.push("--no-extensions");
  if (pi.no_skills) args.push("--no-skills");
  if (pi.no_context_files) args.push("--no-context-files");
  // --append-system-prompt takes text or a file path (M0 p05); the contract is multi-line, so a file.
  args.push("--append-system-prompt", run.contractFile);
  args.push(...pi.extra_args);
  // `@file` attaches the task file's text to the first message (Pi 0.87.1: "Include files in initial message").
  if (includeTask) args.push(`@${run.instructionsFile}`);
  args.push(prompt);
  const env: Record<string, string> = { ...pi.env, ...workerTmpEnv("pi", run.tmpDir) };
  if (pi.agent_dir) env.PI_CODING_AGENT_DIR = pi.agent_dir;
  return { kind: "pi", args, env, files: [{ path: extensionPath, content: extensionSourceSync(), mode: 0o600 }] };
}

export const piAdapter: HarnessAdapter = {
  id: "pi",
  busySource: "extension",
  interruptVia: "extension",

  /** The instructions: the task file attached with @file, and one short prompt line (M0 p12). */
  launch(run, config) {
    return plan(run, config, run.promptLine, true);
  },

  /** --session-id with the id Flowryn chose at launch reopens the session (M0 p10). */
  resume(run, config) {
    return plan(run, config, run.resumePrompt ?? RESUME_PROMPT, false);
  },

  /** Pi asks only when the worktree has project resources, and the extension answers for this one process (M0 p11). */
  async preTrust(): Promise<Trust> {
    return { ok: true, wrote: false, detail: "the Flowryn extension answers project_trust for this process" };
  },

  /** The Pi Launcher build runs as pi-signed (argv0) and execs pi; a plain install runs as pi. */
  matchesProcess(process: PaneProcess, binary: string): boolean {
    const names = new Set(["pi", "pi-signed", basename(binary)]);
    return names.has(basename(process.argv0)) || names.has(basename(process.argv[0] ?? ""));
  },

  parseVersion(output: string): string | null {
    return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
  },

  translate(hook: HookName) {
    return HOOK_SIGNALS[hook];
  },
};
