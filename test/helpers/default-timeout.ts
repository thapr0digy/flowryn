/**
 * Loaded before every test file (bunfig.toml `[test] preload`): a test with
 * no timeout of its own gets DEFAULT_TEST_TIMEOUT_MS, not bun's 5 s.
 * Integration tests start daemons and run the real tasks-axi, and CI runners
 * are slower than laptops. bun test 1.3 ignores a `timeout` key in
 * bunfig.toml's `[test]` table (only `--timeout` and this call set it), so
 * the default is set here. test/unit/test-timeout.test.ts checks it holds.
 */
import { setDefaultTimeout } from "bun:test";

export const DEFAULT_TEST_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
