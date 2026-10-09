import { PROTO, VERSION } from "../../src/version.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdOf } from "../../src/daemon/restart.ts";
import { decode } from "@toon-format/toon";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { daemonCall, makeHome, pingSocket, REPO_ROOT, readText, seedLeader, waitUntil, type TestHome } from "../helpers/harness.ts";

/**
 * The shipped artifact: one compiled binary that is both flowryn and flowrynd,
 * re-signed on macOS by the build (design section 3).
 */
let h: TestHome;
let bin: string;

beforeAll(async () => {
  h = makeHome();
  bin = join(h.home, "bin", "flowryn");
  const built = Bun.spawnSync([join(REPO_ROOT, "scripts/build.sh"), bin], { cwd: REPO_ROOT, env: { ...process.env, BUN_TMPDIR: process.env.BUN_TMPDIR ?? process.env.TMPDIR } });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stdout.toString()}${built.stderr.toString()}`);
}, 120_000);

afterAll(() => h.cleanup());

function run(path: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([path, ...args], { env: { ...h.env, ...env }, stdin: "ignore" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("compiled binary", () => {
  // macOS only: codesign is a macOS tool, and only the macOS build is signed.
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

function build(out: string, env: Record<string, string> = {}): void {
  const result = Bun.spawnSync([join(REPO_ROOT, "scripts/build.sh"), out], { cwd: REPO_ROOT, env: { ...process.env, BUN_TMPDIR: process.env.BUN_TMPDIR ?? process.env.TMPDIR, ...env } });
  if (result.exitCode !== 0) throw new Error(`build failed: ${result.stdout.toString()}${result.stderr.toString()}`);
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

describe("build stamp and pinned callers", () => {
  test("assumption: bun build --define stamps a compiled binary, and version --json reports it", () => {
    const data = (JSON.parse(run(bin, ["version", "--json"]).stdout) as { data: Record<string, unknown> }).data;
    expect(data.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof data.dirty).toBe("boolean");
    expect(data.source).toBe(REPO_ROOT);
    expect(Number.isInteger(data.schema)).toBe(true);
  });

  // macOS only: codesign is a macOS tool, and only the macOS build is signed.
  test.skipIf(process.platform !== "darwin")("assumption: a copy of the compiled binary keeps a valid signature", () => {
    const copy = join(h.home, "bin", "flowryn-copy");
    copyFileSync(bin, copy);
    expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", copy]).exitCode).toBe(0);
  });

  test(
    "a compiled daemon pins its build for callers, and restarts by itself onto a new merged build installed over it",
    async () => {
      const home = makeHome({ extraConfig: "[daemon]\nbuild_poll_ms = 200\nbuild_settle_ms = 2000" });
      try {
        // The installed binary and a supervisor script standing in for launchd: it stops the daemon, then starts the installed binary again.
        const install = join(home.home, "inst", "flowryn");
        mkdirSync(join(home.home, "inst"));
        copyFileSync(bin, install);
        chmodSync(install, 0o755);
        const script = join(home.home, "supervisor.sh");
        writeFileSync(
          script,
          `#!/bin/sh\nkill -TERM "$FLOWRYN_DAEMON_PID"\nwhile kill -0 "$FLOWRYN_DAEMON_PID" 2>/dev/null; do sleep 0.05; done\nFLOWRYN_LOG_STDERR=1 ${JSON.stringify(install)} daemon run >> ${JSON.stringify(join(home.home, "next.log"))} 2>&1 &\necho $! > ${JSON.stringify(join(home.home, "next.pid"))}\n`,
        );
        chmodSync(script, 0o755);
        writeFileSync(join(home.home, "supervisor.json"), JSON.stringify({ program: [install, "daemon", "run"], restart: [script] }));
        // A scratch source whose origin/main has the commit the new build is stamped with.
        const origin = join(home.home, "origin.git");
        const source = join(home.home, "source");
        git(home.home, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
        git(home.home, ["clone", "--quiet", origin, source]);
        writeFileSync(join(source, "README"), "x\n");
        git(source, ["add", "README"]);
        git(source, ["commit", "--quiet", "-m", "merged"]);
        git(source, ["push", "--quiet", "origin", "HEAD:main"]);
        git(source, ["fetch", "--quiet", "origin"]);
        const commit = git(source, ["rev-parse", "HEAD"]);

        const env = { ...home.env, FLOWRYN_SUPERVISOR: join(home.home, "supervisor.json") };
        requireNotificationsOff(env, "binary test");
        const first = Bun.spawn([install, "daemon", "run"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        let nextPid: number | null = null;
        try {
          await waitUntil(() => pingSocket(home), 15_000, "the compiled daemon");
          const oldBuild = buildIdOf([install])!;
          const ping = (await daemonCall(home.home, "daemon.ping", {})).data as { pid: number; build: string };
          expect(ping.build).toBe(oldBuild);
          const link = join(home.stateDir, "bin", "flowryn");
          expect(readlinkSync(link)).toBe(`flowryn-${oldBuild}`);

          // Rebuild over the installed binary, as bun run build does; it replaces the file rather than rewriting it.
          const inode = statSync(install).ino;
          build(install, { FLOWRYN_BUILD_COMMIT: commit, FLOWRYN_BUILD_DIRTY: "false", FLOWRYN_BUILD_SOURCE: source });
          expect(statSync(install).ino).not.toBe(inode);
          const newBuild = buildIdOf([install])!;
          expect(newBuild).not.toBe(oldBuild);
          // Until the restart, callers still run the old build.
          expect(readlinkSync(link)).toBe(`flowryn-${oldBuild}`);

          expect(await first.exited).toBe(0);
          await waitUntil(() => existsSync(join(home.home, "next.pid")), 5_000, "the next daemon's pid");
          nextPid = Number(readFileSync(join(home.home, "next.pid"), "utf8").trim());
          await waitUntil(() => pingSocket(home), 15_000, "the restarted daemon");
          const after = (await daemonCall(home.home, "daemon.ping", {})).data as { pid: number; build: string };
          expect(after.build).toBe(newBuild);
          expect(after.pid).not.toBe(ping.pid);
          expect(readlinkSync(link)).toBe(`flowryn-${newBuild}`);
          const db = home.db();
          try {
            const restarted = db.query("SELECT payload FROM events WHERE kind = 'daemon.restarted'").all() as { payload: string }[];
            expect(restarted).toHaveLength(1);
            expect(JSON.parse(restarted[0]!.payload)).toMatchObject({ by: "auto", old: { build: oldBuild }, new: { build: newBuild, commit } });
          } finally {
            db.close();
          }
        } finally {
          first.kill("SIGKILL");
          if (nextPid) {
            try {
              process.kill(nextPid, "SIGTERM");
            } catch {
              // already gone
            }
          }
        }
      } finally {
        home.cleanup();
      }
    },
    180_000,
  );
});

