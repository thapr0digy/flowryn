import { resolve } from "node:path";
import type { BridgeDriver } from "../../src/contracts/bridge-suite.ts";

const HOST = resolve(import.meta.dir, "fake-pi-host.ts");

export interface FakePiOptions {
  /** The leader extension `flowryn lead --pi` wrote. */
  extensionPath: string;
  env: Record<string, string>;
  cwd: string;
  /** Does the daemon consider you inactive in this session? (goInactive waits for it.) */
  inactive: () => boolean;
  onQuit?: () => Promise<void>;
}

/** The test's handle on a fake Pi process running the real leader extension. */
export class FakePiLeader implements BridgeDriver {
  readonly harness = "pi" as const;
  readonly seen: { text: string; via: string }[] = [];
  private readonly opts: FakePiOptions;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private readonly acks = new Map<number, (error: string | null) => void>();
  private ready: Promise<void> | null = null;

  constructor(opts: FakePiOptions) {
    this.opts = opts;
  }

  session(): string {
    return this.opts.env.FLOWRYN_LEADER_SESSION ?? "";
  }

  private boot(): Promise<void> {
    if (this.ready) return this.ready;
    const proc = Bun.spawn(["bun", HOST, this.opts.extensionPath], { env: this.opts.env, cwd: this.opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.proc = proc;
    this.ready = new Promise<void>((resolveReady, reject) => {
      const decoder = new TextDecoder();
      let buffer = "";
      void (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            let event: { ev: string; id?: number; text?: string; via?: string; error?: string };
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.ev === "ready") resolveReady();
            else if (event.ev === "seen") this.seen.push({ text: event.text ?? "", via: event.via ?? "" });
            else if (event.ev === "ack" && event.id !== undefined) {
              this.acks.get(event.id)?.(event.error ?? null);
              this.acks.delete(event.id);
            }
          }
        }
        for (const ack of this.acks.values()) ack("the fake Pi exited");
        this.acks.clear();
        reject(new Error("the fake Pi exited before it was ready"));
      })();
    });
    return this.ready;
  }

  private async send(cmd: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.boot();
    const id = this.nextId++;
    const acked = new Promise<void>((resolveAck, reject) => this.acks.set(id, (error) => (error ? reject(new Error(error)) : resolveAck())));
    (this.proc!.stdin as import("bun").FileSink).write(JSON.stringify({ id, cmd, ...extra }) + "\n");
    (this.proc!.stdin as import("bun").FileSink).flush();
    await acked;
  }

  async start(): Promise<void> {
    await this.send("start");
  }

  async prompt(label: string): Promise<void> {
    await this.send("prompt", { text: `${label}: reply ok` });
  }

  async promptBusy(label: string): Promise<void> {
    await this.send("prompt_busy", { text: `${label}: run a long command` });
  }

  async finishBusy(): Promise<void> {
    await this.send("finish");
  }

  async typeDraft(text: string): Promise<void> {
    await this.send("type", { text });
  }

  async clearDraft(): Promise<void> {
    await this.send("clear");
  }

  async goInactive(): Promise<void> {
    await this.send("clear");
    const deadline = Date.now() + 15_000;
    while (!this.opts.inactive()) {
      if (Date.now() > deadline) throw new Error("the Pi leader never reported you inactive");
      await Bun.sleep(50);
    }
  }

  async interrupt(): Promise<void> {
    await this.send("interrupt");
  }

  async compact(willRetry = false): Promise<void> {
    await this.send("compact", { willRetry });
  }

  async saw(marker: string): Promise<number> {
    return this.seen.filter((s) => s.text.includes(marker)).length;
  }

  async quit(): Promise<void> {
    await this.send("quit").catch(() => undefined);
    await this.proc?.exited;
    await this.opts.onQuit?.();
  }

  kill(): void {
    this.proc?.kill("SIGKILL");
  }
}
