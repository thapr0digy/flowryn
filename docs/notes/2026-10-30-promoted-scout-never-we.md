# The v1 live run's promoted scout delivers again

- Status: done

`scripts/lab/v1-live.sh harness promote` failed on main twice on 2026-10-30: "promote / promoted scout shipped: timed out waiting for the local delivery; state running, liveness idle". The promotion passed: the same session came back in a new process, at stage build. After that the relaunched Pi worker ended its turn, ignored the turn-end reminder and never delivered. Running `scripts/lab/v1-live.sh promote` on its own also aborted, with `contract_unverified` for Pi. Both causes were in the lab script. Promote, the relaunch, the build stage's start and the turn-end guard all behaved as designed.

## Why the promoted scout never shipped

The scripted model plays the step that matches how many assistant replies follow the `FLOWRYN-SCRIPT:` message (`spikes/pi/lib/scripted-provider.ts`). The scout's script was `bash sleep 40 ;; <ship> ;; say DONE`, and the run promotes it during `sleep 40`. The provider log (now written to the scratch home's `provider.log`), Pi's session file and the run's events show what happens:

1. 49.273: promote. The scheduler stops the worker by its identity: SIGTERM to its process group (`exitRun`, `terminate(…, { group: true })`).
2. 49.280: the signal kills `sleep` first. Pi records the tool result `Command exited with code 137` and calls the model again, before Pi itself exits.
3. 49.335: the scripted model replies with the next step, the ship command, as a tool call. Pi writes it to the session.
4. 49.541: the process is gone (`run.exited`). The ship call never ran. Since 2026-10-09 (d747e3e) every Pi tool call first waits on `flowryn hook tool-check`, a new process, and the worker exited during that wait.
5. The relaunched worker resumes the same session. The unexecuted call counts as a reply, so the scripted model plays the step after it, `say DONE`. Then `ok` answers the turn-end reminder. Nothing commits and nothing delivers.

A real model would see the call with no result after the restart, and would read the new task file, and do the work again. The scripted model only counts. The product is not at fault: stopping a worker always races whatever its model does in that last moment, and resuming the session is what promote in place is meant to do. So the fix is in the script. The ship step is idempotent: it commits only when `promoted.txt` is missing, and it delivers only until a marker in the run's own `TMPDIR` says it delivered (that directory survives the relaunch). The script plays the step twice, `bash sleep 40 ;; <ship> ;; <ship> ;; say DONE`, so the resumed worker reaches a real ship step in every case:

- the old worker got that extra turn (what happens now): the resumed worker plays the second ship step;
- it did not: the resumed worker plays the first one, and the second does nothing;
- the old worker ran the ship step to the end: both remaining steps do nothing.

A run with the fix took the first case. Its provider log shows the old process playing steps 0 and 1 and the new process playing step 2 (the ship) and then 3.

## The phase-only path

Any phase list without `harness` seeded Pi's contract record with `contracts.record { harness, version }` and ignored the reply. That call no longer verifies anything. The script calls with the leader's token, and since contract revisions a leader's record needs the report of its own suite run. A record without a report is also at the baseline revision, which a newer revision does not accept. The dispatch then refused `contract_unverified`. The script now does what m5-live's `--seed-contracts` does. It writes the pass for the installed Pi version at `contractRevision("pi")` through `recordPass`, so the `contract.passed` event is recorded too. It writes it while the daemon is down between the two starts, so the startup check reads Pi as verified. It fails loudly when Pi's version cannot be read.

## Tests

The change is to the lab script only. `bun test` never reaches a real Pi, so the proof is the live run (below). No product code changed, so `CONTRACT_REVISIONS` stays as it is. The full `bun test` passed on the branch before delivery.

## Live run

`scripts/lab/v1-live.sh` (all phases), 2026-10-30, lab session `fl-lab-flowryn-v1-*`, Pi 0.87.1 on the offline scripted provider:

- `scripts/lab/v1-live.sh promote` alone: 5/5. The seed works, and the promoted scout committed, delivered locally, merged under yolo and was cleaned up.
- all phases: RESULT_PENDING.
