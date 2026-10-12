# Review-channel health

- Status: done
- Open: not run against a real failing Lavish (the fake lavish-axi and scripted ones only); the reasons and exits are lavish-axi 0.1.65's, read from its `dist/cli.mjs`
- Config: `[review] channel_alert_ms`

`docs/next_steps.md` package 3, the bounded second slice: say when a review page stops delivering answers. On 2026-10-11 Lavish answered 500 to every request; the daemon's polls failed and backed off in silence, and a worker waited on a review nobody could answer until the leader noticed.

## Design

### The boundary

`LavishPoller` (`src/lavish/poller.ts`) runs one `lavish-axi poll <page>` per open review gate. A poll that exits non-zero is counted in an in-memory `failures` map, backs off (2 s doubling to 60 s) and is logged to the daemon log, nothing else. lavish-axi 0.1.65's `poll` (`dist/cli.mjs` `pollCommand`/`fetchJson`) exits at once on a non-2xx reply (`Lavish Editor request failed: 500`, `SERVER_ERROR`), on a server it cannot reach after 3 retries 500 ms apart (`Lavish Editor server connection failed`), and on a missing session (`NOT_FOUND`); a healthy poll holds its request open until the user sends something. So a dead channel is a stream of quick exits, and nothing in the database, the items or `flowryn show` sees them: the opener's `open_state` says `opened` (the page reached the browser once), the gate says `open`, and the failure count dies with the daemon.

The repro is a unit test in `test/unit/gate-questions.test.ts`: a poller whose lavish-axi always prints `error: Lavish Editor request failed: 500` and exits 1, driven pass by pass with an advancing clock past the threshold. Before this change the gate row holds nothing about the channel and no item opens.

### The rule

1. **Persisted per gate** (migration 20, `gate-channel`, columns on `gates`):
   - `channel_ok_at`: when Flowryn last saw the channel turn healthy (its first poll listening, or a recovery).
   - `channel_failing_since`: the first failure of the current failing episode; `NULL` while healthy.
   - `channel_failures`: consecutive failed polls in the episode (`0` while healthy). The backoff is computed from it, so it survives a daemon restart.
   - `channel_reason`: why the last poll failed, one sanitized line (at most 160 characters).
   - `channel_retry_at`: when the poller tries again.
   - `channel_item`: the degraded-channel item this episode opened, if any.
   All `NULL`/`0` on existing gates: an upgrade says nothing about a channel it never watched.
2. **What counts.** A failure is a non-final poll of a polled gate that exits non-zero or cannot be spawned. Healthy is a poll that exits 0 (it delivered, or Lavish timed it out empty), or one still running `STEADY_MS` (15 s, a constant in `poller.ts`; a failing poll exits within seconds) after it started. The short `final` poll that only carries a reply for a gate no longer polled counts for nothing.
3. **Only changed observations are written.** Each failure writes the gate's channel columns and a `gate.channel_failed` event (`{gate, failures, reason, retry_at}`), at most once a minute per gate once the backoff peaks. Healthy is written only on a change (unknown or failing → healthy): `channel_ok_at`, clears the failure columns, and a `gate.channel_ok` event (`{gate, via: listening|delivered, recovered}`). A healthy poll after a healthy poll writes nothing.
4. **Degraded threshold.** When a failure leaves the channel failing for at least `[review] channel_alert_ms` (default 120 000, two minutes; `0` is allowed, for tests) **and** at least 2 consecutive failures, and the gate has no open channel item, one `review_channel` item opens (P1, actionable) in the same transaction, with a `gate.channel_degraded` event. Two failures, so one failure after a long daemon outage is not enough by itself. At most one item per gate per episode: further failures update the gate's columns, not the item.
5. **The item is actionable.** Its line leads with the action, then the task, gate, since when and why: `Review page not delivering answers: <hint>. <task> (<stage> gate gN) since HH:MM, N failed polls: <reason>; Flowryn retries by itself. Until then answer through the leader (flowryn decide)`. The hint depends on the reason: a missing session (`NOT_FOUND`) reads "the worker hosts the page again with lavish-axi --no-open <page>"; a binary that cannot run reads "check [tools] lavish_axi"; anything else (a server error or no server) reads "restart Lavish (lavish-axi server --verbose; its log is ~/.lavish-axi/server.log)", Lavish's own recovery hint.
6. **Resolution.** The item resolves, with a `gate.channel_cleared` event, when:
   - the channel turns healthy (rule 2): resolved by `gate.channel_ok`;
   - the gate closes: a pass or changes verdict and promote resolve `review_channel` with the run's other gate items (`src/lifecycle/stages.ts`, `src/lifecycle/promote.ts`), and a cancelled run resolves all its items already;
   - anything else stops the polling (the run failed or was cleaned, the user ended the Lavish session, lavish-axi is no longer installed): each poller pass resolves an open channel item whose gate is not polled any more.
