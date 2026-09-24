/**
 * An in-process async mutex per key. The journal and the backlog watcher share
 * one, so a hash check never interleaves with a journal write to the same file.
 */
export class KeyedMutex<K> {
  private tails = new Map<K, Promise<void>>();
  private held = new Set<K>();

  isHeld(key: K): boolean {
    return this.held.has(key);
  }

  async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    this.held.add(key);
    try {
      return await fn();
    } finally {
      this.held.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
