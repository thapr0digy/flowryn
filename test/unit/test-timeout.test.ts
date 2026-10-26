import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Past bun's own 5 s default, well under ours (test/helpers/default-timeout.ts; not imported here, since importing it would set the default itself). */
const PAST_BUNS_DEFAULT_MS = 5_300;

test("assumption: a test with no timeout of its own runs past bun's 5 s default (the preload's setDefaultTimeout holds)", async () => {
  const started = Date.now();
  await Bun.sleep(PAST_BUNS_DEFAULT_MS);
  expect(Date.now() - started).toBeGreaterThanOrEqual(PAST_BUNS_DEFAULT_MS);
});

test("bunfig.toml preloads the default timeout and sets no `timeout` key bun test would ignore", () => {
  const bunfig = readFileSync(join(import.meta.dir, "..", "..", "bunfig.toml"), "utf8");
  expect(bunfig).toContain('"./test/helpers/default-timeout.ts"');
  expect(bunfig).not.toMatch(/^\s*timeout\s*=/m);
});
