import { SERVER_VERBS } from "../api/registry.ts";
import type { VerbSpec } from "../api/verbs.ts";
import { DAEMON_VERBS } from "./commands/daemon.ts";
import { SETUP_VERBS } from "./commands/setup.ts";

/**
 * The one command registry (design section 12): every verb the CLI accepts,
 * whether the daemon serves it or it runs locally. Socket verbs whose names
 * contain a dot are internal (the handshake, stop) and never parsed from argv.
 */
export const CLI_VERBS: readonly VerbSpec[] = [...SERVER_VERBS.filter((v) => !v.name.includes(".")), ...DAEMON_VERBS, ...SETUP_VERBS];
