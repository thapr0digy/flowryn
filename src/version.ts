/** Flowryn release version; kept equal to package.json by a unit test. */
export const VERSION = "0.6.0";

/**
 * Wire protocol version. The CLI sends it on every call and the daemon refuses
 * a mismatch (exit 76), so a stale binary in an old worker never talks past a
 * newer daemon. Bump it on any envelope or verb-argument change.
 */
export const PROTO = 5;

/** tasks-axi version the intent journal was verified against (docs/m0-verdicts.md). */
export const PINNED_TASKS_AXI = "0.2.5";
