/**
 * Loaded before every test file (bunfig.toml `[test] preload`): the suite
 * never posts a real notification. In this process, any spawn of osascript
 * throws and is counted; every daemon the harness starts gets
 * FLOWRYN_NOTIFY=off and a recording macOS channel (test/helpers/harness.ts),
 * so none reaches it either. test/unit/notify-guard.test.ts checks both.
 */
import { afterAll } from "bun:test";

export const OSASCRIPT = "/usr/bin/osascript";

const guard = globalThis as { __flowrynOsascriptSpawns?: string[] };
guard.__flowrynOsascriptSpawns ??= [];

function commandOf(args: unknown[]): string | null {
  const first = args[0];
  if (Array.isArray(first)) return typeof first[0] === "string" ? first[0] : null;
  if (first && typeof first === "object" && Array.isArray((first as { cmd?: unknown }).cmd)) return String((first as { cmd: unknown[] }).cmd[0]);
  return null;
}

function refuse(args: unknown[]): void {
  const command = commandOf(args);
  if (command === OSASCRIPT || command?.endsWith("/osascript") || command === "osascript") {
    guard.__flowrynOsascriptSpawns!.push(JSON.stringify(args[0]));
    throw new Error("the test suite never runs osascript: a real macOS notification would reach your Mac");
  }
}

const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
(Bun as unknown as { spawn: unknown }).spawn = (...args: unknown[]) => {
  refuse(args);
  return (spawn as (...a: unknown[]) => unknown)(...args);
};
(Bun as unknown as { spawnSync: unknown }).spawnSync = (...args: unknown[]) => {
  refuse(args);
  return (spawnSync as (...a: unknown[]) => unknown)(...args);
};

/** The osascript spawns refused in this process so far (the guard test asserts there are none). */
export function refusedOsascriptSpawns(): readonly string[] {
  return guard.__flowrynOsascriptSpawns!;
}

// A notifier swallows a failing channel, so a refused spawn would not fail its own test: the suite fails here instead.
afterAll(() => {
  if (guard.__flowrynOsascriptSpawns!.length > 0) throw new Error(`osascript was spawned ${guard.__flowrynOsascriptSpawns!.length} time(s) in this test file: ${guard.__flowrynOsascriptSpawns!.join("; ")}`);
});
