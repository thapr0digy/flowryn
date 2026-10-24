/**
 * The daemon's shutdown order: background work it started (a pass from a
 * timer, a notification tick) is tracked here, and the database is closed
 * only once every piece has ended. A pass that outlives the grace keeps the
 * database open instead: the process exits right after, and a late query on
 * an open database is harmless where one on a closed database throws.
 */

/** Background work the daemon started from a timer and must let finish before it closes the database. */
export class InFlight {
  private readonly pending = new Set<Promise<unknown>>();

  /** Track a piece of work; returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const forget = () => this.pending.delete(work);
    work.then(forget, forget);
    return work;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves once nothing tracked is running, including work started while waiting. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }
}

/** One thing shutdown waits for, named for the log line when it outlives the grace. */
export interface Draining {
  name: string;
  done: Promise<unknown>;
}

/** Wait for every piece within the grace; returns the names still running when it ran out (empty: all ended). */
export async function settleWithin(pieces: readonly Draining[], graceMs: number): Promise<string[]> {
  const running = new Set(pieces.map((p) => p.name));
  const all = Promise.all(
    pieces.map((p) =>
      p.done.then(
        () => running.delete(p.name),
        () => running.delete(p.name),
      ),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const graceOver = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  await Promise.race([all, graceOver]);
  if (timer) clearTimeout(timer);
  return pieces.map((p) => p.name).filter((name) => running.has(name));
}
