import { appendFileSync } from "node:fs";

/**
 * What the contract fakes (fake-contract-claude.ts, fake-contract-pi.ts)
 * share: the contract's shell commands, run the way a model's Bash tool would,
 * except that `perl -e 'sleep N'` sleeps N tenths of a second. The suite's
 * 25, 60 and 120 second commands then take 2.5, 6 and 12 seconds: still
 * longer than the urgent steer's 3 s cut and the interrupt step's 3 s wait,
 * so every step sees the same order of events as a live run.
 */
export const SLEEP_MS_PER_SECOND = 100;

/** The milliseconds a contract `perl -e 'sleep N'` command sleeps here, or null for any other command. */
export function contractSleepMs(command: string): number | null {
  const match = /^perl -e 'sleep (\d+)'$/.exec(command.trim());
  return match ? Number(match[1]) * SLEEP_MS_PER_SECOND : null;
}

/** One Bash tool call in flight: `abort` (an interrupt, an abort) ends it early. */
export class ToolCall {
  private stop: (() => void) | null = null;
  aborted = false;

  abort(): void {
    this.aborted = true;
    this.stop?.();
  }

  /** Run a contract shell command; resolves with its exit code (130 when aborted). */
  run(command: string, env: Record<string, string | undefined>, cwd: string): Promise<number> {
    const ms = contractSleepMs(command);
    if (ms !== null) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(0), ms);
        this.stop = () => {
          clearTimeout(timer);
          resolve(130);
        };
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
