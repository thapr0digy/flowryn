# Native deployment acceptance run

- Status: partial
- Open: the one authorized live run on a Mac (the leader's), with its report

next_steps.md package 4, "Close the native deployment loop", third slice. `test/integration/binary.test.ts` proves a compiled daemon pins its build and restarts onto a new merged build, but under a script supervisor; the build-after-merge notes leave "a build by the launchd daemon … not yet run live". This slice adds an opt-in script that runs the whole loop under real launchd, on a separate home and label, with compiled artifacts and the fake external services, and keeps a report of exactly what ran.

## Design

**Shape.** `scripts/lab/native-acceptance.ts`, a lab script beside `m5-live.ts` and `v1-live.ts`: plain code, no model. Its guards, its plan and its report are exported pure functions with unit tests; the run itself executes only under `import.meta.main` with both opt-ins, so `bun test` never touches launchd (it imports the module and spawns the script only to see it refuse or print its plan).

**Invocation.**

```sh
bun scripts/lab/native-acceptance.ts --plan [--home <dir>]            # prints what it would install; touches nothing
FLOWRYN_NATIVE_ACCEPTANCE=1 bun scripts/lab/native-acceptance.ts --run [--home <dir>] [--report <file>] [--keep]
```

Run from a real terminal or a leader shell, outside a command sandbox (launchd, `~/Library/LaunchAgents`, sockets). With neither `--plan` nor `--run`, or `--run` without `FLOWRYN_NATIVE_ACCEPTANCE=1`, it refuses (exit 2).

**The separate service.** The home is a fresh directory (`--home`, which must not exist; default `$TMPDIR/fna-<8 hex>`, short enough for the 104-byte socket limit, and its realpath, since a compiled binary's `process.execPath` is resolved and the plist must match it exactly). Built by the test harness's `makeHome` (its stand-in `claude`, `pi`, `no-mistakes`, `lavish-axi`, `quota-axi`, `gh`; `FLOWRYN_NOTIFY=off`, the recorded notifier and opener; the host check passing), with a fake Herdr (`test/helpers/fake-herdr.ts`) on a socket in the home and the fake forge (`test/helpers/fake-github.ts`) as `[github] api_url`, both served by the script's own process. `[daemon] build_poll_ms = 200`, `build_settle_ms = 3000`; `[upkeep] build_after_merge = false` (no project, but nothing is fetched by surprise). The label is `serviceLabel(home)` (`dev.flowryn.flowrynd.<hash>`), the plist `~/Library/LaunchAgents/<label>.plist`: the only label and plist path the daemon's own launchd supervisor will restart through, so the acceptance exercises the real supervisor, not a stand-in.

**One product change: the safety overrides reach a launchd daemon.** `plistDrift` refuses a restart when the installed plist's environment differs from what `daemon install` would write, and that environment is only `PATH`, `HOME` and `FLOWRYN_HOME`, so a launchd daemon cannot today be told `FLOWRYN_NOTIFY=off` without every restart being refused as drift. `plistSpecFor(config, home, env)` now carries `FLOWRYN_NOTIFY`, `FLOWRYN_NOTIFIER` and `FLOWRYN_OPENER` from `env` when they are set (`SERVICE_ENV_PASSTHROUGH`); the daemon passes its own environment (which under launchd is the plist's), `daemon install` and `init` the caller's. A production install has none of them set, so its plist is unchanged; one made with `FLOWRYN_NOTIFY=off` in the shell now keeps notifications off under launchd, which is what the variable asks for.

**Guards** (refusals, exit 2, before anything is created):

- Not macOS; `FLOWRYN_RUN` set (a worker never installs a launchd agent); `--run` without `FLOWRYN_NATIVE_ACCEPTANCE=1`.
- Collision with production, computed from each production home (`~/.flowryn`, and the caller's `FLOWRYN_HOME` when set): the acceptance label equal to `dev.flowryn.flowrynd` or to a production home's label; the plist path equal to a production plist; the socket equal to a production socket; the home equal to, inside, or containing a production home, data dir or state dir; the installed binary path equal to the production plist's program.
- A leftover: a plist already at the acceptance label's path, or (in `--run` only) the label already loaded.
- The acceptance environment without `FLOWRYN_NOTIFY=off` (`requireNotificationsOff`).

**Steps** (each a report entry with `ok`, `detail`, evidence and its duration; the first failure stops the run, teardown still runs):

1. `build`: compile two candidates with `scripts/build.sh`, stamped with two commits of a scratch repository whose `origin/main` has both (the build watcher applies only a clean build of a merged commit; same tree, so the same version and not a downgrade).
2. `install`: copy candidate A into `<home>/inst/flowryn`, write the plist (`renderPlist` of the daemon's own spec with that program), `plutil -lint`, bootstrap (`loadAgent`). Pass: the socket answers, launchd's pid for the label is the daemon's pid, its build is A's.
3. `pinned-callers`: `<state>/bin/flowryn` links to `flowryn-<A>`; that pinned caller's `version --json` reports A's commit; a `todo add` through it with a seeded leader token lands in the home's todos file.
4. `replacement`: candidate B renamed over the installed binary (new inode, as the build after merge does). Right after, the pinned link still names A; then launchd restarts the daemon (`kickstart -k` from the daemon's supervisor) and the pass is a new pid that launchd reports for the label, ping build B, the link at `flowryn-<B>`, a `daemon.restarted` event by `auto` from A to B, and a `todo add` through the pinned caller served by B.
5. `failed-candidate`: a truncated copy of B renamed over the installed binary. Pass: within 30 s `meta.build_watch` holds `refused`/`broken` for its build id and a `build_refused` item is open, while the pid and build are unchanged and a request is still served. Then B goes back and the item closes (the watcher settles on the running build).
6. `shutdown`: the `daemon.stop` request `flowryn daemon stop` sends. Pass: the socket stops answering, and after launchd's throttle interval (12 s) the label is still loaded with no pid (a clean exit stays stopped).
7. `uninstall`: `uninstallService`. Pass: `launchctl print` no longer finds the label and the plist is gone.

**Teardown** (a `finally`, and on SIGINT/SIGTERM): unload the label and remove its plist whatever happened (never another label: it is computed once from the acceptance home and checked against production first), stop the fakes, then remove the home unless `--keep`. The report records whether the label and plist are gone and whether the home was removed.

**Report** (JSON, `--report`, default `spikes/.runs/native-acceptance-<run id>.json`, which git ignores; also summarised on stdout): `kind: "flowryn-native-acceptance"`, `schema: 1`, `run_id`, `result` (`pass` only when every step and the teardown passed), `started_at`, `ended_at`; `environment` (host, macOS version and build, arch, uid, launchd domain, Bun version, Flowryn version and protocol, the source checkout's commit and whether it was dirty, label, plist path, home, socket, fake Herdr socket, fake forge URL); `artifacts` (for A, B and the broken one: path, build id, full sha256, size, stamped commit); `steps`; `teardown`. `validateReport` checks the shape; the unit tests build reports through the same function the run uses.

**Not done here.** The live run itself (the leader's one authorized run); no CI job (CI is Linux, and no paid macOS CI). Nothing in `bun test` drives launchd.
