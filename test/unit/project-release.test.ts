/**
 * A project's release commands (src/lifecycle/release.ts,
 * docs/notes/2026-11-15-pool-worktrees-release-fc.md): the `release` key read
 * into argv lists, and the runner, against scripts in a scratch directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { failedReleases, parseRelease, projectRelease, releaseCommands, runRelease } from "../../src/lifecycle/release.ts";
import { verifyConfig } from "../../src/verify/config.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function scratch(): string {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-release-")));
  return dir;
}

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const config = (text: string) => parseConfig(`data_dir = "/tmp/d"\nstate_dir = "/tmp/s"\n${text}`, "/tmp/h");

function invalid(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(FlowrynError);
    expect((error as FlowrynError).code).toBe("config_invalid");
    return (error as Error).message;
  }
  throw new Error("expected config_invalid");
}

describe("the release key", () => {
  test("a list of commands is read into argv lists, split on whitespace", () => {
    expect(releaseCommands(config('[projects.web]\nrelease = ["make pg-test-down", "  scripts/stop.sh   --all "]\n'), "web")).toEqual([
      ["make", "pg-test-down"],
      ["scripts/stop.sh", "--all"],
    ]);
  });

  test("absent, or an empty list, runs nothing", () => {
    expect(releaseCommands(config("[projects.web]\nverify = [\"true\"]\n"), "web")).toEqual([]);
    expect(releaseCommands(config("[projects.web]\nrelease = []\n"), "web")).toEqual([]);
    expect(releaseCommands(config(""), "web")).toEqual([]);
  });

  test("a value that is not a list, or an empty entry, is config_invalid", () => {
    expect(invalid(() => parseRelease("make pg-test-down", "[projects.web]"))).toContain("release must be a list of commands");
    expect(invalid(() => parseRelease(["make x", "  "], "[projects.web]"))).toContain("release entry 2 must be a non-empty command");
    expect(invalid(() => parseRelease([3], "[projects.web]"))).toContain("release entry 1");
  });

  test("assumption: no command is run through a shell, so one a shell would read differently is refused", () => {
    for (const entry of ["make down && rm -rf x", "echo $HOME", "a | b", "a; b", "echo 'x y'", 'echo "x"', "a > f", "echo `id`", "rm *", "(a)"]) {
      expect(invalid(() => parseRelease([entry], "[projects.web]"))).toContain("put it in a script");
    }
  });

  test("release is a known project setting, and verify's config check refuses a malformed one", () => {
    expect(verifyConfig(config('[projects.web]\nrelease = ["make pg-test-down"]\n'), "web")).toBeNull();
    expect(invalid(() => verifyConfig(config('[projects.web]\nverify = ["true"]\nrelease = "make x"\n'), "web"))).toContain("[projects.web] release must be a list");
  });

  test("at cleanup a malformed value is logged and runs nothing, never stopping the worktree from going", () => {
    const logs: string[] = [];
    expect(projectRelease(config('[projects.web]\nrelease = ["a | b"]\n'), "web", (l) => logs.push(l))).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("release skipped: [projects.web] release entry 1")]);
    expect(projectRelease(null, "web", (l) => logs.push(l))).toEqual([]);
  });
});

const env = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

describe("the release runner", () => {
  test("each command runs in the worktree, in order, as argv", async () => {
    const d = scratch();
    const log = join(d, "ran.log");
    const first = script("first", `echo "first $(pwd) $1" >> ${log}`);
    const second = script("second", `echo "second $(pwd)" >> ${log}`);
    const logs: string[] = [];
    const results = await runRelease([[first, "a"], [second]], { cwd: d, env: env(), label: "cleanup t1", log: (l) => logs.push(l) });
    expect(readFileSync(log, "utf8")).toBe(`first ${d} a\nsecond ${d}\n`);
    expect(results.map((r) => [r.command, r.ok, r.code])).toEqual([[`${first} a`, true, 0], [second, true, 0]]);
    expect(failedReleases(results)).toEqual([]);
    expect(logs).toEqual([`cleanup t1: release ${first} a done`, `cleanup t1: release ${second} done`]);
  });

  test("assumption: a failing command never stops the next, and its last lines are kept", async () => {
    const d = scratch();
    const fail = script("fail", 'echo "container not found" >&2; exit 3');
    const marker = join(d, "next-ran");
    const next = script("next", `touch ${marker}`);
    const logs: string[] = [];
    const results = await runRelease([[fail], [next]], { cwd: d, env: env(), label: "cleanup t1", log: (l) => logs.push(l) });
    expect(existsSync(marker)).toBe(true);
    expect(failedReleases(results)).toEqual([{ command: fail, code: 3, ok: false, timedOut: false, tail: "container not found" }]);
    expect(logs[0]).toBe(`cleanup t1: release ${fail} failed (code 3): container not found`);
  });

  test("assumption: a command past its deadline is ended, reported as such, and the next still runs", async () => {
    const d = scratch();
    const slow = script("slow", "sleep 30");
    const marker = join(d, "next-ran");
    const next = script("next", `touch ${marker}`);
    const began = Date.now();
    const logs: string[] = [];
    const results = await runRelease([[slow], [next]], { cwd: d, env: env(), label: "verify v1", log: (l) => logs.push(l), timeoutMs: 300 });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(results[0]).toMatchObject({ ok: false, timedOut: true });
    expect(logs[0]).toContain("failed (deadline)");
    expect(existsSync(marker)).toBe(true);
  });

  test("assumption: a command that cannot start is a failure, never a throw", async () => {
    const d = scratch();
    const results = await runRelease([[join(d, "no-such-command")]], { cwd: d, env: env(), label: "cleanup t1", log: () => {} });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
  });

  test("a long output keeps only its last 20 lines", async () => {
    const d = scratch();
    const noisy = script("noisy", "i=0; while [ $i -lt 50 ]; do echo line$i; i=$((i+1)); done; exit 1");
    const [result] = await runRelease([[noisy]], { cwd: d, env: env(), label: "cleanup t1", log: () => {} });
    expect(result!.tail.split("\n")).toHaveLength(20);
    expect(result!.tail.split("\n").at(-1)).toBe("line49");
  });
});
