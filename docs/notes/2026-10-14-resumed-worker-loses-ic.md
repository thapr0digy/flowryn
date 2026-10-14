# A resumed worker keeps the run's environment

- Status: done
- Open: not yet run live against a real Herdr restart

**Seen live** (2026-10-14, run `r01M4XES60X5BC15VVMGYC24YXZ`, Claude 2.1.299). The worker died in its design review and the reconciler resumed it (`husk: true`, pane `w5T:p1`). The resumed Claude had no `$FLOWRYN_BIN`, `FLOWRYN_TOKEN` or other run variables, so none of its hooks reached the daemon. Liveness stayed `blocked_dialog` ("has not started 30s after its launch") for over 100 minutes while the worker worked. The ship-stage steer `m295` waited over an hour, and validation was reported stuck with its slot held.

**Cause.** The Herdr server restarted at 15:04:49 UTC. Its process start time matches, and so do the pane shell's (15:04:52) and the resumed Claude's (15:04:59). That restart killed the worker and restored pane `w5T:p1` under its old id with a fresh login shell. The shell carried the server's environment only: the env that `workspace.create` gave the workspace is not restored. `Launcher.ensurePane` reused any run pane whose shell read idle at its prompt, and `agent.start` has no env of its own (M0 h04). So the resume typed `claude --resume …` into a shell without the run's variables. A pane's env is set only when its workspace is created, and Flowryn cannot tell whether a pane's current shell is that one.

The `blocked_dialog` hold followed from that. The trust wedge (`liveChecks`) treated a run as started only after a worker-start hook since the latest launch. A worker whose hooks cannot reach the daemon never sends one. Other hooks did not count either: a `prompt` or `stop` hook set liveness `busy` or `idle`, then the next pass set `blocked_dialog` again. Steers wait on hooks (the waiter, PreToolUse, Stop) or on the idle carry, and the idle carry needs liveness `idle`. So nothing could deliver them.

**Fix.**

- `Launcher.ensurePane` never reuses a pane. Every launch, resume, stage launch and relaunch opens a new workspace with that launch's env. That env includes `FLOWRYN_BIN` and a `PATH` shim from the current daemon, so it is right even after an upgrade or config change. The previous workspace is closed as before (`closeReplacedWorkspace`), except after an escalated start (`escalatedStart`), whose process may still live there. A resume now always shows the worker in a new Herdr workspace.
- Any worker hook since the latest launch ends the trust wait, not only worker-start. Claude runs no hook before its trust dialog is answered, so any hook proves no startup dialog holds the pane. The reconciler counts `last_hook_at >= launched_at` as started. `markBusy` and `markIdle` resolve an open `trust_dialog` item, as they do `blocked_prompt`. The isolation check still happens only at worker-start.
- The trust item's text and its `dialog.trust` explanation now also name the other cause: "a dialog may hold pane P, or its hooks may not reach Flowryn". The unblock reads "clears it when any hook of the worker arrives". The `dialog.trust` row in `2026-10-12-next-steps-md-wz.md` and the worker-workspace line in `docs/cutover-notes.md` are corrected in place.

**Not done, and why.** Herdr's agent status does not release the trust wait. A Claude worker that runs without hooks (Herdr reads it `working`) still shows as `blocked_dialog`. Spike c12 measured Herdr's status during a permission dialog only, never during Claude's startup trust dialog. If a trust dialog read `idle`, releasing it would let the idle carry type a steer pointer and Enter into the dialog, which would accept it. Flowryn never answers a dialog with keys. With the env fix, a resumed worker's hooks reach the daemon, so this case needs a hook-less worker from some other cause, and the new item text points at it.

**Dialog-gone check on a resumed run.** This already worked. The prompt-wedge rules (`liveChecks`: `working` releases at once, `idle`/`done` after two settled reads, `null`/`unknown` hold) read only the run's `pane_id`, `launched_at` and Herdr's status, all of which the resume updates. A new test proves it.

**Contract revision.** Unchanged. The offline and live contract suites never covered pane reuse or the trust wait's release. A worker's launch command, hooks and settings are the same.

**Tests** (each fails without its fix):

- `test/integration/workers.test.ts` "a resume after a Herdr restart relaunches with the run's env, though the restored pane's shell lost it". `FakeHerdr.restartServer()` kills every harness and clears each pane's env, as the restored shell has none. Before the fix, the resumed fake worker ran without env, sent no worker-start and died again.
- `test/integration/workers.test.ts` "any worker hook after the launch, though no worker-start came, ends the trust wait, and a steer queued meanwhile is carried". Before the fix, the `trust_dialog` item stayed open after a `prompt` hook.
- `test/integration/workers.test.ts` "a worker killed mid-run is resumed once…" now expects a second workspace and the first one closed, where it used to expect the pane reused.
- `test/integration/prompt-wedge.test.ts` "claude, resumed: the dialog-gone check releases a resumed worker's prompt hold as it does a first launch's".
- `test/unit/explanations.test.ts` has the new trust wording.
