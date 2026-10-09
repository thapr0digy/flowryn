import { appendFileSync } from "node:fs";

/**
 * What the contract fakes (fake-contract-claude.ts, fake-contract-pi.ts)
 * share: the contract's shell commands, run the way a model's Bash tool would,
 * except that `perl -e 'sleep N'` lasts N tenths of a second. It is still a
 * real `perl -e sleep N` child of the fake (the command line ps shows for the
 * live tool), so the suite's process-table wait sees it running. The suite's
 * 25, 60 and 120 second commands then take 2.5, 6 and 12 seconds: still
 * longer than the urgent steer's 3 s cut, so every step sees the same
 * order of events as a live run.
 */
export const SLEEP_MS_PER_SECOND = 100;

/** A contract `perl -e 'sleep N'` command: the seconds it asks for and the milliseconds it lasts here, or null for any other command. */
export function contractSleep(command: string): { seconds: number; ms: number } | null {
  const match = /^perl -e 'sleep (\d+)'$/.exec(command.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  return { seconds, ms: seconds * SLEEP_MS_PER_SECOND };
}

/** One Bash tool call in flight: `abort` (an interrupt, an abort) ends it early. */
export class ToolCall {
  private stop: (() => void) | null = null;
  aborted = false;

  abort(): void {
    this.aborted = true;
    this.stop?.();
  }

  /**
   * Run a contract shell command; resolves with its exit code (130 when aborted).
   * A contract sleep runs as a real `perl -e sleep N` process, killed once its
   * scaled time is up (exit 0) or on abort (exit 130).
   */
  run(command: string, env: Record<string, string | undefined>, cwd: string): Promise<number> {
    const sleep = contractSleep(command);
    if (sleep !== null) {
      const proc = Bun.spawn(["perl", "-e", `sleep ${sleep.seconds}`], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return new Promise((resolve) => {
        const finish = (code: number) => {
          clearTimeout(timer);
          proc.kill("SIGKILL");
          resolve(code);
        };
        const timer = setTimeout(() => finish(0), sleep.ms);
        this.stop = () => finish(130);
      });
    }
    const proc = Bun.spawn(["sh", "-c", command], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    this.stop = () => proc.kill("SIGINT");
    return proc.exited;
  }
}

export function logLine(who: string, message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${who}: ${message}\n`);
}

/** Append one JSON line (a transcript record). */
export function appendJson(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify(value) + "\n");
}
