# Recover a broken Lavish server by itself

- Status: done
- Open: assumption A1 (Lavish keeps queued feedback across `lavish-axi stop`) is proven only against the fake lavish-axi; not yet run against a real server in a lab session

On 2026-11-08 the shared Lavish server (127.0.0.1:4387) answered every page with HTTP 500 (`code: SERVER_ERROR`) and a worker sat blocked until the leader ran `lavish-axi stop` by hand (the server starts again on the next `lavish-axi <file>`). Flowryn now does that itself, in plain code (`src/lavish/recovery.ts`).

## Detection

- `isServerError`: a non-zero lavish-axi exit that printed `code: SERVER_ERROR`. lavish-axi prints it for a 500 and for "server connection failed". `NOT_FOUND`, a timeout (124/125) and a spawn failure are never server errors.
- A daemon host of a review page's copy that fails with one is run again at once; a gate's poll that fails with one is run again by its usual 2 s backoff. The second server error in a row asks the doctor (`LavishDoctor.check`).
- The doctor (one check at a time, every asker shares it) hosts its own probe page, `<state_dir>/lavish-probe/probe.html` (fixed text, no task content, written by atomic rename so a planted symlink is replaced, never written through). Probe hosts: a blip, event `lavish.probe_ok`. The gate whose failure asked then asks no check again until it hosts or polls well, so one page the server keeps failing does not probe on every backoff. Probe fails too: the server is broken, event `lavish.broken`.

## Recovery

1. Rate limit: when the newest `lavish.restarted` event is under 10 minutes old (`RESTART_WINDOW_MS`, read from the events so a daemon restart keeps it), give up.
2. The poller pauses (`pauseForRestart`): every poll is stopped as a deliberate stop (no backoff, no channel failure), a reply a poll carried is queued again, and no poll or host starts.
3. `lavish-axi stop` (through `runBounded`, 15 s).
4. The probe again (the server self-starts).
5. The poller resumes (`resumeAfterRestart`): every open gate's page is hosted again, its backoff cleared, and its poll starts at once. A page that fails to host goes back to its usual backoff and channel item.
6. Event `lavish.restarted` `{ reason, by, pages, failed, ok }`.

Give-up (a breakage within the window, a stop that fails, or a probe still failing after the restart): event `lavish.gave_up` (and `lavish.stop_failed` for a failed stop), and one `lavish_broken` P1 item, "Lavish keeps failing (…)". While it is open no check probes or restarts; it resolves (event `lavish.healthy`) when a host or poll works again, or by hand.

## Workers

`flowryn lavish recover` (worker run tokens only; no arguments, no paths) runs the same check and answers `state`: `ok` or `restarted` (run your lavish-axi command again), `gave_up` with `item` (report blocked naming it), or `off` (no lavish-axi for the daemon). The review gate's worker text says: run lavish-axi once more; still `code: SERVER_ERROR`: run `$FLOWRYN_BIN lavish recover`, then the command again; any other error, or recover giving up: report blocked; never run `lavish-axi stop`. The verb reaches the daemon over its socket, so the worker sandbox gains no path. The rate limit holds whatever a worker does: a worker looping on the verb gets the open item back.

## Briefing

Each `lavish.restarted` and `lavish.gave_up` since the last briefing is one line ("Lavish restarted 07:02 automatically (the poll of gate g12 failed twice …): 3 review pages hosted again."). A scoped leader's line leaves out why (it names a gate).

## Limits

- `lavish-axi stop` ends every session on the shared server, the leader's own pages included; those resume when reopened, and nothing here re-hosts them.
- The probe leaves its own small session on the server.

## Tests

`test/unit/lavish-recovery.test.ts` (classification, probe, restart, rate limit across doctor instances, stop failing, still failing after the restart, a re-host failing, single flight, give-up resolving, briefing lines) and `test/integration/lavish-recovery.test.ts` (the fake lavish-axi broken until `stop`: a worker's verb recovers, the page is hosted and polled again and a message queued during the breakage is delivered; a second breakage within 10 minutes raises the P1; the daemon's own poll failing twice restarts it with no worker; one page failing while the probe hosts asks for one check, not one per backoff; a leader is refused). The test home's lavish-axi learns `$FLOWRYN_HOME/lavish-broken` and `lavish-stop-fail`.
