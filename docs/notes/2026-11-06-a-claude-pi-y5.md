# A Claude or Pi update never refuses a dispatch

- Status: done
- Open: the contract body's new line is not yet proven against a live Claude run (the flake it fixes showed up about one run in three)
- Config: `[contracts] version_poll_ms`

Claude Code updates itself while the daemon runs (2.1.318 → 2.1.319 overnight on 2026-11-06). Before this change, the first dispatch after an update found the new version, flagged it and refused it (`contract_unverified`) in the same call. The automatic contract check (src/contracts/auto.ts) had not started yet, so the refusal's help named `flowryn doctor --contracts --harness claude`, and the leader asked the user whether to spend model calls on it. Resume and `dispatch --kind ask` refused the same way, and a ready plan phase opened a `phase_blocked` P1.

## What happens now

In relaxed mode (`[policy] mode = "relaxed"`), on a daemon that can run the automatic check from its own build (`meta.contract_auto_build` set; a compiled build with its pinned copy), work that meets an untested harness version waits instead of being refused:

- **Dispatch** (`now`, `--task`, a Queued task), **plan-phase starts**, **promote** and **review-gate revival** go through `checkStart` (src/lifecycle/dispatch.ts), which no longer throws for an untested version when `waitsOnAutoCheck` (src/lifecycle/harness-gate.ts) holds. The run is created as usual (`pending_launch = 'fresh'`) and waits on the scheduler's grant, which already gates the harness before every launch (src/sched/scheduler.ts). The reply reads `state: waiting` and `waits: waits on the automatic contract check for claude 2.1.319; starts by itself once it passes`. After a final failure it reads `waits for claude 2.1.319 to pass its contract suite: the automatic check failed (see the harness P1; flowryn doctor --contracts --harness claude); …`.
- **Resume** waits the same way: `resume.prepare` returns `waitsOnCheck`, and `apply` always takes the scheduler path (`pending_launch = 'resume'`), even for a run still holding its worker lease, so only the grant launches it.
- **Ask**: `prepareAsk` queues it. `drainAsks` (src/ask/runner.ts, now async) runs the gate once per harness per drain (`where: "ask-launch"`) and holds any ask whose harness is `unverified`. A version that cannot be read does not hold an ask: the call reports its own failure, as before.

Strict mode, or a daemon that cannot run the check (a development command, no pinned copy): the refusal is unchanged. A harness that is not installed, or whose version cannot be read, still refuses (`tool_missing`) in every mode.

## Never on an untested version

The grant gates the installed binary at grant time (`gateHarness`, `where: "launch"`). So if Claude updates again while a run waits, the grant refuses it with the newer version's reason, and the run launches only after that version passes. The grant also writes the version it verified into `runs.harness_version` when that differs from the one recorded at dispatch, with a `run.harness_version` event (`{harness, from, to}`), so the run's record names what actually launched. Passes are recorded only as before: by the daemon from its own build's report, or by `contracts.record` from your terminal. No worker or reader verb can mark a version verified.

## One retry

`AutoAttempt` has a `try` (absent means 1; `AUTO_TRIES = 2`). A first failure of any kind, a timeout included, is recorded as its own attempt: a `contract.auto_failed` event with `try: 1, final: false`. The attempt goes back to `waiting` with `wait: "a retry (try 2 of 2) after a failed first attempt"` and no P1, and the next tick runs the check again. The retry carries no manifest, because the first try's manifest is already settled, so a restart never releases it twice. A hold while waiting (a restart, Herdr down, a usage pause) and a daemon restart both keep `try: 2`. A second failure is final, as a failure was before: `try: 2, final: true`, `state: failed`, and one `harness_unverified` P1 naming the report and the doctor command. While automatic checks are on, the scheduler's 30-minute `capacity_wait` P1 leaves out launches (`pending_launch`) held on a harness whose installed version is untested, while a running ship's stage that waits on capacity still counts: a long check (two tries, holds included) never raises a capacity alert, and a final failure has its own P1. Work waiting on the version stays waiting, and any later pass (`contracts.record` kicks the scheduler) releases it.

## The version poll

`HarnessVersionPoller` (src/contracts/version-poll.ts), started next to the checker, runs the gate (`where: "poll"`) for every harness in use, every `[contracts] version_poll_ms`. The default is 600000 (10 minutes); 0 turns the poll off, and any other value must be at least 10000. The version read is the gate's own `harnessVersion` (runBounded, cached by the binary's mtime). A newly flagged version logs a line and kicks the checker, so the check usually starts before anyone dispatches. The poll waits while a restart is pending. A harness whose check throws is logged, and the poll goes on to the next. The spec named a separate `harness.polled` event; it was left out because the `harness.unverified` event with `where: "poll"` already records the find.

## The flaky "deliver while idle" step

Detail on failure: "the worker delivered before m2 (run landed); m2 carried +0ms, not seen for 1ms". The report from the manual run on 2026-11-06 (`claude-2.1.319-2026-11-06T12-29-41-051Z.json`) shows `idle` passed after 30.1 s, much like the passing rerun's 28.9 s. The run had landed before m2 existed. The worker contract tells a worker to "End each turn with an outcome (stage done, deliver, …)", and a scout's outcome is deliver. The contract body only said "reply with the single word ONE and end your turn", so the real model sometimes delivered at the end of its first turn. This is model behaviour under conflicting instructions, not a timing race. (The turn-end guard is already off for contract runs.) The fixes:

- `contractBody` gains `CONTINUES_LINE` (src/contracts/suite.ts): the task goes on through the leader's steers, and the worker must not deliver, report or run stage done until a steer tells it to deliver.
- The `idle` step now fails at once, with that cause, when the run has landed or ended, and it requires `idle_since` (the turn-end hook's mark), not only `liveness`.

No step was added or removed, and the paths the suite proves are unchanged, so `CONTRACT_REVISIONS` is not bumped and recorded passes stay valid. The offline fakes match the body and steers by regex and needed no change. Even if the line does not fully stop the flake, the retry absorbs a single failure.

## Leader

The leader skill (src/bridges/skill.ts) says: a reply that `waits` on the contract check gets one line of report and nothing more, and in relaxed mode the leader never asks the user to run doctor.

## Tests

- test/unit/auto-contract.test.ts: the retry (a first failure has no P1, the second opens one), a flake (fail then pass, no P1), and the retry kept across a hold and a restart.
- test/unit/ask.test.ts: an ask on an untested harness version stays queued with no call, and starts after the version passes.
- test/unit/version-poll.test.ts: the poll flags a new version with no dispatch and kicks the check, waits on a restart, survives an unreadable or throwing version read, and the config key's bounds.
- test/integration/auto-contract.test.ts (compiled daemon): a relaxed dispatch waits, with no `capacity_wait` P1 while the check runs, then launches after the automatic pass; a failing check (both tries) keeps it waiting with one P1, and a manual pass releases it; an update while waiting is gated again at the grant and launches on the newer version's pass, recording it; a resume on an untested version replies `state: waiting` and launches only after the automatic pass; strict still refuses.
