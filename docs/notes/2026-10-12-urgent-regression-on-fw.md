# A pane with no foreground group is waiting, not malformed

- Status: done

Regression from #69 (4702766): `parseProcesses` (`src/runtime/herdr/runtime.ts`) threw `pane.process_info: foreground_process_group_id is not a process group` for a reply without a numeric group. The leader's `doctor --contracts --verify-only` on #71's build (2026-10-12 17:38Z, Herdr 0.7.5) failed the Claude contract's launch after 0.5 s with exactly that; Pi passed, and #69's own contract run passed. A production launch hits the same path (`Launcher` → `HerdrRuntime.harnessProcess`).

## Design

**Repro (live).** `spikes/herdr/h02-process-info.sh` now also opens a lab pane, starts Claude there with `agent.start` (retrying `agent_pane_busy` as the runtime does) and reads `pane.process_info` back to back the whole time. Herdr 0.7.5, 2026-10-12, isolated lab session: of up to 2 000 back-to-back reads per start, the replies are `group = shell` at the prompt, then `group = job (1..10 procs)` while Claude starts; in two of five starts exactly one read, at the shell-to-job handoff, came back as

```json
{"process_info":{"pane_id":"w1:p1","shell_pid":91760},"type":"pane_process_info"}
```

Both `foreground_process_group_id` and `foreground_processes` are absent (Herdr omits a `None`), `shell_pid` is a valid pid. No read had a group of another type. It is a timing window, which is why the failure is intermittent: the launcher's first read lands in it only when it is fast enough. Recorded in docs/m0-verdicts.md's h02 row.

**Rule.**

- `PaneProcesses.foregroundGroup` is `number | null`. An absent or `null` `foreground_process_group_id` in a reply with a valid `shell_pid` is `null`: the pane has no foreground job Herdr can name yet, a normal state. An absent or `null` `foreground_processes` is an empty list only when the group is absent too (the handoff reply above); a numeric group with no process list still says nothing about the pane and stays `protocol`.
- Wrong types stay `protocol`, as #69 made them: no object, a `shell_pid` that is not a positive integer, a group that is present but not a non-negative integer (a string, a fraction, a negative), a process list that is present but not an array, an entry without a pid.
- Every consumer reads `null` as "not started yet, look again", never as failure or death:
  - `harnessProcess` (the launch's identity wait, polled up to `launch_timeout_ms`): no harness yet, keep polling. Only a real `protocol` reply or the deadline ends the wait.
  - `Launcher.ensurePane`: a pane is reused only when its group is the shell's, so a `null` group opens a new workspace, as any non-idle pane does.
  - `Reconciler.reconcileRun`: a live recorded process with a `null` group and not in the (empty) process list is not evidence it left the pane, so the run reads liveness `unknown` (`reason: Herdr: the pane has no foreground group yet`) for this pass, the same as a `protocol` reply, instead of `orphaned` with a divergence. A dead process still goes to `handleDeath`, whose husk test (`group === shellPid`) is false for `null`, so no husk is claimed from it.

**Files.** `src/runtime/herdr/runtime.ts` (type, parser, `harnessProcess`), `src/reconcile/reconciler.ts` (the `unknown` branch), `test/helpers/fake-herdr.ts` (`handoffReads`: the first N `process_info` reads of a pane after each `agent.start` answer the handoff reply), unit cases in `test/unit/runtime.test.ts` and `test/unit/reconciler.test.ts`, the offline contract test serving the handoff reply on every launch, `spikes/herdr/h02-process-info.sh`, docs/m0-verdicts.md (h02 row, in place), and #69's note (`2026-10-12-next-steps-md-e7.md`, its process_info rule corrected in place).

**Migration.** None: nothing persisted changes.

**Out of scope.** Retrying a genuinely malformed reply inside the launch wait (it still fails the launch, as #69 chose); any change to the launch budget.
