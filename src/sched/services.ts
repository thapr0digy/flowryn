import type { HostVerdict } from "./host.ts";

/**
 * What the M5 verbs need from the running daemon's scheduler: a nudge after a
 * change that may free or need capacity, and a pass awaited when the reply
 * should say whether the run started. Handlers get it as `ctx.sched`; tests
 * without a daemon use `inertSched()`.
 */
export interface SchedServices {
  /** Look at the queue soon (debounced). */
  kick(): void;
  /** Record the waits on you or the leader soon (debounced), without a whole pass: after any mutation (src/attention/human-waits.ts). */
  explainWaits(): void;
  /** One pass now, serialized with every other. */
  passNow(): Promise<void>;
  /**
   * One pass now for a run whose worker waits on the reply (a delivery that
   * needs its pooled stage): a grant in it carries no steer. Resolves whether
   * the run's stage is now active.
   */
  grantNow(runId: string): Promise<boolean>;
  /** The scheduler's host check (cached like its own grants'), for heavy work outside a run: a verify. */
  host(): Promise<HostVerdict>;
}

export function inertSched(overrides: Partial<SchedServices> = {}): SchedServices {
  return { kick: () => {}, explainWaits: () => {}, passNow: async () => {}, grantNow: async () => false, host: async () => ({ ok: true, sample: null, reason: "ok" }), ...overrides };
}
