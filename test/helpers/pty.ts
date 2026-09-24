import { closeSync, constants, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A command in a real pseudo-terminal, for the human-only verbs that insist
 * on one: `flowryn approve` reads its code from /dev/tty and the board reads
 * raw keys. macOS's script(1) gives the child a pty; what the test writes is
 * what you would type, and script's output is the screen.
 *
 * script refuses a socket on its stdin (tcgetattr fails with "Operation not
 * supported on socket"), and Bun's stdin pipe is a socketpair, as is a FIFO
 * on macOS. So the keystrokes go into a FIFO that `cat` copies onto a real
 * pipe (bash process substitution). Everything runs in its own process
 * group, killed as one.
 */

// Matching escape sequences is the point.
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

export class Pty {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly dir: string;
  private readonly fifo: string;
  private fd: number | null = null;
  private screen = "";
  readonly exited: Promise<number>;

  private constructor(proc: ReturnType<typeof Bun.spawn>, dir: string, fifo: string) {
    this.proc = proc;
    this.dir = dir;
    this.fifo = fifo;
    this.exited = proc.exited;
    const decoder = new TextDecoder();
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.screen += decoder.decode(value, { stream: true });
      }
    })();
  }

  static spawn(argv: string[], env: Record<string, string>, cwd: string): Pty {
    const dir = mkdtempSync(join(tmpdir(), "fw-pty-"));
    const fifo = join(dir, "keys");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
    // script is the process the test waits on (exec), its stdin a real pipe from `cat` of the FIFO.
    const proc = Bun.spawn(["perl", "-e", "setpgrp(0, 0); exec @ARGV", "bash", "-c", 'exec script -q /dev/null "$@" < <(cat "$0")', fifo, ...argv], {
      env,
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new Pty(proc, dir, fifo);
  }

  /** What the screen showed so far, escape sequences removed. */
  text(): string {
    return this.screen.replace(ANSI, "");
  }

  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(this.text());
      if (match) return match;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} on the pty; it showed:\n${this.text().slice(-1_500)}`);
      await Bun.sleep(50);
    }
  }

  /** Type into the terminal (the FIFO opens once `cat` reads it). */
  async type(text: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (this.fd === null) {
      try {
        this.fd = openSync(this.fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() > deadline) throw error;
        await Bun.sleep(20);
      }
    }
    writeSync(this.fd, text);
  }

  kill(): void {
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
