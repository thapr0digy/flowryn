import { release } from "node:os";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { workersConfig } from "../config/workers.ts";
import type { HarnessId } from "../harness/types.ts";
import type { PiProfile } from "./pi-profile.ts";

/**
 * What a contract pass ran on besides the harness version and the revision
 * (docs/notes/2026-10-12-next-steps-md-ez.md): recorded with each pass and
 * shown, never compared by the gate.
 */
export interface ContractContext {
  /** `<os>-<arch> <kernel release>`, e.g. `darwin-arm64 25.3.0`. */
  platform: string;
  /** The configured Herdr binary's version, or null when it cannot be read. */
  herdr: string | null;
  /** The worker launch settings the suite ran with. */
  launch_profile: string;
}

const HERDR_VERSION_MS = 5_000;

export function platformLabel(): string {
  return `${process.platform}-${process.arch} ${release()}`;
}

/** `herdr 0.7.5` → `0.7.5`; null for anything else. */
export function parseHerdrVersion(output: string): string | null {
  return /\bherdr\s+v?(\d+\.\d+\.\d+[\w.+-]*)/.exec(output)?.[1] ?? null;
}

/** The configured Herdr binary's `--version`, within a few seconds; null when it is missing or says nothing usable. */
export async function herdrVersion(config: FlowrynConfig): Promise<string | null> {
  const binary = resolveTool(config, "herdr");
  if (!binary) return null;
  try {
    const proc = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), HERDR_VERSION_MS);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return parseHerdrVersion(`${out}\n${err}`);
  } catch {
    return null;
  }
}

/**
 * The launch settings a contract run's worker gets: Claude's from
 * [workers.claude] (with the run's model override), the Pi gate's scripted
 * model, or a real-model Pi pass's model.
 */
export function launchProfile(config: FlowrynConfig, harness: HarnessId, model: string | null, piProfile: PiProfile | undefined): string {
  if (harness === "pi") return piProfile === "real" ? `real model=${model ?? "default"}` : "scripted";
  const claude = workersConfig(config).claude;
  const parts = [
    `model=${model ?? claude.model ?? "default"}`,
    `effort=${claude.effort ?? "default"}`,
    `permission_mode=${claude.permission_mode}`,
    `pretrust=${claude.pretrust}`,
  ];
  if (claude.extra_args.length > 0) parts.push(`extra_args=${claude.extra_args.join(" ")}`);
  return parts.join(" ");
}

export async function contractContext(config: FlowrynConfig, harness: HarnessId, model: string | null, piProfile: PiProfile | undefined): Promise<ContractContext> {
  return { platform: platformLabel(), herdr: await herdrVersion(config), launch_profile: launchProfile(config, harness, model, piProfile) };
}
