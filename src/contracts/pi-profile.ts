import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import { workersConfig } from "../config/workers.ts";
// Embedded by `bun build --compile` (a $bunfs path there); the source path in development. The daemon's
// automatic check runs a pinned compiled binary with no checkout, so the provider must travel inside it.
import providerAsset from "../../spikes/pi/lib/scripted-provider.ts" with { type: "file" };

/**
 * The Pi worker profiles a contract run uses (docs/notes/2026-10-11-make-the-pi-rv.md).
 *
 * - The gate (`scripted`) always plays the model with the offline scripted
 *   provider: the pinned Pi binary, Flowryn's extension, Herdr and the
 *   daemon are what a harness-version pass proves, and a real model's
 *   per-request variance must not decide it. The profile is fixed, so
 *   nothing in your own `[workers.pi]` can make it flaky, and every Pi path
 *   is inside the scratch home, so it never writes `~/.pi`.
 * - The opt-in real-model pass (`real`) keeps your `[workers.pi]` with the
 *   model you name, in a scratch agent dir seeded with copies of your Pi
 *   credentials.
 */

export const SCRIPTED_MODEL = "flowryn-scripted/scripted";

export type PiProfile = "scripted" | "real";

/** The agent-dir files a real model needs: saved credentials and custom model definitions (Pi 0.87.1 docs/configuration.md), and the model catalogue cache. */
export const PI_AGENT_FILES = ["auth.json", "models.json", "models-store.json"] as const;

export function isScriptedModel(model: string | null | undefined): boolean {
  return (model ?? "").startsWith("flowryn-scripted/");
}

/** Write the embedded scripted provider into the scratch home; returns its path. */
export async function writeScriptedProvider(home: string): Promise<string> {
  const dir = join(home, "pi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "scripted-provider.ts");
  writeFileSync(path, await Bun.file(providerAsset as unknown as string).text(), { mode: 0o600 });
  return path;
}

export function scriptedProviderPath(home: string): string {
  return join(home, "pi", "scripted-provider.ts");
}

export function piAgentDir(home: string): string {
  return join(home, "pi-agent");
}

/** The gate's `[workers.pi]`, as m5-live wires it (scripts/lab/m5-live.ts). */
export function scriptedPiTable(home: string): Record<string, unknown> {
  return {
    model: SCRIPTED_MODEL,
    extensions: [scriptedProviderPath(home)],
    agent_dir: piAgentDir(home),
    session_dir: join(home, "pi-sessions"),
    no_context_files: true,
    env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  };
}

/** The real-model pass's `[workers.pi]`: your own table, with the model you named and scratch agent and session dirs. */
export function realPiTable(own: Record<string, unknown> | undefined, model: string, home: string): Record<string, unknown> {
  return { ...own, model, agent_dir: piAgentDir(home), session_dir: join(home, "pi-sessions") };
}

/** Where your Pi keeps its credentials: `[workers.pi] agent_dir`, else PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piAgentSource(config: FlowrynConfig, env: NodeJS.ProcessEnv): string {
  return workersConfig(config).pi.agent_dir ?? (env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

/**
 * Copy the credential files that exist from `source` into the scratch agent
 * dir. `source` is only read. Throws when it has no auth.json, since a real
 * model then has nothing to sign in with.
 */
export function seedAgentDir(source: string, target: string): string[] {
  if (!existsSync(join(source, "auth.json"))) throw new Error(`no auth.json in ${source}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const name of PI_AGENT_FILES) {
    if (!existsSync(join(source, name))) continue;
    copyFileSync(join(source, name), join(target, name));
    copied.push(name);
  }
  return copied;
}
