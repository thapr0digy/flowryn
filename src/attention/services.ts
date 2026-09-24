import { DEFAULT_LEADER_TIMING, DEFAULT_NOTIFY, type LeaderTiming, type NotifyConfig } from "../config/leader.ts";
import { SteerBus } from "../lifecycle/steers.ts";
import type { PsRunner } from "../runtime/proc.ts";

/**
 * What the leader hooks and attention verbs need from the running daemon
 * beyond the database: the leader waiters, the leader clocks and the
 * notification pump. Handlers get it as `ctx.attention`; tests without a
 * daemon use `inertAttention()`.
 */
export interface AttentionServices {
  /**
   * Leader waiters, keyed by leader session: the Claude asyncRewake waiter and
   * the Pi extension's long poll. The database stays the truth; the bus only
   * says "look again", and a newer waiter supersedes older ones.
   */
  bus: SteerBus;
  timing(): LeaderTiming;
  notify(): NotifyConfig;
  /** Ask the notification pump to run now. */
  kick(): void;
  ps?: PsRunner;
  /** A Claude leader's transcript size at its turn start, for the fast interrupt check (M0 finding 6). */
  turnOffsets: Map<string, number>;
}

export function inertAttention(overrides: Partial<AttentionServices> = {}): AttentionServices {
  return {
    bus: new SteerBus(),
    timing: () => DEFAULT_LEADER_TIMING,
    notify: () => DEFAULT_NOTIFY,
    kick: () => {},
    turnOffsets: new Map(),
    ...overrides,
  };
}
