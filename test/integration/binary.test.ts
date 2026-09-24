import { PROTO, VERSION } from "../../src/version.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { makeHome, pingSocket, REPO_ROOT, readText, seedLeader, waitUntil, type TestHome } from "../helpers/harness.ts";

/**
 * The shipped artifact: one compiled binary that is both flowryn and flowrynd,
 * re-signed on macOS by the build (design section 3).
 */
let h: TestHome;
let bin: string;

beforeAll(async () => {
  h = makeHome();
  bin = join(h.home, "bin", "flowryn");
  const build = Bun.spawnSync([join(REPO_ROOT, "scripts/build.sh"), bin], { cwd: REPO_ROOT, env: { ...process.env, BUN_TMPDIR: process.env.BUN_TMPDIR ?? process.env.TMPDIR } });
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stdout.toString()}${build.stderr.toString()}`);
}, 120_000);

afterAll(() => h.cleanup());

function run(path: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([path, ...args], { env: { ...h.env, ...env }, stdin: "ignore" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("compiled binary", () => {
  test.skipIf(process.platform !== "darwin")("carries a valid ad-hoc signature", () => {
    expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", bin]).exitCode).toBe(0);
  });

  test("embeds the Pi worker extension, which a worker launch writes out per run", () => {
    const report = JSON.parse(run(bin, ["doctor", "--json"]).stdout) as { data: { checks: { check: string; status: string }[] } };
    expect(report.data.checks.find((c) => c.check === "pi extension")).toMatchObject({ status: "ok" });
  });

  test("runs as flowryn and, through the flowrynd link, as the daemon", async () => {
    expect(decode(run(bin, ["version"]).stdout)).toMatchObject({ flowryn: VERSION, proto: PROTO });
    const token = seedLeader(h);
    requireNotificationsOff(h.env, "binary test");
    const daemon = Bun.spawn([join(h.home, "bin", "flowrynd")], { env: h.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    try {
      await waitUntil(() => pingSocket(h), 15_000, "the compiled daemon");
      const added = run(bin, ["todo", "add", "from the binary"], { FLOWRYN_TOKEN: token });
      expect(added.code).toBe(0);
      expect(readText(h.todos)).toContain("from the binary");
      const status = decode(run(bin, ["daemon", "status"]).stdout) as { daemon: string; version: string };
      expect(status).toMatchObject({ daemon: "up", version: VERSION });
    } finally {
      daemon.kill("SIGTERM");
      expect(await daemon.exited).toBe(0);
    }
  }, 60_000);
});
