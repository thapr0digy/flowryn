import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { ensureDir } from "../util/fsx.ts";
import { redactSecrets } from "../util/redact.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * A worker pane's shell. Herdr's agent.start types the harness command into
 * the pane's shell, and Herdr 0.7.5 starts that shell from the `SHELL` in
 * workspace.create's env (spike h08). The user's own interactive shell runs
 * their rc files first, and anything there that reads the terminal eats the
 * typed command: oh-my-zsh's "Would you like to update? [Y/n]" took its first
 * character, so `/Users/…/claude` ran as `Users/…/claude` (seen 2026-10-17).
 * So the launcher names this script as the pane's shell instead: it puts the
 * user's login shell back in `SHELL` for the harness (Claude's Bash tool
 * reads it), drops `ENV` and `BASH_ENV`, and becomes an interactive `/bin/sh`,
 * which as a non-login shell reads no startup file. The environment Flowryn
 * builds (PATH included) reaches it, and the harness, unchanged, except the
 * names a launch lists in FLOWRYN_UNSET (variable names only): a pane's
 * environment can only set values, and an account's login needs some unset
 * outright (src/harness/claude/adapter.ts loginEnv).
 */
export function paneShellScript(userShell: string | null): string {
  const restore = userShell ? `SHELL=${shellQuoted(userShell)}\nexport SHELL\n` : "unset SHELL\n";
  const unsetListed = `for name in $FLOWRYN_UNSET; do\n  case "$name" in *[!A-Za-z0-9_]*|[0-9]*) ;; *) unset "$name" ;; esac\ndone\nunset FLOWRYN_UNSET\n`;
  return `#!/bin/sh\n# Flowryn's worker pane shell: no rc files, so nothing reads the terminal before Herdr types the launch.\n${restore}${unsetListed}unset ENV BASH_ENV\nexec /bin/sh -i\n`;
}

/** The user's login shell: the daemon's SHELL, else the account's. */
export function loginShell(): string | null {
  if (process.env.SHELL) return process.env.SHELL;
  try {
    return userInfo().shell || null;
  } catch {
    return null;
  }
}

/** Write the pane shell under `stateDir` (again only when its text changed) and return its path. */
export function ensurePaneShell(stateDir: string, userShell: string | null = loginShell()): string {
  ensureDir(stateDir, 0o700);
  const path = join(stateDir, "pane-shell");
  const script = paneShellScript(userShell);
  if (!existsSync(path) || readFileSync(path, "utf8") !== script) writeFileSync(path, script, { mode: 0o700 });
  return path;
}

/**
 * The harness shim: `<stateDir>/shims/<harness>`, first on the pane's PATH,
 * so the name agent.start types runs the binary Flowryn resolved (the version
 * the contract gate checked) whatever the shell would otherwise find. It is a
 * symlink, not a script that execs the binary: Herdr names a pane's agent from
 * its foreground process's argv0, and an exec'd binary carries its own path
 * there (`2.1.308` for a Claude install), so Herdr found no agent and read the
 * status "unknown", which refuses the interrupt an urgent steer's cut needs.
 * Through a symlink the process keeps the typed name. A symlink runs nothing
 * of its own, so FLOWRYN_UNSET is the pane shell's job (paneShellScript).
 * Replaced atomically, and only when it points elsewhere; returns the shim
 * directory.
 */
export function ensureHarnessShim(stateDir: string, harness: string, binary: string): string {
  const dir = join(stateDir, "shims");
  ensureDir(dir, 0o700);
  const link = join(dir, harness);
  const target = resolve(binary);
  if (pointsAt(link, target)) return dir;
  const temp = `${link}.${process.pid}.${Date.now()}`;
  symlinkSync(target, temp);
  try {
    renameSync(temp, link);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return dir;
}

function pointsAt(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && readlinkSync(link) === target;
  } catch {
    return false;
  }
}

function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How many lines of a pane a launch failure reads. */
export const TAIL_READ_LINES = 40;

/** How many of a pane's last non-empty lines a launch failure quotes, each at most TAIL_LINE_CHARS. */
export const TAIL_LINES = 6;
export const TAIL_LINE_CHARS = 200;

/**
 * A pane's last lines for a launch failure, one line: secrets redacted (on
 * the whole lines, before any cut), control characters dropped, each line
 * bounded, joined with " | ". Null when the pane shows nothing.
 */
export function paneTail(text: string): string | null {
  const lines = redactSecrets(text)
    .split("\n")
    .map((line) => sanitizeLine(line, TAIL_LINE_CHARS))
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.slice(-TAIL_LINES).join(" | ") : null;
}

/** What a launch failure adds about its pane: its last lines, or why there are none. */
export function paneEvidence(screen: string | null | Error): string {
  if (screen instanceof Error) return `; its pane could not be read (${sanitizeLine(screen.message, TAIL_LINE_CHARS)})`;
  if (screen === null) return "; its pane is gone";
  const tail = paneTail(screen);
  return tail ? `; the pane's last lines: ${tail}` : "; the pane showed nothing";
}
