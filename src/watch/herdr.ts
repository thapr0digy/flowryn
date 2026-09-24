import type { Subscription } from "../runtime/herdr/client.ts";
import { eventPaneId, type HerdrRuntime } from "../runtime/herdr/runtime.ts";

export interface HerdrWatcherDeps {
  runtime(): HerdrRuntime | null;
  /**
   * No runtime yet (Herdr was not running when the daemon started, so no
   * socket was found): look for it again; whether one exists now.
   */
  resolve?(): Promise<boolean>;
  /** A pane named by an event: re-read it (events carry no revision, M0 h01). */
  onPane(paneId: string): void;
  /** The subscription (re)started: reconcile every run (design section 6, steps 4-7 on every reconnect). */
  onConnected(first: boolean): void;
  /** Herdr did not answer the subscription (design section 16: detected by socket errors); it is retried with backoff. */
  onDown?(reason: string): void;
  log(message: string): void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * The Herdr event subscription (a watcher: it emits observations to the
 * reconciler and writes nothing). Herdr's stream has no replay, so on every
 * (re)connect the reconciler takes a fresh look at every run instead of
 * trusting what it missed. A failure is reported and retried with backoff,
 * never in a tight loop.
 */
export class HerdrWatcher {
  private readonly deps: HerdrWatcherDeps;
  private subscription: Subscription | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectedOnce = false;

  constructor(deps: HerdrWatcherDeps) {
    this.deps = deps;
  }

  start(): Promise<void> {
    return this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.subscription?.close();
    this.subscription = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let runtime = this.deps.runtime();
    if (!runtime && this.deps.resolve && (await this.deps.resolve().catch(() => false))) runtime = this.deps.runtime();
    if (!runtime) return this.retry("no Herdr socket");
    try {
      this.subscription = await runtime.subscribe(
        (event) => {
          const pane = eventPaneId(event);
          if (pane) this.deps.onPane(pane);
        },
        (error) => {
          this.subscription = null;
          if (!this.stopped) this.retry(error ? error.message : "subscription closed");
        },
      );
    } catch (error) {
      return this.retry((error as Error).message);
    }
    const first = !this.connectedOnce;
    this.connectedOnce = true;
    this.attempt = 0;
    this.deps.onConnected(first);
  }

  private retry(reason: string): void {
    if (this.stopped || this.timer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    if (this.attempt === 0) this.deps.log(`herdr: event subscription down (${reason}); retrying`);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    try {
      this.deps.onDown?.(reason);
    } catch (error) {
      this.deps.log(`herdr: recording the outage failed: ${(error as Error).stack ?? String(error)}`);
    }
  }
}
