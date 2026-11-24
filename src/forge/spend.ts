import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the daemon spends of GitHub's rate limit, by caller: each request is
 * counted under the caller that made it (asForgeCaller around its work,
 * "other" outside one), and once an hour has passed the next request writes
 * one line per caller to the daemon log: requests, 304s and the latest
 * x-ratelimit-remaining GitHub sent. The tally lives in memory; a restart or
 * a forge rebuilt for new [github] config starts a new hour.
 */

export const SPEND_WINDOW_MS = 60 * 60_000;

const caller = new AsyncLocalStorage<string>();

/** Run `work` with its GitHub requests counted under `name`. */
export function asForgeCaller<T>(name: string, work: () => Promise<T>): Promise<T> {
  return caller.run(name, work);
}

export function forgeCaller(): string {
  return caller.getStore() ?? "other";
}

export interface Tally {
  requests: number;
  notModified: number;
  /** x-ratelimit-remaining from the caller's latest answer that carried it. */
  remaining: number | null;
}

export class SpendLog {
  private start: number | null = null;
  private readonly tallies = new Map<string, Tally>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number,
  ) {}

  /** A request is going out for `who`: its tally, to note the answer on. Closes the hour first when one has passed. */
  sent(who: string): Tally {
    this.roll();
    let tally = this.tallies.get(who);
    if (!tally) {
      tally = { requests: 0, notModified: 0, remaining: null };
      this.tallies.set(who, tally);
    }
    tally.requests++;
    return tally;
  }

  private roll(): void {
    const now = this.now();
    if (this.start === null) {
      this.start = now;
      return;
    }
    if (now - this.start < SPEND_WINDOW_MS) return;
    for (const who of [...this.tallies.keys()].toSorted()) this.log(spendLine(who, this.tallies.get(who)!, this.start, now));
    this.tallies.clear();
    this.start = now;
  }
}

export function spendLine(who: string, tally: Tally, from: number, to: number): string {
  const remaining = tally.remaining === null ? "not sent" : String(tally.remaining);
  return `github spend: ${who} ${tally.requests} requests, ${tally.notModified} not modified (304), rate limit remaining ${remaining}, ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`;
}
