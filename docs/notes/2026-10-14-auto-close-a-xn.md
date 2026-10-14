# Auto-close a report item once the leader has read it

- Status: done

`flowryn stats` (docs/notes/2026-10-13-measure-waiting-time-na.md, rule U1) showed 31 of 33 leader dismissals in a week had no follow-up, mostly `worker_report` (16) and `report_ready` (5): the leader runs `flowryn show <item>`, reads it, then has to `flowryn dismiss` it. Reading now closes it. Deterministic; no model; no schema change. The design was approved on its review page with the status list below (q70: `finding risk regression`).

## Design

### Who and where

- Only a caller whose role is `leader` (its session holds the lease) closes an item by reading it. A `reader`, a `human` (token-less CLI) and the read-only fallback never do; workers cannot call `show`.
- `show` stays a `read` verb. The read builds its reply as today and lists, beside it, the item ids whose whole report it printed. The gateway then runs the verb's new `afterRead` hook in its own transaction, on the daemon only, and only for that hook's verb; the read-only fallback (`src/cli/client.ts`) never calls it. The hook (show's) checks the role and calls `closeReadItems` in `src/attention/read-close.ts`, which holds the rule. The gateway decides nothing: it calls the hook if the verb has one.
- A failed close does not fail the read: the reply comes back with `read: not closed (<reason>)` and the daemon logs it.

### What counts as read

| show form | prints | closes |
|---|---|---|
| `show <worker_report item>` | the report's whole stored body (it is never cut: at most 4 000 chars, printed whole today) | that item |
| `show <report_ready item>` | new view: the scout's `report.md`, first 60 lines of 200 chars | that item, only when nothing was cut |
| `show <report_ready item> --full` | the whole report | that item |
| `show <task\|run> --full` | new field `reports`: each open `worker_report` of the run with its whole body; for a scout, new field `report_body`: the whole report | each of those items |
| `show <task\|run>` (no `--full`) | item lines, possibly cut; no report body | nothing |
| `--timeline`, `--why` alone, decisions, gates, plans | no report body | nothing |

A report file that is missing or unreadable prints `-` with the reason and closes nothing. The `report_ready` line for new items points at `flowryn show <task> --full`.

### Which statuses close (worker_report)

Every `worker_report` comes from a status that opens an item (`REPORT_EFFECT`, src/lifecycle/worker.ts), so "only informational statuses" would close none (informational words never open one). The rule, a fixed list beside `REPORT_EFFECT`:

- **Close on read** (the worker tells the leader something and carries on): `finding`, `risk`, `regression`.
- **Stay open** (the worker cannot go on, or something failed that needs a leader move): `blocked`, `stuck`, `failed`, `failing`, `error`, `broken`, and any word not in the table.

On the live database every one of the 18 dismissed reports was `finding` (16) or `blocked` (2). `report_ready` always closes on read: the scout's open decisions are their own decisions and items, and stay open.

### The resolution

- `items.state = 'resolved'`, `resolved_by = 'read by leader'`, `resolved_at = now`; the item's wait explanations close with it (`closeItemExplanations`). An item already resolved or dismissed is left alone, with no event, so reading twice is a no-op.
- One `item.read` event per closed item, in the same transaction: payload `{ item, kind, status, by: "leader", session, form }` (`form` is `item`, `item-full` or `run-full`).
- `items.state` and `resolved_by` are free text and the event kind is new, so no migration.

### Who sees it

- The turn-end relay (`relayBatch`), the digest, the briefing and `fleet` needs (`report`, `read`) read only `open`/`presented` items, so a read-closed item is never carried again. A test pins each.
- `show`'s reply gains `read: closed <ids>` and drops the `flowryn dismiss` hint.
- The relay footer and the leader skill (`src/bridges/skill.ts`) say that `flowryn show <id>` reads a report whole and closes it.

### Stats

- `item.read` is not `item.dismissed`, so it never counts as a `dismiss` intervention or in U1's `of`; it is not an intervention at all (the leader only read), so it is no U1 follow-up either.
- U1's `detail` adds `; closed on read, not dismissed: <kind n, …>` when the window has any, so the drop in dismissals shows where it went.
- The `item <kind>` wait of a read-closed item ends at its `resolved_at`, as any resolution.

### Tests

- `test/unit/read-close.test.ts`: a leader closing a `finding` writes the state, `resolved_by` and the `item.read` event in one transaction; `blocked`, `error` and an unknown word stay open; `report_ready` closes; an item already dismissed gets no event; a non-leader role closes nothing.
- Through the gateway (fake daemon, real `show`): leader `show <item>` closes; reader and human `show` do not; a `report_ready` view that was cut does not, `--full` does; `show <task>` does not, `show <task> --full` closes each closable open report and leaves a `blocked` one open; the read-only fallback closes nothing.
- `relayBatch` and the briefing skip a read-closed item.
- `test/unit/stats.test.ts`: an `item.read` is neither a dismissal nor a U1 follow-up, and shows in U1's detail.

## Build

- `src/attention/read-close.ts`: the rule (`READ_CLOSES_STATUSES`, `closesOnRead`) and `closeReadItems`, which re-reads each item inside the transaction, so an item closed meanwhile, or one whose status needs action, gets no event.
- `src/api/verbs.ts`: `VerbSpec.afterRead` and `HandlerResult.reportsRead` (the items a read printed whole). `src/api/gateway.ts` runs `afterRead` in its own `tx` right after `read` and builds the reply from `data` and `hints` only, so `reportsRead` never leaves the daemon; the read-only fallback (`src/cli/client.ts`) never calls it. A thrown `afterRead` rolls back, is logged, and the reply carries `read: not closed (<reason>)`.
- `src/lifecycle/leader-verbs.ts`: `show`'s `afterRead` (leader only) closes them and adds `read: closed <ids>`, sets the item view's `state` to `resolved` and drops `flowryn dismiss` hints for closed items. New views: `scoutReportView` for a `report_ready` item (the report file from its `report` artifact, at most 1 MB as deliver accepts, its own `ShowText` so only the body's cut decides) and `fullReportsView` for `show <task|run> --full` (`reports` and, for a scout, `report_body`).
- `src/lifecycle/worker.ts`: a new `report_ready` line points at `flowryn show <task> --full`. `src/attention/router.ts` relay footer and the leader skill (`src/bridges/skill.ts`) say that showing a report closes it unless it needs action.
- `src/attention/stats.ts`: `readClosures` counts the window's `item.read` events by kind (same `--project` filter and row cap as the other event reads); U1's `detail` appends `; closed on read, not dismissed: <kind n, …>`.
- Not a worker-path change, so no `CONTRACT_REVISIONS` bump.

### Tests

- `test/unit/read-close.test.ts`: the status table against `REPORT_EFFECT`; the leader's close writes state, `resolved_by` and one `item.read` event; `blocked`, `error` and an unknown word stay open; reader, human, worker, hook and anonymous close nothing; an already dismissed item and a second read get no event; through `show`'s read and `afterRead`: the item view closes a finding and drops the dismiss hint, a `blocked` one stays open, reader and human stay pure reads, `show <task>` closes nothing and `--full` closes the finding but not the `blocked`, a `report_ready` that fits closes, one cut by lines or by a long line does not and `--full` does, an unreadable report file closes nothing, `show <scout> --full` prints and closes; `relayBatch` and the briefing carry an open finding and drop it once read.
- `test/unit/gateway.test.ts`: `afterRead` runs in a transaction and `reportsRead` is not in the reply; a throwing one rolls back and the read still answers.
- `test/unit/stats.test.ts`: `item.read` is neither a dismissal nor a U1 follow-up, and U1's detail counts it, with `--project`.
- `test/integration/worker-reports.test.ts`: the leader's `show <item>` through the real CLI closes a finding (`item.read` recorded, `dismiss` then refused as already resolved, fleet no longer says `report`); an unknown status stays open and `dismiss` closes it; a daemon-served show closes, the read-only fallback's leaves the next finding open.
