import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATION_TEST_TIMEOUT_MS } from "../helpers/integration-timeout.ts";

const INTEGRATION_DIR = join(import.meta.dir, "..", "integration");
const integrationFiles = readdirSync(INTEGRATION_DIR).filter((name) => name.endsWith(".test.ts")).sort();

// Bun's setDefaultTimeout reaches only the file whose top-level code calls it, so each file must call the helper itself.
test("every integration test file sets the integration timeout at its top level", () => {
  const missing = integrationFiles.filter((name) => !/^useIntegrationTimeout\(\);$/m.test(readFileSync(join(INTEGRATION_DIR, name), "utf8")));
  expect(integrationFiles.length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});

const toMs = (literal: string) => Number(literal.replaceAll("_", ""));

// A file-level check, kept coarse so it never misreads a test body: a waitUntil deadline at or past the
// default needs some explicit test timeout in its file longer than it (the test that waits that long sets one).
test("a waitUntil deadline at or past the integration timeout has a longer explicit test timeout in its file", () => {
  const uncovered: string[] = [];
  for (const name of integrationFiles) {
    const source = readFileSync(join(INTEGRATION_DIR, name), "utf8");
    const waits = [...source.matchAll(/waitUntil\([^;]*?,\s*([0-9][0-9_]*)\s*,/g)].map((m) => toMs(m[1]!));
    const explicit = [...source.matchAll(/\},\s*([0-9][0-9_]*)\s*,?\s*\)|\{\s*timeout:\s*([0-9][0-9_]*)/g)].map((m) => toMs((m[1] ?? m[2])!));
    const longestExplicit = Math.max(0, ...explicit);
    for (const wait of waits) if (wait >= INTEGRATION_TEST_TIMEOUT_MS && wait >= longestExplicit) uncovered.push(`${name}: waitUntil ${wait} ms`);
  }
  expect(uncovered).toEqual([]);
});
