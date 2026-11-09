/**
 * The recommended `[projects.flowryn] verify` block for this repository
 * (docs/notes/2026-11-08-adopt-the-parallel-vi.md). Pure data: the note prints
 * it, and test/unit/verify-recommended.test.ts checks the note against it and
 * the contract checks' globs against the code they gate. The leader applies it
 * to config.toml; nothing reads it at runtime.
 */

/**
 * The worker-path globs that gate the contract checks. `flowryn doctor --contracts`
 * starts a scratch daemon, and through it imports nearly every `src/` folder
 * (lifecycle, harness, sched, daemon, db, config, policy, ...); the worker calls the
 * CLI verbs and runs the bridges. So every source file is on the path, plus the
 * Pi gate's scripted model (spikes/pi/lib, imported by the binary), the build
 * script and what the build and the dependency set read. Only docs, tests,
 * fixtures, the other spikes and scripts changes skip the checks.
 */
export const WORKER_PATH_GLOBS = ["src/**", "spikes/pi/lib/**", "scripts/build.sh", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"] as const;

/** Parallel test workers per verify: two verifies at once (`[capacity] validation = 2`) use at most 12 on the 12-core Mac. */
export const VERIFY_TEST_JOBS = 6;

/** Twice the 15 minute target: a hung step is caught sooner than at 75, a loaded run is not cut. */
export const VERIFY_TIMEOUT_MIN = 30;

const quote = (text: string) => JSON.stringify(text);

/** The block as the leader pastes it into config.toml. */
export function recommendedVerifyToml(jobs = VERIFY_TEST_JOBS): string {
  const globs = `[${WORKER_PATH_GLOBS.map(quote).join(", ")}]`;
  const contract = (harness: string) => `    { run = ${quote(`./dist/flowryn doctor --contracts --verify-only --harness ${harness}`)}, when_changed = ${globs} },`;
  return [
    "[projects.flowryn]",
    "verify = [",
    '  "bun install --frozen-lockfile",',
    '  ["bun run typecheck", "npx oxlint", "bun run build"],',
    "  [",
    contract("claude"),
    contract("pi"),
    "  ],",
    `  ${quote(`FLOWRYN_TEST_JOBS=${jobs} bun run test:unit`)},`,
    `  ${quote(`FLOWRYN_TEST_JOBS=${jobs} bun run test:integration`)},`,
    "]",
    'verify_binary = "dist/flowryn"',
    `verify_timeout_min = ${VERIFY_TIMEOUT_MIN}`,
  ].join("\n");
}
