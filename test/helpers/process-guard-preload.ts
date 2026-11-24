/**
 * Loaded before every test file (bunfig.toml `[test] preload`): the process
 * guard (test/helpers/process-guard.ts). It starts this test process's reaper
 * sidecar once (under --parallel the preload runs again for each file in the
 * same worker, so the state file says whether one is already running), and
 * after the file (after the whole run, without --parallel), once the file's own
 * teardown has run, it fails the run on any process the tests started that is
 * still alive, and ends it.
 */
import { afterAll } from "bun:test";
import { describeRow, descendants, endTracked, readPsTable, readState, REAPER, reaperRunning, survivors, sweepStaleStates, writeState, type PsRow } from "./process-guard.ts";

/** Teardown may end a process without waiting for it: this long for stragglers to exit before they count. */
const SETTLE_MS = 3_000;
const END_GRACE_MS = 1_000;

function ensureReaper(): void {
  const rows = readPsTable();
  if (!rows) throw new Error("process guard: ps could not read the process table, so no reaper watches this test process");
  sweepStaleStates();
  const state = readState(process.pid);
  if (state && reaperRunning(rows, state)) return;
  const reaper = Bun.spawn([process.execPath, REAPER, String(process.pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  reaper.unref();
  if (readState(process.pid)?.reaper !== reaper.pid) writeState({ parent: process.pid, reaper: reaper.pid, tracked: [] });
}

/** Processes started by this test process and still alive: those under it now, and those the reaper saw that launchd has since adopted. */
export function leftovers(rows: PsRow[]): PsRow[] {
  const state = readState(process.pid);
  const reaper = new Set(state ? [state.reaper] : []);
  const under = descendants(rows, process.pid, reaper);
  const seen = new Set(under.map((row) => row.pid));
  const adopted = survivors(state?.tracked ?? [], rows).filter((row) => !reaper.has(row.pid) && !seen.has(row.pid));
  return [...under, ...adopted];
}

ensureReaper();

afterAll(async () => {
  const deadline = Date.now() + SETTLE_MS;
  let leaks: PsRow[];
  for (;;) {
    const rows = readPsTable();
    if (!rows) throw new Error("process guard: ps could not read the process table, so leftover processes cannot be checked");
    leaks = leftovers(rows);
    if (leaks.length === 0) return;
    if (Date.now() >= deadline) break;
    await Bun.sleep(100);
  }
  const outlived = await endTracked(leaks, END_GRACE_MS);
  const lines = leaks.map((row) => `  ${describeRow(row)}`).join("\n");
  const note = outlived.length > 0 ? `; ${outlived.length} outlived SIGKILL` : "; they have been ended";
  throw new Error(`process guard: ${leaks.length} process(es) the tests started outlived their teardown${note}. Kill each process a test starts, with its children, in its teardown:\n${lines}`);
}, SETTLE_MS + END_GRACE_MS + 5_000);
