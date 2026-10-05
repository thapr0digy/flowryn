import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The vendored Herdr lab helper (spikes/lib/herdr-lab.sh) against a fake
 * `herdr` on PATH: its name rule, the run guards, and the default-session
 * tripwire. The fake keeps its sessions in a JSON file and logs every call.
 */
const HELPER = resolve(import.meta.dir, "../../spikes/lib/herdr-lab.sh");

const FAKE_HERDR = `#!/usr/bin/env bash
set -u
printf '%s|%s\\n' "\${HERDR_SESSION:-}" "$*" >> "$FAKE_DIR/calls.log"
state="$FAKE_DIR/sessions.json"
case "$1 \${2:-}" in
  "session list") cat "$state" ;;
  "session stop") jq --arg n "$3" '.sessions |= map(if .name == $n then .running = false else . end)' "$state" > "$state.tmp" && mv "$state.tmp" "$state"; echo '{}' ;;
  "session delete") jq --arg n "$3" '.sessions |= map(select(.name != $n))' "$state" > "$state.tmp" && mv "$state.tmp" "$state"; echo '{}' ;;
  "status --json") jq --arg n "\${HERDR_SESSION}" '{server: {running: any(.sessions[]; .name == $n and .running)}}' "$state" ;;
  "server "*)
    name=\${HERDR_SESSION}
    jq --arg n "$name" '.sessions += [{"name": $n, "default": false, "running": true, "socket_path": "/tmp/lab.sock"}]' "$state" > "$state.tmp" && mv "$state.tmp" "$state" ;;
  *) echo "ran: $*" ;;
esac
`;

const DEFAULT_SESSION = { name: "default", default: true, running: true, socket_path: "/tmp/default.sock" };

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function lab() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-lab-"));
  dirs.push(dir);
  writeFileSync(join(dir, "herdr"), FAKE_HERDR);
  chmodSync(join(dir, "herdr"), 0o755);
  const setSessions = (sessions: object[]) => writeFileSync(join(dir, "sessions.json"), JSON.stringify({ sessions }));
  setSessions([DEFAULT_SESSION]);
  const run = (...args: string[]) => {
    const out = Bun.spawnSync([HELPER, ...args], {
      env: { PATH: `${dir}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`, FAKE_DIR: dir, HERDR_LAB_STATE_DIR: join(dir, "state"), TMPDIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
  };
  const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);
  return { dir, run, calls, setSessions };
}

describe("herdr-lab.sh", () => {
  test("lab session names start with fl-lab-, with the label sanitized and capped at 16 characters", () => {
    const { run } = lab();
    const out = run("name", "a very/long label that keeps going");
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toMatch(/^fl-lab-averylonglabelth-\d+-\d+$/);
  });

  test("a session not named fl-lab-* is refused before any Herdr call, the default session above all", () => {
    const { run, calls } = lab();
    for (const name of ["default", "fm-lab-old", "", "fl-lab-"]) {
      const out = run("run", name, "pane", "list");
      expect(out.code).not.toBe(0);
    }
    expect(calls()).toEqual([]);
  });

  test("run appends the lab session to every Herdr call", () => {
    const { run, calls } = lab();
    const out = run("run", "fl-lab-x-1-2", "pane", "list");
    expect(out.code).toBe(0);
    expect(calls()).toEqual(["fl-lab-x-1-2|pane list --session fl-lab-x-1-2"]);
  });

  test("run refuses a caller --session, a leading option, server operations and session lifecycle, but allows session list", () => {
    const { run, calls } = lab();
    expect(run("run", "fl-lab-x-1-2", "pane", "list", "--session", "default").stderr).toContain("forbids caller-supplied --session");
    expect(run("run", "fl-lab-x-1-2", "pane", "list", "--session=default").code).not.toBe(0);
    expect(run("run", "fl-lab-x-1-2", "--json", "server", "stop").stderr).toContain("forbids a leading option");
    expect(run("run", "fl-lab-x-1-2", "server", "stop").stderr).toContain("forbids server operations");
    expect(run("run", "fl-lab-x-1-2", "session", "delete", "default").stderr).toContain("forbids session lifecycle");
    expect(calls()).toEqual([]);
    expect(run("run", "fl-lab-x-1-2", "session", "list").code).toBe(0);
  });

  test("provision then teardown removes the lab session and passes the tripwire when the default session is unchanged", () => {
    const { run, dir } = lab();
    expect(run("provision", "fl-lab-x-1-2").code).toBe(0);
    const tripwire = join(dir, "state", "fl-lab-x-1-2.fleet-state.json");
    expect(JSON.parse(readFileSync(tripwire, "utf8"))).toEqual(DEFAULT_SESSION);
    const teardown = run("teardown", "fl-lab-x-1-2");
    expect(teardown.stderr).toBe("");
    expect(teardown.code).toBe(0);
    expect(existsSync(tripwire)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")).sessions).toEqual([DEFAULT_SESSION]);
  });

  test("teardown fails loudly when the default session changed during lab work", () => {
    const { run, setSessions, dir } = lab();
    expect(run("provision", "fl-lab-x-1-2").code).toBe(0);
    const sessions = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")).sessions as object[];
    setSessions(sessions.map((s) => ((s as { name: string }).name === "default" ? { ...DEFAULT_SESSION, socket_path: "/tmp/moved.sock" } : s)));
    const teardown = run("teardown", "fl-lab-x-1-2");
    expect(teardown.code).not.toBe(0);
    expect(teardown.stderr).toContain("FLEET-STATE TRIPWIRE FAILED");
  });

  test("stop and teardown refuse a session this helper never provisioned (no tripwire)", () => {
    const { run, calls } = lab();
    expect(run("stop", "fl-lab-x-1-2").stderr).toContain("missing fleet-state tripwire");
    expect(run("teardown", "fl-lab-x-1-2").stderr).toContain("missing fleet-state tripwire");
    expect(calls()).toEqual([]);
  });

  test("provision refuses when there is no single running default session to record", () => {
    const { run, setSessions } = lab();
    setSessions([]);
    const out = run("provision", "fl-lab-x-1-2");
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("requires exactly one running default session");
  });
});
