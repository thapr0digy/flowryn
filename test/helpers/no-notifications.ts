/**
 * Loaded before every test file (bunfig.toml `[test] preload`): the suite
 * never posts a real notification. It sets FLOWRYN_NOTIFY=off for this
 * process and anything it spawns; in this process, any spawn of osascript
 * throws and is counted; every daemon the harness starts keeps
 * FLOWRYN_NOTIFY=off (it refuses to start one without it) and a recording
 * macOS channel (test/helpers/harness.ts). test/unit/notify-guard.test.ts
 * checks all three.
 *
 * It also pins TZ=UTC, explicitly rather than relying on bun test's own
 * internal UTC default, so a helper that spawns with `process.env` directly
 * (several tests build git envs this way) still agrees with the daemons and
 * CLIs spawned through the harness's own env (test/helpers/harness.ts). See
 * test/unit/tz.test.ts.
 */
import { afterAll } from "bun:test";

process.env.FLOWRYN_NOTIFY = "off";
process.env.TZ = "UTC";

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

// A notifier swallows a failing channel, so a refused spawn would not fail its own test: the run fails here instead.
afterAll(() => {
  const spawns = guard.__flowrynOsascriptSpawns!;
  if (spawns.length > 0) throw new Error(`osascript spawn(s) refused in this test process so far: ${spawns.length} (${spawns.join("; ")})`);
});
