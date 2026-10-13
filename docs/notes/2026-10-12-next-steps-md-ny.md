# Native deployment acceptance run

- Status: done
- Open: the one authorized live run on a Mac (the leader's), with its report; nothing here has driven launchd yet

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

## Built

- **`scripts/lab/native-acceptance.ts`** as designed. The exports the tests use: `parseCliArgs`, `invocationRefusals`, `planFor`, `plannedTools`, `extraToolLines`, `productionTargets`, `scrubPath`, `collisions`, `leftovers`, `newReport`, `finishReport`, `validateReport`. The run loads the test harness (`makeHome`, `seedLeader`, `FakeHerdr`, `FakeGitHub`) only in `--run`, so `--plan` loads none of it.
- **`makeHome({ home })`** (`test/helpers/harness.ts`): an optional fixed home (created, must not exist), so the plan's identifiers are the run's.
- **Changes from the design while building:**
  - `FLOWRYN_RUN` refuses `--run` only; `--plan` creates nothing, so a worker may print it.
  - **No tool resolves on this machine's PATH.** The production home's `state/shims` (the `claude` and `pi` shims) were on the PATH this was built under, and `servicePath` puts the directory of every tool resolved from PATH into the plist. So every tool `makeHome` does not record (`MAKEHOME_TOOLS`) is pinned in the home's `[tools]` to an absent stand-in, `<home>/bin/tool-absent`. The plist's PATH is then the home's `bin`, the node, git and tasks-axi directories, and the system directories. A new guard refuses any daemon PATH entry inside a production home or its directories. `--plan` resolves node, git and tasks-axi on the PATH with production's directories removed (`scrubPath`). Bun's `which` reads the PATH it started with, so the PATH is passed to `which` rather than changed in `process.env`.
  - The guards run twice: once on the plan, before anything exists, and once on the built home's real config, before the fakes start. The second run catches a PATH entry that `makeHome`'s own tool lookup put there.
  - A SIGINT or SIGTERM tears down, writes the report and exits 130.
- **Plan output** (`--plan`): JSON with the home, label, plist path, socket, state and data dirs, installed binary, pinned caller, fake Herdr socket, program, environment, the steps, the refusals (exit 2 when there are any) and the rendered plist, plus the exact `--run` line for that home.
- **Exit codes**: 0 is a pass (every step, a clean teardown and a well-formed report); 1 is a failure (the report says which step failed and its evidence); 2 is a refusal (nothing was created).

## Tests

- `test/unit/native-acceptance.test.ts`:
  - The opt-in: no mode, `--run` without `FLOWRYN_NATIVE_ACCEPTANCE=1` (or with any other value), a worker, Linux, and `--plan` allowed for each.
  - Argument parsing.
  - The plan's identifiers all inside the home and the label never the base one. The stand-in tool lines, and the assumption that `makeHome` records exactly `MAKEHOME_TOOLS` (a repeated key would make the config unreadable). `scrubPath`.
  - Every collision: the production home, a home inside or containing a production directory, a `FLOWRYN_HOME` home's label and socket, the production program, a PATH entry. Leftovers. `productionTargets` reading `~/.flowryn` and `FLOWRYN_HOME` with their configured directories.
  - The report: a pass and its JSON round trip; a fail from a failed step, a missing step, a label left loaded or a teardown error; the shape check's catches.
  - The script spawned with a scratch `HOME`: it refuses, and `--plan` prints the plan. Neither creates the home or `~/Library/LaunchAgents`. `--plan` on `~/.flowryn` exits 2.
- `test/unit/setup.test.ts`:
  - `plistSpecFor` carries the three overrides and nothing else of the caller's environment.
  - The assumption that a daemon started with the plist's environment computes the same spec, so there is no drift. This holds with or without the overrides.
- Not in `bun test`: the run itself. A scratch script built the run's real home (`makeHome` with the stand-in tool lines) and checked it. `plistDrift` between the planned plist and the spec the daemon computes from that plist's environment is empty, and the guards found no collision.
