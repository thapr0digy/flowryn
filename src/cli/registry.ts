import { SERVER_VERBS } from "../api/registry.ts";
import type { VerbSpec } from "../api/verbs.ts";
import { DAEMON_VERBS } from "./commands/daemon.ts";
import { SETUP_VERBS } from "./commands/setup.ts";
import { HOOK_CLI_VERBS } from "./commands/hook.ts";
import { LEAD_VERBS } from "./commands/lead.ts";
import { BOARD_VERBS } from "./commands/board.ts";
import { APPROVE_VERBS } from "./commands/approve.ts";
import { IMPORT_VERBS } from "./commands/import.ts";

/**
 * The one command registry (design section 12): every verb the CLI accepts,
 * whether the daemon serves it or it runs locally. Socket verbs whose names
 * contain a dot are internal (the handshake, stop) and never parsed from argv.
 */
export const CLI_VERBS: readonly VerbSpec[] = [
  ...SERVER_VERBS.filter((v) => !v.name.includes(".")),
  ...DAEMON_VERBS,
  ...SETUP_VERBS,
  ...HOOK_CLI_VERBS,
  ...LEAD_VERBS,
  ...BOARD_VERBS,
  ...APPROVE_VERBS,
  ...IMPORT_VERBS,
];
