import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePaneShell, paneEvidence, paneShellScript, paneTail, TAIL_LINE_CHARS, TAIL_LINES } from "../../src/lifecycle/pane-shell.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-pane-shell-"));
  dirs.push(dir);
  return dir;
}

/**
 * Type `input` into the pane shell as Herdr would, from a pipe, under an
 * environment whose every startup file reads one line from the terminal (an
 * update prompt eating typeahead) and says so.
 */
function typeInto(userShell: string | null, input: string): { stdout: string; stderr: string } {
  const dir = scratch();
  const eater = 'IFS= read -r eaten; echo "rc-ate:$eaten"\n';
  for (const rc of [".profile", ".shrc", ".bashrc", ".bash_profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", "env-rc"]) writeFileSync(join(dir, rc), eater);
  const shell = ensurePaneShell(dir, userShell);
  const result = Bun.spawnSync([shell], {
    cwd: dir,
    stdin: new TextEncoder().encode(input),
    env: { PATH: "/usr/bin:/bin", HOME: dir, ZDOTDIR: dir, ENV: join(dir, "env-rc"), BASH_ENV: join(dir, "env-rc"), SHELL: shell, FLOWRYN_RUN: "r1" },
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("the worker pane shell", () => {
  test("assumption: a non-login interactive /bin/sh with ENV and BASH_ENV dropped reads no startup file, so the first typed line arrives whole", () => {
    const { stdout } = typeInto("/bin/zsh", 'echo "typed:$FLOWRYN_RUN"\nexit\n');
    expect(stdout).toContain("typed:r1");
    expect(stdout).not.toContain("rc-ate");
  });

  test("the harness sees the user's login shell in SHELL, not the pane shell, even one with a quote in its path", () => {
    expect(typeInto("/opt/it's/zsh", 'echo "shell:$SHELL"\nexit\n').stdout).toContain("shell:/opt/it's/zsh");
    // With no login shell known the pane shell's own path is dropped (bash then fills SHELL in from the account itself).
    expect(paneShellScript(null)).toContain("unset SHELL\n");
    expect(typeInto(null, 'echo "shell:$SHELL"\nexit\n').stdout).not.toContain("pane-shell");
  });

  test("the script is written 0700 and rewritten only when its text changes", () => {
    const dir = scratch();
    const path = ensurePaneShell(dir, "/bin/zsh");
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe(paneShellScript("/bin/zsh"));
    const before = statSync(path).mtimeMs;
    ensurePaneShell(dir, "/bin/zsh");
    expect(statSync(path).mtimeMs).toBe(before);
    ensurePaneShell(dir, "/bin/bash");
    expect(readFileSync(path, "utf8")).toContain("SHELL='/bin/bash'");
  });
});

describe("a launch failure's pane tail", () => {
  test("names the shell's error from the last non-empty lines, joined on one line", () => {
    expect(paneTail("\n[oh-my-zsh] Would you like to update? [Y/n]\n\nzsh: no such file or directory: Users/me/claude\n\n")).toBe(
      "[oh-my-zsh] Would you like to update? [Y/n] | zsh: no such file or directory: Users/me/claude",
    );
  });

  test(`keeps at most ${TAIL_LINES} lines of at most ${TAIL_LINE_CHARS} characters`, () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(400)}`);
    const parts = paneTail(lines.join("\n"))!.split(" | ");
    expect(parts).toHaveLength(TAIL_LINES);
    expect(parts[0]!.startsWith("line 14 ")).toBe(true);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TAIL_LINE_CHARS);
  });

  test("redacts secrets on the whole line before cutting it, and drops control characters", () => {
    const tail = paneTail(`export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n\u001b[31mred\u0007 text`)!;
    expect(tail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(tail).toContain("[redacted]");
    expect(tail).toEndWith("red text");
  });

  test("says why there is no tail: a blank pane, a gone pane, an unreadable one", () => {
    expect(paneTail(" \n\n")).toBeNull();
    expect(paneEvidence("\n")).toBe("; the pane showed nothing");
    expect(paneEvidence(null)).toBe("; its pane is gone");
    expect(paneEvidence(new Error("Herdr pane.read did not answer within 15000 ms"))).toBe("; its pane could not be read (Herdr pane.read did not answer within 15000 ms)");
    expect(paneEvidence("zsh: command not found: laude")).toBe("; the pane's last lines: zsh: command not found: laude");
  });
});
