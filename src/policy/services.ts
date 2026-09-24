import { DEFAULT_GITHUB, type GitHubConfig } from "../config/delivery.ts";
import { GitHubForge } from "../forge/github.ts";
import type { Forge } from "../forge/types.ts";
import type { CleanupReport, CleanupRequestOptions } from "../lifecycle/landing.ts";
import { ChallengeStore } from "./approvals.ts";
import { gitRunner } from "./git.ts";
import type { GitRunner } from "./landed.ts";

/**
 * What the M4 verbs need from the running daemon beyond the database: the
 * forge, git with a timeout long enough for a fetch, the pending /dev/tty
 * challenges, the cleanup runner (serialized per run) and a nudge for the
 * delivery watchers. Handlers get it as `ctx.delivery`; tests without a
 * daemon use `inertDelivery()`.
 */
export interface DeliveryServices {
  forge(): Forge;
  github(): GitHubConfig;
  git: GitRunner;
  challenges: ChallengeStore;
  /** Clean up a run's worktree; concurrent requests for one run share the same attempt. */
  cleanup(runId: string, opts: CleanupRequestOptions): Promise<CleanupReport>;
  /** Ask the GitHub and no-mistakes watchers to look at a run (or every run) now. */
  watch(runId?: string): void;
  /** Merge requests this daemon is executing, so a replayed call never asks GitHub twice. */
  inFlight: Set<string>;
}

export function inertDelivery(overrides: Partial<DeliveryServices> = {}): DeliveryServices {
  return {
    forge: () => new GitHubForge({ apiUrl: "http://127.0.0.1:9", webUrl: DEFAULT_GITHUB.web_url, token: async () => null, timeoutMs: 1_000 }),
    github: () => DEFAULT_GITHUB,
    git: gitRunner(Bun.which("git") ?? "git"),
    challenges: new ChallengeStore(),
    cleanup: async () => {
      throw new Error("no cleanup runner in this context");
    },
    watch: () => {},
    inFlight: new Set(),
    ...overrides,
  };
}
