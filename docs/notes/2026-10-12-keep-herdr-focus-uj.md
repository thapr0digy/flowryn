# Keep Herdr focus on the leader

- Status: done
- Open: a workspace Herdr closes on its own (its last shell exited) still moves focus; see Out of scope

User report (2026-10-12): when Flowryn opens a new agent, Herdr's focus jumps from the leader's pane to a worker's workspace.

## Design

### The demonstrated boundary

Spike `spikes/herdr/h07-focus.sh` (lab session, Herdr 0.7.5, protocol 17; row in `docs/m0-verdicts.md`) does what Flowryn does and reads the focused workspace (`workspace.list`) and pane (`session.snapshot`) after each step:

- `workspace.create` with `focus: false` (the schema default, and what `HerdrRuntime.openWorkspace` already sends) and `agent.start` in the new root pane leave focus where it was, pane included. Launch was never the cause.
- `workspace.close` of a workspace that is **not** focused moves focus anyway: to the workspace that takes the closed one's slot, the new list's `[min(index, length - 1)]`. With list `a, leader*, w1, w2, w3`, closing `w1` focuses `w2`; closing a workspace listed before the focused one moves focus too (with `a, b, c, e*`, closing `a` focuses `b`). `pane.close` of a workspace's only pane closes the workspace with the same rule.
- `workspace.focus <leader>` puts focus back, and the leader workspace's own focused pane comes back with it (a split leader keeps its second pane focused).
- `notification.show` does not move focus.

The user's server log agrees: no `workspace.focus` follows any worker `workspace.create`, but the user re-focused the leader shortly after each worker workspace closed (14:15:00 → 14:16:41, 14:45:53 → 14:55:24, 15:41:16 → 15:58:32 UTC). The leader's workspace sits before every worker in the list, so a worker's close lands focus on another worker, usually the newest. A run lands and its workspace closes when capacity frees, which is when the scheduler starts the next one, so it reads as "the new agent took focus".

### The rule

- Launch (worker, scout, resume, fresh stage, contract run): keep the native option. `openWorkspace` sends `focus: false`; h07 shows that is enough, so no read-and-restore there.
- Every Flowryn `workspace.close` goes through one guarded `HerdrRuntime.closeWorkspace`:
  1. Read `workspace.list`. If nothing is focused, the target is the focused workspace, or the target is not listed, just close: no restore (nothing of the user's to keep).
  2. Close, then compute where Herdr's rule puts focus: the list without the target, at `min(index, length - 1)`.
  3. Read `workspace.list` again. Restore with `workspace.focus <previous>` only when focus is now exactly on that landing workspace and the previous one still exists. Focus anywhere else means the user moved it in between, and it is left alone.
  4. If the first read fails, close unguarded (Herdr being unreachable fails the close anyway). Errors after the close propagate to the caller, as close errors do today; every caller already treats a close failure as best effort.
- `openWorkspace` and the guarded close run one at a time per `HerdrRuntime` (a promise chain), so two runs landing together, or a launch beside a landing, cannot skew each other's landing prediction. The daemon holds one runtime; the contract runner and lab scripts hold their own against their lab session.
- `workspace.focus` joins the client's allowed methods; it is the only new Herdr call.
- Deterministic only: the landing rule is plain list arithmetic from h07. No model.

Known limit: a user who focuses exactly the landing workspace in the few milliseconds between the close and the second read gets focus put back on the leader. Nothing distinguishes that from Herdr's own move.

### Files

- `src/runtime/herdr/runtime.ts`: `closeWorkspace` guard, the serial section, `focusedWorkspace` read; `src/runtime/herdr/client.ts`: allow `workspace.focus`.
- `test/helpers/fake-herdr.ts`: workspace order and focus (`workspace.list`, `workspace.focus`, `focus` on create, h07's close rule for `workspace.close` and a last-pane `pane.close`), a `focusWorkspace` seam for the user's own focus change and an `afterClose` seam to act between the close and the runtime's second read.
- Tests: `test/unit/runtime.test.ts` (restore, nothing focused, closing the focused one, user moved focus in between, two concurrent closes); `test/integration/workers.test.ts` (with a focused leader workspace, launching workers and a run's workspace closing at cleanup leave the leader focused).
- `spikes/herdr/h07-focus.sh`, `docs/m0-verdicts.md` (h07 row).

### Migration

None: nothing persisted changes.

### Out of scope

- A workspace Herdr closes on its own (its last shell exited): no Flowryn call to guard. Restoring from the `pane.closed` event would race the user's own focus changes.
- `pane.close` is not called by Flowryn (`HerdrRuntime.closePane` has no caller), so it gets no guard.
- Focus routing of any kind (cut from v1, `docs/v1-status.md`): Flowryn never moves focus except to undo Herdr's move caused by its own close.

## Built

As designed. `HerdrRuntime.closeWorkspace` (`src/runtime/herdr/runtime.ts`) is the one guarded close; every caller (landing cleanup, cancel and stop, divergence teardown, the contract runner's lab cleanup, the lab scripts) already goes through it, so none of them changed. A guarded close costs two `workspace.list` calls, plus one `workspace.focus` when Herdr moved focus.

### Tests

- `test/unit/runtime.test.ts` "Herdr focus across workspace closes (M0 h07)", through the real client against FakeHerdr: an open leaves focus alone and sends `focus: false`; closing an unfocused worker restores the leader (and no restore when Herdr's move already lands on it); nothing focused reads the list once and focuses nothing; closing the focused workspace restores nothing; a focus the user chose between the close and the check (FakeHerdr `afterClose`) stays; two closes and an open at once keep the leader; a workspace already gone is not an error.
- `test/integration/workers.test.ts` "Herdr focus": with a focused leader workspace, a first worker launches, a second scout launches, lands and is cleaned; its workspace closes and the leader stays focused, with exactly one `workspace.focus`.
- Without the runtime change, four of the unit cases and the integration case fail (the integration case ends focused on the first worker's workspace).

### Live

`spikes/herdr/h07-focus.sh` in a lab session (Herdr 0.7.5), confirmed: `focused before=w2/w2:p2, after create=w2/w2:p2, after agent.start (idle)=w2/w2:p2, after close w1=w4/w4:p1, after workspace.focus leader=w2/w2:p2, after pane.close of w3's only pane=w4/w4:p1` (list `w1, w2(leader), w3, w4, w5`). Run it with `spikes/run-all.sh herdr` or on its own, outside a command sandbox.

