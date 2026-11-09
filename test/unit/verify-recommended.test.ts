import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { anyMatches } from "../../src/verify/changed.ts";
import { verifyConfig } from "../../src/verify/config.ts";
import { recommendedVerifyToml, VERIFY_TEST_JOBS, VERIFY_TIMEOUT_MIN, WORKER_PATH_GLOBS } from "../../src/verify/recommended.ts";

/** The recommended verify block (docs/notes/2026-11-08-adopt-the-parallel-vi.md) and the globs that gate its contract checks. */

const ROOT = join(import.meta.dir, "../..");
const NOTE = join(ROOT, "docs/notes/2026-11-08-adopt-the-parallel-vi.md");

/** The worker-path directories AGENTS.md and docs/notes/2026-11-06-fast-tests-parallel-36.md name, and the lockfiles. */
const NAMED_WORKER_PATH = ["src/lifecycle/", "src/harness/", "src/contracts/", "src/reconcile/", "src/bridges/", "src/policy/", "src/runtime/"];
const LOCKFILES = ["package.json", "bun.lock"];

/** Every file under `dir` (relative to ROOT), recursively. */
function filesUnder(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[]).map((f) => join(dir, f)).filter((f) => statSync(join(ROOT, f)).isFile());
}

/** The repository files reachable by relative imports from the entry points: what the built binary, and so a worker and the contract check, run. */
function importClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(ROOT, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), match[1]!);
      const found = [target, `${target}.ts`, join(target, "index.ts")].find((c) => existsSync(c) && statSync(c).isFile());
      if (found) queue.push(found);
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}

function verifyOf(toml: string) {
  return verifyConfig(parseConfig(toml, "/h"), "flowryn")!;
}

describe("the recommended verify block", () => {
  test("every worker-path directory AGENTS.md names, and the lockfiles, gate the contract checks", () => {
    for (const dir of NAMED_WORKER_PATH) {
      const files = filesUnder(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(anyMatches(WORKER_PATH_GLOBS, [file]), file).toBe(true);
    }
    for (const file of LOCKFILES) expect(anyMatches(WORKER_PATH_GLOBS, [file]), file).toBe(true);
  });

  test("every file the binary imports gates the contract checks, so a worker-path change never skips them", () => {
    const closure = importClosure(["src/main.ts", ...filesUnder("src/contracts"), ...filesUnder("src/bridges").filter((f) => f.endsWith(".ts"))]);
    expect(closure.length).toBeGreaterThan(100);
    expect(closure.filter((file) => !anyMatches(WORKER_PATH_GLOBS, [file]))).toEqual([]);
  });

  test("docs, tests and scripts alone skip the contract checks", () => {
    for (const file of ["docs/notes/2026-11-08-adopt-the-parallel-vi.md", "test/unit/verify-recommended.test.ts", "test/timings.json", "scripts/test.ts", "README.md"]) {
      expect(anyMatches(WORKER_PATH_GLOBS, [file]), file).toBe(false);
    }
  });

  test("the block loads: cheap checks in a group, both contract checks gated, unit before integration", () => {
    const verify = verifyOf(recommendedVerifyToml());
    expect(verify.steps).toEqual([
      "bun install --frozen-lockfile",
      ["bun run typecheck", "npx oxlint", "bun run build"],
      ["./dist/flowryn doctor --contracts --verify-only --harness claude", "./dist/flowryn doctor --contracts --verify-only --harness pi"],
      `FLOWRYN_TEST_JOBS=${VERIFY_TEST_JOBS} bun run test:unit`,
      `FLOWRYN_TEST_JOBS=${VERIFY_TEST_JOBS} bun run test:integration`,
    ]);
    expect(verify.when_changed).toEqual([null, null, null, null, [...WORKER_PATH_GLOBS], [...WORKER_PATH_GLOBS], null, null]);
    expect(verify.binary).toBe("dist/flowryn");
    expect(verify.timeout_ms).toBe(VERIFY_TIMEOUT_MIN * 60_000);
  });

  test("the note prints the block exactly as the code builds it", () => {
    expect(readFileSync(NOTE, "utf8")).toContain(`\`\`\`toml\n${recommendedVerifyToml()}\n`);
  });
});
