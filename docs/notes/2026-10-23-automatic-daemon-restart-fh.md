# Automatic daemon restart: re-bootstrap, a bounded wait, and no database use after close

- Status: done
- Open: the full restart through the real launchd agent (the manual check below) not yet run live; the LWCR state was not reproduced in a scratch agent

On 2026-10-23 at 14:23Z the daemon restarted itself onto the build of 88882570 (`launchctl kickstart -k`, detached). The old process stopped and the new one never ran: launchd showed `state = spawn scheduled`, `last exit code = 78: EX_CONFIG`, `runs = 1470`, `properties = managed LWCR | has LWCR | needs LWCR update`, and nothing from a new process in any log. `flowryn daemon start` (a kickstart) timed out; `flowryn daemon install` (bootout and bootstrap) fixed it at once. In the same shutdown, launchd.err.log had `RangeError: Cannot use a closed database` at getRun ← scanOrphans ← a reconcile pass.

Everything here is plain code (launchctl calls, timers, a file, an item); no model.

## What changed

1. **A restart re-bootstraps the agent.** The launchd supervisor's restart is now the detached helper `flowryn daemon relaunch --old-pid <pid>` (`src/service/relaunch.ts`), run from the installed binary with the agent identity stripped (`smokeEnv`). The helper runs `bootout` (launchd stops the old daemon with SIGTERM: its normal clean shutdown), waits up to 45 s for the agent to unload, then `bootstrap`s the plist, which is exactly what `daemon install` does and what fixed the incident. It then waits up to 30 s for a daemon with another pid to answer on the socket.
2. **A fallback, then a P1.** If no new daemon answers: when the old daemon still answers (bootout stopped nothing), the helper exits non-zero with the reason on stderr and the old daemon takes its handoff back with the existing `restart_dropped` P1. Otherwise it tries once more (bootstrap again if the agent is not loaded, else a plain `kickstart`) and waits another 30 s. If nothing answers but a daemon holds the state lock (it is still starting up), it waits one more 30 s for it. If that fails too it writes `<state_dir>/restart-failed.json` (steps, launchctl's state lines, the command to run), probes once more (the daemon reads the record only once it is ready and answers pings, so one that missed it is seen here; if one with a new pid answers, the helper removes the record, posts nothing and succeeds), and otherwise posts a macOS notification "Flowryn daemon is down … Run flowryn daemon install in your terminal" (respecting `FLOWRYN_NOTIFY=off`, `FLOWRYN_NOTIFIER=record:` and `[notify] macos`). While the daemon is down, the record shows in `flowryn daemon status` (`last_restart`, with `flowryn daemon install` as the hint), in every refused CLI call (`daemon_unavailable` names it), and in `flowryn daemon restart`, which waits as long as the helper can run (`RELAUNCH_BOUND_MS`: the unload wait, three answer waits, two bootstraps' backoffs and a launchctl margin, about 180 s) and reports the record as soon as one newer than its request appears (after one last ping, so a daemon that came up meanwhile is reported instead). The next daemon, once ready, turns it into one `restart_failed` P1 (a relay kind, so the leader passes it on), records `daemon.restart_failed` with the downtime, and removes the file.
3. **`flowryn daemon start`** kickstarts as before, and when nothing answers within 8 s and launchd reports no running pid for the agent, loads it afresh (bootout and bootstrap) and waits again; a daemon launchd runs that is still starting is waited for, not booted out. If the bootstrap fails, it answers `daemon_unavailable` naming the logs and `flowryn daemon install`.
4. **No database use after close.** `Reconciler.stop()` now resolves when the pass under way has ended, and a pass checks `stopped` after each await (the orphan scan's Herdr snapshot, the Docker scan, the backlog read), so a stopped pass touches no table. The scheduler, delivery watcher, build watcher, upkeep and policy follow-through `stop()`s likewise resolve when their work under way ends; the daemon's own timer work (the spool pass, the pending-restart check, the notification and rewake ticks) is tracked in an `InFlight` set (`src/daemon/inflight.ts`). Shutdown stops every timer, then waits for all of it, the listener and the journal within the existing 12 s grace (`settleWithin`). If something is still running at the grace, it logs which and leaves the database open for the process exit to close, rather than closing it under a pass.

## Why re-bootstrap every time, not only when the binary changed

A restart is almost always onto a new binary (the build watcher's automatic restart is by definition; `--force` is the exception), so "only when it changed" would be the same path with one more branch. Bootout and bootstrap is what `daemon install` already does, is what recovered the incident, and costs the same downtime as `kickstart -k` (both wait for the old daemon's clean exit). It also resets launchd's run count and any state it pinned to the job.

## What was checked live (scratch agent, 2026-10-23)

A scratch agent `dev.flowryn.lwcrtest` (a small C program, ad-hoc signed with a per-build identifier, its plist in `~/Library/LaunchAgents`, removed afterwards):

- `kickstart -k` of the same binary, and of a new binary renamed over the program with a new ad-hoc identifier (as `scripts/build.sh` and the upkeep build do), both started the new binary. `properties` stayed `runatload | inferred program`; no LWCR property appeared. So the per-build identifier and the rename alone do not reproduce the incident; what launchd attached the LWCR for is still unknown (the real agent had run 1470 times, the Bun binary is large and its identifier is `flowryn-<hash>`). The fix does not depend on the cause: a bootstrap re-reads the job.
- **A helper the job starts in its own session (setsid, as `detached()` does) survives the job's `bootout`** and its `bootstrap` loads the agent again: the new binary ran with `runs = 1`. This is the assumption the helper rests on.
- A fresh bootstrap shows `properties = runatload | inferred program`; the live daemon after the incident's `daemon install` shows the same.

## Manual live check (needs the real agent, so not in `bun test`)

On the Mac, with the daemon installed and idle:

1. `launchctl print gui/$(id -u)/dev.flowryn.flowrynd | grep -E 'state|pid|runs|properties'` and note the pid.
2. `bun run build`, then `flowryn daemon restart` (or wait for the build watcher's automatic one).
3. Expect `restarted: launchd` with a new pid; launchctl shows `runs = 1` (a re-bootstrap, not a kickstart), and flowrynd.log has `relaunch: re-bootstrapping …` and `relaunch: the new daemon answers (pid …)`.
4. `grep -c 'closed database' ~/.flowryn/state/logs/launchd.err.log` does not grow.
5. The failure path: with a scratch home only (never the real one), point the plist's program at a file that exits 78 after the restart is asked, and expect `restart-failed.json`, the notification, `daemon status` naming `flowryn daemon install`, and after `flowryn daemon install` one `restart_failed` P1.

## Tests

- `test/unit/shutdown-order.test.ts`: the reconciler's `stop()` resolves only after the pass under way ends (the database closes after its last use); a pass stopped while waiting on Herdr touches nothing even with the database already closed (both fail on the old code with the incident's RangeError); no pass starts after stop; `InFlight` and `settleWithin`.
- `test/unit/relaunch.test.ts`, with an injected launchctl and socket probe: a restart is bootout then bootstrap and never `kickstart -k`; the fallback bootstraps again when the agent is not loaded, or kickstarts one stuck at `spawn scheduled`; a restart that cannot come up within its bound leaves the failure record and the notification naming `flowryn daemon install`, within a bounded time; a bootout that stopped nothing leaves the old daemon to withdraw; a failing notifier never throws; the helper command; the record's file and the one `restart_failed` P1.
- The existing `test/unit/restart.test.ts` assumption that a detached helper outlives a SIGTERM to its parent's process group still holds for the new helper.

## Open questions

- Should the helper start the daemon unsupervised (`daemon run` in the background) as a last resort? Recommendation: no. A daemon outside launchd is not restartable by the leader, has no KeepAlive, and would hold the lock against `daemon install`; the P1 and notification naming `flowryn daemon install` are the clearer path.
- Should the 45 s unload and 2 × 30 s answer waits be configurable? Recommendation: no, they are bounds on a rare path, sized from the daemon's own shutdown grace and launchd's exit timeout; a key would only be another thing to get wrong.
- Should we keep chasing the LWCR cause? Recommendation: only if a re-bootstrap restart ever fails; the failure record now captures launchd's `properties` line at the time, which is the evidence needed.
