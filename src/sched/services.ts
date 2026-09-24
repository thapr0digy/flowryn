/**
 * What the M5 verbs need from the running daemon's scheduler: a nudge after a
 * change that may free or need capacity, and a pass awaited when the reply
 * should say whether the run started. Handlers get it as `ctx.sched`; tests
 * without a daemon use `inertSched()`.
 */
export interface SchedServices {
  /** Look at the queue soon (debounced). */
  kick(): void;
  /** One pass now, serialized with every other. */
  passNow(): Promise<void>;
}

export function inertSched(overrides: Partial<SchedServices> = {}): SchedServices {
  return { kick: () => {}, passNow: async () => {}, ...overrides };
}
