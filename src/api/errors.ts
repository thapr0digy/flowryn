import type { NewEvent } from "../db/events.ts";

/**
 * Exit codes from design section 12. Every error code maps to exactly one of
 * them, so scripts and agents can branch on the exit status alone.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  policy: 2,
  validation: 3,
  notFound: 4,
  unavailable: 69,
  spooled: 75,
  protocol: 76,
  role: 77,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Stable machine codes. Adding one is fine; renaming one breaks callers. Kept
 * in alphabetical order (a unit test checks), so codes added by parallel PRs
 * land at different lines instead of all at the end of one group.
 */
export const ERROR_CODES = {
  already_exists: EXIT.validation,
  already_running: EXIT.failure,
  approval_required: EXIT.policy,
  bad_args: EXIT.validation,
  bad_envelope: EXIT.validation,
  bad_token: EXIT.role,
  binary_broken: EXIT.policy,
  blockers_not_landed: EXIT.policy,
  challenge_failed: EXIT.validation,
  checks_pending: EXIT.policy,
  cleanup_refused: EXIT.policy,
  config_invalid: EXIT.failure,
  contract_unverified: EXIT.policy,
  daemon_unavailable: EXIT.unavailable,
  delivery_refused: EXIT.policy,
  forge_unavailable: EXIT.failure,
  fork_pr: EXIT.policy,
  // a chat-answer grant names another item or choice than the command
  grant_mismatch: EXIT.policy,
  // flowryn drop: the task still blocks others
  has_dependents: EXIT.policy,
  head_mismatch: EXIT.policy,
  head_moved: EXIT.policy,
  head_not_on_remote: EXIT.policy,
  herdr_unavailable: EXIT.failure,
  human_only: EXIT.role,
  internal: EXIT.failure,
  interrupt_refused: EXIT.policy,
  invalid_project: EXIT.validation,
  invalid_report: EXIT.validation,
  invalid_todo: EXIT.validation,
  merge_in_flight: EXIT.policy,
  merge_refused: EXIT.policy,
  // heavy work outside a run (a verify) refused: its pool is full or the host check fails
  no_capacity: EXIT.policy,
  no_change: EXIT.policy,
  // `flowryn back` with no away to end and no recent brief to reprint
  not_away: EXIT.validation,
  // a project with no [projects.<id>] verify steps
  not_configured: EXIT.validation,
  not_fast_forward: EXIT.policy,
  not_found: EXIT.notFound,
  // a leader contract record from a build the daemon does not run
  not_installed_build: EXIT.policy,
  not_landed: EXIT.policy,
  not_leader: EXIT.role,
  not_ready: EXIT.policy,
  not_supervised: EXIT.policy,
  not_supported: EXIT.validation,
  // a delivery or merge whose reads were overtaken by a newer change to the run (docs/notes/2026-10-13-next-steps-md-av.md)
  observation_stale: EXIT.policy,
  // flowryn drop: a phase of the plan has started
  phase_started: EXIT.policy,
  plist_drift: EXIT.policy,
  pr_closed: EXIT.policy,
  pr_draft: EXIT.policy,
  primary_checkout_tangle: EXIT.policy,
  protocol_mismatch: EXIT.protocol,
  qa_page_invalid: EXIT.validation,
  // a review gate whose own questions are still open
  questions_open: EXIT.policy,
  red_checks: EXIT.policy,
  rejected_by_tasks_axi: EXIT.validation,
  reserved_decision: EXIT.policy,
  restart_blocked: EXIT.policy,
  restart_cooldown: EXIT.policy,
  restart_dropped: EXIT.policy,
  restart_in_progress: EXIT.policy,
  // a review URL that is not lavish's page for the review page (Q3)
  review_invalid: EXIT.validation,
  role_refused: EXIT.role,
  run_not_active: EXIT.validation,
  stage_waiting: EXIT.policy,
  // flowryn drop: the task has landed
  task_landed: EXIT.policy,
  // flowryn drop: the task has started
  task_started: EXIT.policy,
  tool_missing: EXIT.failure,
  unknown_verb: EXIT.validation,
  verify_busy: EXIT.policy,
  verify_failed: EXIT.policy,
  // a project with verify steps merges only on a passing verify of exactly the head, and none has finished there
  verify_required: EXIT.policy,
  // a local verify at this head ran under another verify policy than today's (or none recorded)
  verify_stale: EXIT.policy,
  worker_token: EXIT.role,
  // flowryn drop: the task keeps a worktree
  worktree_kept: EXIT.policy,
  wrong_stage: EXIT.policy,
} as const satisfies Record<string, ExitCode>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function exitCodeFor(code: string): ExitCode {
  return (ERROR_CODES as Record<string, ExitCode>)[code] ?? EXIT.failure;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  help?: string;
}

/** An expected, user-facing failure. Anything else thrown is reported as `internal`. */
export class FlowrynError extends Error {
  readonly code: ErrorCode;
  readonly help: string | undefined;
  /** An event the gateway appends after the refused apply rolled back, so the refusal itself stays on record. */
  readonly refusalEvent: NewEvent | undefined;

  constructor(code: ErrorCode, message: string, help?: string, refusalEvent?: NewEvent) {
    super(message);
    this.name = "FlowrynError";
    this.code = code;
    this.help = help;
    this.refusalEvent = refusalEvent;
  }

  toBody(): ErrorBody {
    return this.help ? { code: this.code, message: this.message, help: this.help } : { code: this.code, message: this.message };
  }
}

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof FlowrynError) return error.toBody();
  const message = error instanceof Error ? error.message : String(error);
  return { code: "internal", message };
}
