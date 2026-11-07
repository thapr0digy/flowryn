/**
 * The per-test timeout for test/integration (docs/notes/2026-11-07-fix-integration-tests-bq.md).
 *
 * Integration tests start real daemons and wait on them with `waitUntil` deadlines of up to 30 s.
 * Bun's 5 s default fails such a test on a loaded host before its own wait does, so every
 * integration file calls `useIntegrationTimeout()` at its top level. Bun scopes
 * `setDefaultTimeout` to the file whose top-level code calls it (a preload, or a call in a
 * helper's module body, reaches only the first file that loads it), and the call beats
 * `--timeout`. A test that sets its own timeout keeps it. Unit tests keep bun's default.
 */
import { setDefaultTimeout } from "bun:test";

/** Above the longest inner wait of any integration test that relies on the default (30 s). */
export const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

/** Give every test in the calling file INTEGRATION_TEST_TIMEOUT_MS; call it at the file's top level. */
export function useIntegrationTimeout(): void {
  setDefaultTimeout(INTEGRATION_TEST_TIMEOUT_MS);
}
