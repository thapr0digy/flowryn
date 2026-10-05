/**
 * What the verbs need from the daemon's Lavish poller: a nudge after a change
 * to a review gate or its questions, so the widget beside the page is
 * rewritten and the polls follow the open gates. Handlers get it as
 * `ctx.lavish`; tests without a daemon use `inertLavish()`.
 */
export interface LavishServices {
  /** Look at the gates soon: rewrite changed widgets, start and stop polls. */
  kick(): void;
}

export function inertLavish(overrides: Partial<LavishServices> = {}): LavishServices {
  return { kick: () => {}, ...overrides };
}
