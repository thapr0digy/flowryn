#!/usr/bin/env bun
/**
 * The test suite, fast (docs/notes/2026-11-06-fast-tests-parallel-36.md): every file but the
 * timing-sensitive ones in parallel (`bun test --parallel`), then those one at a time, stopping
 * at the first failing part.
 *
 *   bun scripts/test.ts               # unit, then integration (stops at the first failing part)
 *   bun scripts/test.ts unit          # test/unit only
 *   bun scripts/test.ts integration   # test/integration only
 *
 * FLOWRYN_TEST_JOBS sets the parallel workers (default: two thirds of the cores, 2 to 8).
 * Under --parallel each file runs several times slower than alone, so tests get a 30 s
 * default timeout instead of bun's 5 s; a test that sets its own keeps it, and test/integration files
 * set 60 s themselves (test/helpers/integration-timeout.ts), so they keep that here too.
 * test/timings.json (per-file durations) starts the slowest files first; refresh it with
 * `bun scripts/test.ts --update-timings` in a PR of its own. With two parts, it ends with one
 * summary in bun's own format, the parts added, so `flowryn verify` counts every test.
 */
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parseBunSummary, type TestCounts } from "../src/verify/summary.ts";

const ROOT = join(import.meta.dir, "..");
const TIMINGS = "test/timings.json";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Files whose tests assert on wall-clock windows (a fixed sleep before "nothing happened yet",
 * a race between two deliveries): they pass alone but miss their windows when a dozen daemons
 * share the CPU, so they run one at a time after the parallel part.
 */
export const SERIAL_FILES = [
  "test/unit/gate-questions.test.ts",
  "test/integration/races.test.ts",
  "test/integration/urgent.test.ts",
  "test/integration/question-wake.test.ts",
  "test/integration/treehouse-pool.test.ts",
  "test/integration/asks.test.ts",
] as const;

export const SCOPES = { unit: "test/unit", integration: "test/integration", all: null } as const;
export type Scope = keyof typeof SCOPES;

/** The parallel workers: FLOWRYN_TEST_JOBS when it is a positive integer, else two thirds of the cores, 2 to 8. */
export function testJobs(env: NodeJS.ProcessEnv, cores = availableParallelism()): number {
  const set = Number(env.FLOWRYN_TEST_JOBS);
  if (Number.isInteger(set) && set > 0) return set;
  return Math.max(2, Math.min(8, Math.floor((cores * 2) / 3)));
}

/**
 * The bun test invocations for a scope, in order: each directory's parallel part, then the
 * serial files in it. `all` is unit, then integration, so a unit failure stops the run in a minute or two.
 */
export function plan(scope: Scope, jobs: number, opts: { timings: boolean; updateTimings: boolean }): string[][] {
  if (scope === "all") return [...plan("unit", jobs, opts), ...plan("integration", jobs, opts)];
  const dir = SCOPES[scope];
  const serial = SERIAL_FILES.filter((file) => file.startsWith(`${dir}/`));
  const timings = opts.timings ? [`--timings=${TIMINGS}`, ...(opts.updateTimings ? ["--update-timings"] : [])] : [];
  const runs = [["bun", "test", `--parallel=${jobs}`, `--timeout=${DEFAULT_TIMEOUT_MS}`, ...timings, ...serial.map((file) => `--path-ignore-patterns=${file}`), dir]];
  if (serial.length > 0) runs.push(["bun", "test", `--timeout=${DEFAULT_TIMEOUT_MS}`, ...serial]);
  return runs;
}

function parseArgs(argv: string[]): { scope: Scope; updateTimings: boolean } {
  let scope: Scope = "all";
  let updateTimings = false;
  for (const arg of argv) {
    if (arg === "--update-timings") updateTimings = true;
    else if (arg in SCOPES) scope = arg as Scope;
    else throw new Error(`unknown argument ${arg}: expected unit, integration or --update-timings`);
  }
  return { scope, updateTimings };
}

/** The parts' counts added, in bun's summary format; null when a part printed none. */
export function combinedSummary(parts: (TestCounts | null)[]): string | null {
  if (parts.some((p) => p === null)) return null;
  const sum = (key: "pass" | "fail" | "skip" | "todo" | "tests" | "files") => parts.reduce((n, p) => n + (p![key] ?? 0), 0);
  const lines = [` ${sum("pass")} pass`, ...(sum("skip") > 0 ? [` ${sum("skip")} skip`] : []), ...(sum("todo") > 0 ? [` ${sum("todo")} todo`] : []), ` ${sum("fail")} fail`];
  return `\n--- every part ---\n${lines.join("\n")}\nRan ${sum("tests")} tests across ${sum("files")} files.\n`;
}

const TAIL_BYTES = 64 * 1024;

/** Run one part with its output passed through; resolves with its exit code and the tail of its output. */
async function runPart(argv: string[]): Promise<{ code: number; tail: string }> {
  const proc = Bun.spawn(argv, { cwd: ROOT, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const pump = async (stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      out.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-TAIL_BYTES);
    }
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  return { code: await proc.exited, tail };
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const runs = plan(args.scope, testJobs(process.env), { timings: existsSync(join(ROOT, TIMINGS)), updateTimings: args.updateTimings });
  const counts: (TestCounts | null)[] = [];
  for (const argv of runs) {
    console.error(`$ ${argv.join(" ")}`);
    const { code, tail } = await runPart(argv);
    if (code !== 0) return code;
    counts.push(parseBunSummary(tail));
  }
  const summary = runs.length > 1 ? combinedSummary(counts) : null;
  if (summary) process.stderr.write(summary);
  return 0;
}

if (import.meta.main) process.exit(await main());
