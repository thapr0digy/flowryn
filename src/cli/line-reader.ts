import { createInterface, type Interface } from "node:readline";

/**
 * Line input for interactive prompts that keeps type-ahead: lines that arrive
 * before a question is asked are queued, not dropped. `next` resolves null at
 * end of input, so a caller can abort instead of silently taking defaults.
 */
export class LineReader {
  private readonly rl: Interface;
  private readonly queued: string[] = [];
  private readonly waiting: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(input: NodeJS.ReadableStream) {
    this.rl = createInterface({ input, terminal: false });
    this.rl.on("line", (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiting.splice(0)) waiter(null);
    });
  }

  next(): Promise<string | null> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  close(): void {
    this.rl.close();
  }
}
