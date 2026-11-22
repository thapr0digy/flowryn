# launchd agent runs unthrottled (ProcessType Interactive)

- Status: done
- Open: applies on this machine only after the user runs `flowryn daemon install` (restarts the daemon)

`flowryn daemon install` now writes `<key>ProcessType</key><string>Interactive</string>` into the agent plist (`renderPlist`, `src/service/launchd.ts`), in both the gui/<uid> and user/<uid> domains.

## Why

launchd.plist(5): with no ProcessType "the system will apply light resource limits to the job, throttling its CPU usage". Every process the daemon runs inherits that, so `flowryn verify` children (bun tests, headless Chrome for Signal's ui-check) ran throttled. Measured by phase-assurance-e6: Signal's "Show more at 1000 rows" takes ~10 ms unthrottled and ~200 ms throttled (`taskpolicy -b`), so every UI timing budget failed in verify whatever the change. It likely explains many of the load flakes `flowryn learnings` lists for Flowryn and Signal; expect verify timings to match a terminal run after the reinstall.

## Applying it

The plist is only written by `flowryn daemon install`. `flowryn daemon restart` re-bootstraps the installed plist, so it does not apply the change, and it does not refuse over a missing ProcessType either (`plistDrift` compares only what a restart depends on). `flowryn doctor` reports it as the `launchd throttle` check: `warn` with "reinstall to apply: flowryn daemon install" when the installed plist has no ProcessType or another one, `ok` once it is Interactive.

## Tests

`test/unit/launchd.test.ts`: the rendered plist has ProcessType Interactive in every domain and passes `plutil -lint` (darwin only); the doctor check warns on a plist without it, on another value and on an unreadable plist, and passes on the plist install writes now.
