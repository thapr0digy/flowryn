/**
 * The reaper sidecar of one bun test process (test/helpers/process-guard.ts):
 *
 *   bun test/helpers/reaper.ts <test pid>
 *
 * It runs in its own process group, so a Ctrl-C to the test's terminal does
 * not reach it. Every SAMPLE_MS it remembers each process under the test
 * process and writes what it remembers to the guard's state file. Once the
 * test process is gone, it ends every remembered process still alive as
 * itself (SIGTERM, a grace for a daemon to end its own children, SIGKILL),
 * removes the state file and exits.
 */
import { endTracked, readPsTable, readState, removeState, track, writeState, type Tracked } from "./process-guard.ts";

/** A full ps read; a leak worth catching lives for minutes, and a desktop's process table costs tens of ms to read. */
const SAMPLE_MS = 1_000;
/** Whether the test process is still there: one signal-0 call. */
const PARENT_CHECK_MS = 200;
/** A daemon under test gets this long after SIGTERM to end its own children (its stop grace is 2 s). */
const GRACE_MS = 4_000;

const parent = Number(process.argv[2]);
if (!Number.isInteger(parent) || parent <= 1) {
  process.stderr.write(`reaper: expected the test process's pid, got ${JSON.stringify(process.argv[2])}\n`);
  process.exit(2);
}

function parentAlive(): boolean {
  // Adopted by launchd (or any other parent): the test process is gone, even if its pid was reused.
  if (process.ppid !== parent) return false;
  try {
    process.kill(parent, 0);
    return true;
  } catch {
    return false;
  }
}

const self = new Set([process.pid]);
const tracked = new Map<string, Tracked>();
const save = (): void => writeState({ parent, reaper: process.pid, tracked: [...tracked.values()] });
save();

let nextSample = 0;
while (parentAlive()) {
  if (Date.now() >= nextSample) {
    const rows = readPsTable();
    if (rows && track(tracked, rows, parent, self)) save();
    nextSample = Date.now() + SAMPLE_MS;
  }
  await Bun.sleep(PARENT_CHECK_MS);
}

await endTracked([...tracked.values()], GRACE_MS);
// Only this reaper's own file: another reaper may have taken over a reused pid's name.
if (readState(parent)?.reaper === process.pid) removeState(parent);
process.exit(0);
