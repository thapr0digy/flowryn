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

/** Stable machine codes. Adding one is fine; renaming one breaks callers. */
export const ERROR_CODES = {
  // policy refusals
  approval_required: EXIT.policy,
  reserved_decision: EXIT.policy,
  red_checks: EXIT.policy,
  not_landed: EXIT.policy,
  contract_unverified: EXIT.policy,
  primary_checkout_tangle: EXIT.policy,
  // M4: delivery, the merge gate and cleanup
  delivery_refused: EXIT.policy,
  head_moved: EXIT.policy,
  head_mismatch: EXIT.policy,
  checks_pending: EXIT.policy,
  pr_draft: EXIT.policy,
  pr_closed: EXIT.policy,
  head_not_on_remote: EXIT.policy,
  not_fast_forward: EXIT.policy,
  merge_refused: EXIT.policy,
  merge_in_flight: EXIT.policy,
  cleanup_refused: EXIT.policy,
  not_ready: EXIT.policy,
  // daemon restart (leader-safe restart)
  restart_blocked: EXIT.policy,
  restart_cooldown: EXIT.policy,
  restart_in_progress: EXIT.policy,
  no_change: EXIT.policy,
  plist_drift: EXIT.policy,
  not_supervised: EXIT.policy,
  binary_broken: EXIT.policy,
  restart_dropped: EXIT.policy,
  // M5: workflows and autonomy
  wrong_stage: EXIT.policy,
  blockers_not_landed: EXIT.policy,
  stage_waiting: EXIT.policy,
  // a review gate whose own questions are still open
  questions_open: EXIT.policy,
  // steers and interrupts
  interrupt_refused: EXIT.policy,
  // validation
  bad_args: EXIT.validation,
  unknown_verb: EXIT.validation,
  bad_envelope: EXIT.validation,
  invalid_project: EXIT.validation,
  invalid_todo: EXIT.validation,
  already_exists: EXIT.validation,
  rejected_by_tasks_axi: EXIT.validation,
  not_supported: EXIT.validation,
  run_not_active: EXIT.validation,
  invalid_report: EXIT.validation,
  qa_page_invalid: EXIT.validation,
  // `flowryn back` with no away to end and no recent brief to reprint
  not_away: EXIT.validation,
  // not found
  not_found: EXIT.notFound,
  // transport
  daemon_unavailable: EXIT.unavailable,
  protocol_mismatch: EXIT.protocol,
  // roles
  not_leader: EXIT.role,
  worker_token: EXIT.role,
  human_only: EXIT.role,
  bad_token: EXIT.role,
  role_refused: EXIT.role,
  // everything else
  internal: EXIT.failure,
  config_invalid: EXIT.failure,
  already_running: EXIT.failure,
  tool_missing: EXIT.failure,
  herdr_unavailable: EXIT.failure,
  forge_unavailable: EXIT.failure,
  challenge_failed: EXIT.validation,
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

  constructor(code: ErrorCode, message: string, help?: string) {
    super(message);
    this.name = "FlowrynError";
    this.code = code;
    this.help = help;
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
