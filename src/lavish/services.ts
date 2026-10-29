/**
 * What the verbs need from the daemon's Lavish poller: a nudge after a change
 * to a review gate or its questions, so the widget beside the page is
 * rewritten and the polls follow the open gates, and a worker's review reply
 * shown in its page. Handlers get it as
 * `ctx.lavish`; tests without a daemon use `inertLavish()`.
 */
export interface LavishServices {
  /** Look at the gates soon: rewrite changed widgets, start and stop polls. */
  kick(): void;
  /** Show a worker's reply in a gate's page: shown, queued for the next poll, or off (no lavish-axi). */
  reply(gate: string, page: string, text: string): Promise<"shown" | "queued" | "off">;
}

export function inertLavish(overrides: Partial<LavishServices> = {}): LavishServices {
  return { kick: () => {}, reply: async () => "off", ...overrides };
}
