# Workers wait on no-mistakes in the foreground

- Status: done
- Open: not yet seen on a live ship (the contract lines and the deny are proven offline)

Scout finding 17 (scout-efficiency-and-fz): ship workers ran the no-mistakes pipeline as a background Bash job, ended the turn, and woke on Claude's task notification. On 2026-10-23, 187 of 354 `run.background_started` Bash events were a `no-mistakes axi run` or `respond` (146 were `bun test`, 21 other). 186 of the 187 asked for the background (`run_in_background: true`; 134 with no timeout, 49 with 600000), and one was a foreground call with a 600000 ms timeout that Claude moved to the background when it ran out. Only 9 waits polled in between, so the cost was not polling: each return cost a wake turn, and a worker idle on its own job raised 17 of the 68 `worker_idle` items the leader had to dismiss. The predecessor made the same change (firstmate `fd325b1b`: one foreground drive call, never a background poll).

## What changed

Plain code and fixed text, no model.

- **Contract lines** (`src/harness/contract-text.ts`, `waitLines`): a no-mistakes ship's delivery lines, after the stage-begin line, say to drive the pipeline with one foreground `no-mistakes axi run --wait` per call, with the harness's shell timeout (Claude `Bash timeout 600000`, Pi `bash timeout 600`, otherwise "a 10-minute shell timeout"), never backgrounded and never polled with `axi status`; a call that returns on elapsed wait is run again at once, and after `respond` the worker reattaches with `axi run --wait`. `ContractDelivery` gained an optional `harness`; the launcher, the stage text and the promotion note pass the run's. Direct-PR and local-only ships do not carry the lines.
- **Toolkit rule `pipeline`** (`src/policy/toolkit.ts`): a Bash call with `run_in_background: true` whose commands (through the shell normalizer, so `cd x && …` counts) include `no-mistakes axi run` or `no-mistakes axi respond` is denied, with a reason naming the foreground call and the timeout. It applies to workers and leaders alike (a leader never drives a pipeline). It holds in the hook process like every toolkit rule and records `toolkit.denied` with rule `pipeline`. `axi status` and every other background job (a `bun test`, an agent) still pass.

## Why it holds

- no-mistakes' `--wait` defaults to 8 minutes (v1.84.0 `axi run --help`), under Claude's 10-minute Bash cap. The lines pass no duration.
- Claude's default Bash timeout is 2 minutes, and a call that outlives its timeout is moved to the background rather than killed (seen on this ship's own session). That is why the lines name `timeout 600000`: without it, a foreground wait becomes a background job after 2 minutes, which the hook cannot see.
- A worker in one long call stays busy: the pre-tool hook's busy lease is 10 minutes (`busy_lease_ms`) and the stale-hook pointer 30 (`stale_hook_ms`), so an 8-minute wait plus its overhead raises no `worker_idle`, `run.stale_hooks` or `blocked_prompt` while Herdr reads "working". `test/unit/foreground-wait.test.ts` names that assumption; at 11 minutes the same pass reads the worker idle.
- A normal steer waits for the next tool call, so up to 8 minutes during a wait; an urgent steer still cuts the call short.

## Choices

- **Text and enforcement.** The text tells the model; the hook makes the background call impossible (deterministic first).
- **No `CONTRACT_REVISIONS` bump.** The contract suite drives no no-mistakes pipeline, and its toolkit step proves the deny path with `gh`, which did not change (as with settle-routine-no-2r).
- **No change to Claude's default Bash timeout** in the worker settings: it would give every hung command 10 minutes and change the adapter.
- **Pi gets the text only:** its bash tool has no background mode.
- **Not denied:** shell `&`, `nohup` or `disown` around a no-mistakes call (not seen in the data; the normalizer does not model them), and a foreground call Claude moves to the background after its timeout.
- **Background `bun test` stays allowed** (146 starts): a full suite can outlast 10 minutes. A follow-up, not this change.

## Tests

- `test/unit/harness.test.ts`: the lines by harness, their place after the stage begin, and their absence in other modes.
- `test/unit/toolkit.test.ts`: denied background `run` and `respond` (plain, after `cd`, piped), allowed in the foreground, `axi status` and `bun test` in the background allowed, a leader held to it.
- `test/integration/toolkit.test.ts`: the deny through the real pre-tool hook, and the foreground call allowed.
- `test/unit/foreground-wait.test.ts`: the busy-lease assumption above.
