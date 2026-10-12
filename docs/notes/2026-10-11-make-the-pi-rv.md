# Deterministic Pi contract gate

- Status: done
- Open: the `--model` real-model pass not yet run live (the offline test covers it with a fake model that ignores steers)

Scout `investigate-flaky-pi-kp` found why `doctor --contracts --verify-only --harness pi` sometimes timed out at 240 s on steers that were carried on time. Pi ran on `openrouter/free`, a router that picks a model per request (5 to 10 models in one run, down to 2.6B). Some of those models ignored the acknowledgement, and some ran `deliver` early, which landed the run before the next steer. Model variance does not tell you whether a Pi version works with Flowryn, so the gate no longer meets a model. Plain code throughout; no model decides anything.

## The gate plays the scripted model

All three modes of `flowryn doctor --contracts` (recording, `--verify-only` the PR-build gate, `--for-daemon` the daemon's automatic check) run Pi on the offline scripted provider (`spikes/pi/lib/scripted-provider.ts`). `contractBody` then gives the worker its `FLOWRYN-SCRIPT`, so every acknowledgement and the final deliver are fixed. The run still uses the pinned Pi binary, Flowryn's real worker extension, Herdr and a scratch daemon, which is everything a harness-version pass has to prove.

- **A fixed profile.** The scratch home's `[workers.pi]` is `model = "flowryn-scripted/scripted"`, `extensions = [<home>/pi/scripted-provider.ts]`, `agent_dir = <home>/pi-agent`, `session_dir = <home>/pi-sessions`, `no_context_files = true` and `env = { PI_OFFLINE = "1", PI_SKIP_VERSION_CHECK = "1", PI_TELEMETRY = "0" }`, as `scripts/lab/m5-live.ts` wires it (`scriptedPiTable`, `src/contracts/pi-profile.ts`). Your own `[workers.pi]` (its model, extensions, env, extra args) is not used by the gate, so nothing in it can make the gate flaky. The gate also never writes `~/.pi`: before this change, every contract run left its sessions in `~/.pi/agent/sessions`.
- **The provider ships in the binary.** The daemon's automatic check runs a pinned compiled `flowryn` with no checkout, so the provider is embedded the way the worker extension is (`import … with { type: "file" }`) and written into the scratch home at the start of each run. The spike file stays where it is. The type checker sees it now, so `src/contracts/pi-packages.d.ts` gives Pi's two packages loose shapes (Pi resolves the real ones at load time), and two `steps[stepIndex]` lookups gained a `!`.
- **Faster.** Only the contract's own sleeps take time: about 35 s in the live run below, against 3 to 5 minutes on a model. The Pi step estimates follow (`contractEstimateSeconds`).

## A real model is opt-in and informational

`--model X` on Pi, where X is not `flowryn-scripted/…`, adds a second pass after the gate passes. For Claude, `--model` still sets the worker model, as before.

- **How it is reported.** Each step is a check `contract pi model X <step>`, with status `info` when it passes and `warn` when it fails. A summary check `contract pi model X` (`info`) reads `informational, not gating: passed 11/11` or `… stopped at <step>: <why>`, and names its report. Only `fail` sets doctor's exit code, so this pass never changes it.
- **Never recorded.** Its report is always written as verify-only and carries a `model` field, so `contracts.record` and the daemon's report check cannot take it. The gate's report stays the run's report.
- **When it is skipped.** If the gate failed, it reports `info` "skipped, the gate failed". If your Pi agent dir has no `auth.json`, it reports `info` "skipped, no auth.json in <dir>". `--model` with `--for-daemon` is refused (`bad_args`), since the daemon's check runs the gate only.
- **Credentials.** The pass runs in its own scratch home and agent dir. It copies `auth.json`, `models.json` and `models-store.json` (whichever exist) from your Pi agent dir, which is `[workers.pi] agent_dir`, else `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. That directory is only read. The rest of your `[workers.pi]` carries over with the model replaced. An OAuth provider that rotates its refresh token would refresh it in the scratch copy; the scout's case, OpenRouter, uses an API key.

## Named causes instead of a blind timeout

`waitAcked` (`src/contracts/suite.ts`) checks `ackBlocker(run, steer, now)` on every poll and fails at once with the first cause that applies:

| The rows show | The step fails with |
|---|---|
| the run is `landed` or `cleaned` | `the worker delivered before m2 (run landed); m2 carried +1ms, not seen for 3.0s` |
| the run is `failed` or `cancelled` | `the run failed before m2 was acknowledged; …` |
| `seen_at` is set, there is no ack, `idle_since > seen_at`, and that has held for `IGNORED_GRACE_MS` (5 s) | `m1 seen +25.1s, turn ended without ack (model ignored the steer); m1 carried +2ms, seen +25.1s` |

- **Why `idle_since`.** Only a turn-end hook (`markIdle`, a Claude Stop or Pi's settled turn) sets it, and any busy hook clears it. `liveness` also turns idle when the busy lease lapses mid-tool, so it would accuse a model that is still working. A Claude Stop that carries a steer continues the turn (`markBusy("continued")`), so it is not a turn end; `test/integration/contract-ack-blocker.test.ts` checks this on the rows the real hooks write.
- **Why stop waiting.** A seen, unacknowledged steer re-rings only every `ring_interval_ms` (600 s in contract runs), so nothing can acknowledge it within the step's window. The 5 s grace absorbs hook ordering around a turn end.
- **Timeouts name the steer.** A wait that still runs out now includes the steer's timings, for example `timed out after 240s waiting for steer m1 to be acknowledged (m1 carried +2ms, not seen for 4m0s)`. The runner's poll loop is now `pollFor` (`src/contracts/runner.ts`), which takes an optional `explain`.

Not built: the scout's third fix (pin one model, a task header without the scout's `deliver --report` line, a ring interval below the step timeout). The gate no longer meets a real model, and the opt-in pass only informs.

## Tests

- `test/unit/contract-pi-gate.test.ts`:
  - every `ackBlocker` cause, the grace boundary, a turn end before the steer was seen (an idle carry), an unseen steer and a lapsed lease;
  - `waitAcked` failing fast on a run that lands mid-wait, on an ignored steer, and on a timeout with timings;
  - the gate profile against a `[workers.pi]` of `openrouter/free` plus an extension of your own;
  - the real profile, and that Claude's `--model` is unchanged;
  - `realPiModel`;
  - the embedded provider matches the spike file;
  - the credential copy (present, missing, the source untouched) and where the source is looked up.
- `test/integration/contracts-offline.test.ts`:
  - the test home sets `[workers.pi] model = "openrouter/free"`, and the Pi case no longer passes `--model`;
  - the fake Pi (`test/helpers/fake-contract-pi.ts`) plays the script only when it is launched as the gate launches it (`--model flowryn-scripted/scripted`, the provider as a second `-e`, a scratch `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`), so a gate that is not scripted fails there;
  - a new case runs `--model openrouter/test-model:free`. The fake then plays a model that does the first step, says ONE and never acknowledges a steer (each request takes 500 ms, as live inference does). The real-model pass stops at "deliver while busy" with the named cause as a `warn`, doctor exits 0, only the gate's version is recorded, and the agent dir it copied from is unchanged.
- `test/integration/doctor-contracts.test.ts`: `--for-daemon --model` is refused.

## Live

On 2026-10-12, the compiled build (`scripts/build.sh`; the provider is embedded in it) ran `doctor --contracts --verify-only --harness pi` in a Herdr lab session against Pi 0.87.1. All 11 steps passed in about 35 s:

- m1 carried +1ms, seen +25.1s, acked +25.2s;
- m2 acked +122ms;
- the urgent cut came at +1.8s;
- the run landed 0.2 s after the resume.

So Pi resolves `@earendil-works/pi-ai` for a provider written into the scratch home. `~/.pi/agent/sessions` held 15 entries before and after the run.