7. **Without Lavish, no item.** With no lavish-axi installed the poller starts no poll, so nothing fails and no item opens: running without the optional Lavish is a choice, not a fault (the existing "answered only through the leader" log line stays). A page file that is gone is also not a channel failure (its own existing log line; out of scope).
8. **Recovery never decides.** Rules 2–6 touch only the gate's `channel_*` columns, the `review_channel` item and their events. They never change `gates.state`, `approval_id`, a decision or an approval; a recovered channel just lets the next poll deliver what Lavish kept.
9. **Distinct from opening the browser.** The opener's `open_state`/`open_detail`/`open_at` are untouched; `flowryn show` prints the channel as its own segment after the browser's.

### `flowryn show`

Each open review gate with a page and a known channel adds one segment:

```
g7 review design: open http://127.0.0.1:4387/session/… page …/design.html; browser: opened 14:02 (opened in Google Chrome); channel: listening since 14:02
g7 review design: open …; browser: opened 14:02 (…); channel: failing since 14:05, 3 failed polls (error: Lavish Editor request failed: 500); next try 14:06
g7 review design: open …; browser: opened 14:02 (…); channel: DOWN since 14:05, 6 failed polls (error: Lavish Editor request failed: 500); next try 14:09; item i42
```

A gate whose channel was never seen (no lavish-axi, or not polled yet) adds nothing.

### Files

`src/db/schema.ts` (migration 20), `src/lavish/channel.ts` (new: the health writes, the threshold and the item, the sweep, the `show` segment), `src/lavish/poller.ts` (calls it; the in-memory failure count goes), `src/attention/items.ts` (`review_channel` in the lane table), `src/config/leader.ts` (`[review] channel_alert_ms`), `src/daemon/daemon.ts` (passes the setting), `src/lifecycle/stages.ts` and `src/lifecycle/promote.ts` (resolve on gate close), `src/lifecycle/stages.ts` `GateRow`, `src/lifecycle/leader-verbs.ts` (`show`).

Tests: `test/unit/db.test.ts` (migration 20 on a database in use), `test/unit/gate-questions.test.ts` (the repro, the threshold, one item per episode, recovery by delivery and by a steady poll, closure, no item without lavish-axi, recovery never passes or answers, a final poll counts for nothing, a restart keeps the count), `test/unit/review-opener.test.ts` (the `[review]` key; the opener's state is untouched by channel failures), `test/integration/gate-questions.test.ts` and `test/integration/review-open.test.ts` (through the daemon and the fake lavish-axi: queued `*.fail.out` polls open the item and `show` says `DOWN`; a delivered poll resolves it and `show` says `listening`; the gate stays open with no approval).

### Out of scope

The rest of package 3 (decision explanations, a timeline, a diagnostic export). A page file that disappeared. Presence probing of a running poll (the opener's WebSocket) as a second health signal: the poll's own exit is the evidence. Notifying the worker: its gate waits either way, and the leader holds the item.

## What was built

As designed. Choices the design left open:

- **`STEADY_MS` is 15 s and not a setting.** It only has to be longer than a failing poll takes to exit (lavish-axi's connection retries take about 1.5 s); `PollerDeps.steadyMs` shortens it in tests.
- **The item does not wake an away leader** (`AWAY_WAKE_KINDS` is unchanged): while you are away the leader asks in chat anyway, and the gate_ready item that does wake it is still open.
- **The leader skill** (`src/bridges/skill.ts`) gains one sentence: a review_channel item means answers sent on the page are not arriving; tell the user, relay the fix, take answers in chat meanwhile; it resolves by itself and never passes the gate.
- **A failed last poll** (the short one that only carries a reply for a gate no longer polled) is logged and its reply dropped, as before, and counts for nothing.
- `test/unit/leader-repin.test.ts` pinned `LATEST_SCHEMA_VERSION` to 19; it now checks at least 19.

## Configuration

```toml
[review]
channel_alert_ms = 120000  # a review page's polls fail this long (and at least twice) before a review_channel item opens; 0 = at the second failure
```

A whole number of milliseconds, 0 or more; anything else is `config_invalid`.

## Tests

- `test/unit/gate-questions.test.ts` "review-channel health": the repro (a lavish-axi failing like Lavish's 500, driven pass by pass on an advancing clock: persisted on the gate, no item at two failures in a minute, one item at the third past two minutes), one item per episode, recovery by a delivered poll and by a poll that keeps running (written once; a restarted poller writes nothing more), the failure count and backoff across a restart, the item resolved when lavish-axi is gone, the run fails or the gate passes, nothing without lavish-axi, the reasons and hints, and the `show` segment.
- `test/unit/db.test.ts`: migration 20 on a database in use. `test/unit/review-opener.test.ts`: the `[review]` key.
- `test/integration/review-open.test.ts`: through the daemon, two queued `*.fail.out` polls open the item, `show` says `DOWN … ; item iN`, a delivered poll resolves it and `show` says `listening`; the browser state stays `opened` and the gate stays open with no approval.
- `test/integration/gate-questions.test.ts`: the questions wait while the channel is down; the answer Lavish then delivers is recorded as any page answer is, and nothing passes.

0.23.0. `PROTO` stays 6: no verb or envelope changed (`show`'s gate lines are strings and gain a segment).
