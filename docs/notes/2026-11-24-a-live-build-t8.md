# A live build dashboard

- Status: done
- Open: estimates not yet compared against real verifies; whether a worker's Claude sandbox can reach a loopback port is unchecked

“How far away are we?” used to mean asking the leader, which stitched an answer from `flowryn capacity`, `verify show`, `show` and `show lb<N>`. The daemon now serves one read-only page that answers it and refreshes itself: each running verify with its steps, elapsed time and an estimated time left; the verify queue with when each request should start; each project's landing line; live landing batches; the runs waiting for a slot; the pools and the host check. Open it once and leave it open.

## Using it

- `flowryn dashboard` (you or a leader) prints the URL and opens it in the `[review] browser`, as review pages open (`FLOWRYN_OPENER`: `record:<file>` records it, notifications off opens nothing). Exit `not_ready` with the reason when the daemon serves no page, `daemon_unavailable` when it is down.
- The URL is `http://127.0.0.1:47820/`, fixed in code (below macOS's ephemeral range), so a bookmark keeps working across daemon restarts. `ping` (and `flowryn daemon status`) reports it as `dashboard`, or `dashboard: null` with `dashboard_why`.
- `FLOWRYN_DASHBOARD_PORT=<n>` moves it (`0`: any free port, which the tests use) and `FLOWRYN_DASHBOARD_PORT=off` turns it off. A home with `FLOWRYN_NOTIFY=off` and no override (the tests, the lab, the contract homes) serves none, so only your own daemon ever takes the fixed port and a lab daemon can never show its state at your bookmark. No config key: a key only if a clash is ever reported.
- A taken port is logged and tried again every 30 s (a restart's old daemon may still hold it); the daemon never fails over it.

Each id on the page is a button that copies its command: `flowryn verify show v<N>|vq<N>`, `flowryn show <task>`, `flowryn show lb<N>`. PR numbers link to GitHub.

## How it works

`src/dashboard/`: `status.ts` builds the summary, `eta.ts` the estimates, `server.ts` the listener, `page.html` the page, `verbs.ts` the verb. The summary reads through the terminal views' own functions (`runningVerifications`, `queuedRequests` and `waitingOn`, `projectLine` with `landingCell` and `landingProgress`, `liveBatch` with `batchLine`), and the body of `flowryn capacity` moved into `capacityView` (src/sched/verbs.ts), which the verb calls with its caller's scope lens and the dashboard with every scope's, as the board sees. Nothing new is stored but a step's `started_at` inside the existing `verifications.steps` JSON (set by the runner when a step starts, again on a retry after a hang; absent on older rows).

The page polls `GET /api/status` every 2 s while its tab is visible (the board's refresh), pauses while hidden, and fetches at once when shown. One built summary answers every tab for a second. When the daemon is unreachable the page says so, greys the last picture with its time and keeps polling; when the summary's `build` changes (a restart onto a new release) it reloads once.

## The estimate rule

- A step's usual time: the median of its last 5 clean passes in the project (one attempt, no hang, no flake rerun), from `recentPasses` (src/verify/deadline.ts), whose max the step deadlines keep using.
- A running verify's time left: steps of one group run at once, groups in order. In the current group, the longest of each unfinished step's usual time less what it has run; for each later group, its longest usual time; summed. A step past its usual time adds nothing and shows as “over the usual” (`over_ms`). Any unfinished step with no history: no estimate (`eta: null`, `eta_why: "no history for <step>"`). Passed and skipped steps count nothing.
- A step without `started_at` (a row from before this change) counts from its group's start (the verify's start plus each earlier group's longest step), marked `approx`.
- A project's typical whole verify: the median length of its last 5 passed verifications.
- A queued request: each validation slot is free at its running verify's time left (or its project's typical length less what it has run; 0 for a free slot). A running verify past its usual time (a step over the usual, or past the typical length) gives its slot no time: it is unknown, not free now. In queue order each request takes the earliest free slot for its project's typical verify. A slot whose time is unknown might free first, so then only a slot free now gives a start. A request waiting on its own PR steps aside with that reason; a daemon restart holding verifies, a failing host check, or no validation slot for verifies at all give every request that reason instead. Once one estimate is unknown, every request behind it has none.

The page labels every one “(estimate)”.

## `/api/status`

GET or HEAD only. Version 1:

```json
{
  "version": 1, "build": "…", "now": 0,
  "verifies": [{ "id": "v412", "request": "vq598", "project": "flowryn",
    "for": { "kind": "task|batch|pr", "id": "…", "title": "…" }, "pr": "https://github.com/…/pull/211|null",
    "head": "1a2b3c4d", "started_at": 0, "elapsed_ms": 0,
    "eta": { "left_ms": 0, "basis": "median of each step's last 5 clean passes", "over_ms": 0 }, "eta_why": null,
    "current": ["bun test"],
    "steps": [{ "name": "bun install", "group": 0, "state": "passed", "ms": 0, "elapsed_ms": null, "usual_ms": 0, "approx": false }],
    "show": "flowryn verify show v412" }],
  "verify_queue": [{ "id": "vq599", "project": "…", "for": {}, "pr": null, "position": 1, "waited_ms": 0, "why": "behind vq598",
    "eta": { "starts_in_ms": 0, "done_in_ms": 0 } , "show": "flowryn verify show vq599" }],
  "landing": [{ "project": "…", "batches": true, "more": 0, "entries": [{ "id": "lq88", "task": "…", "title": "…", "state": "waiting",
    "place": "2 of 3", "cell": "…", "line": "…", "since_ms": 0, "show": "flowryn show <task>" }] }],
  "batches": [{ "id": "lb31", "project": "…", "state": "verifying", "line": "…", "verify": "verifying v412",
    "members": [{ "task": "…", "pos": 1, "state": "landing" }], "show": "flowryn show lb31" }],
  "waiting": { "runs": [{ "task": "…", "title": "…", "stage": "ship", "needs": "validation", "waited": "4m", "why": "full: validation", "show": "flowryn show <task>" }], "more": null },
  "pools": [{ "pool": "validation", "used": 2, "cap": 2 }],
  "host": { "ok": true, "line": "ok (since 3m ago; …)" }
}
```

A queue estimate with none is `{ "starts_in_ms": null, "why": "…" }`. A section that could not be read is `{ "error": "could not read <section>" }` (logged by the daemon); the others still render, and the page shows the error rather than an empty list. The queue, each landing line and the waiting runs are capped at 50 (20 for the waiting runs, as `capacity`).

## Security

- Bound to `127.0.0.1` only. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise: the DNS-rebinding guard); an `Origin` other than the page's own gets 403; other methods 405.
- No CORS header. `Content-Security-Policy: default-src 'none'`, the page's own inline script and style by sha256 hash (no `unsafe-inline`), `connect-src 'self'`, `frame-ancestors 'none'`; plus `Cross-Origin-Resource-Policy: same-origin`, `nosniff`, `no-referrer`, `no-store`. No external request: everything is in the page.
- The page renders with `textContent` only and links only `https://` PR URLs.
- Contents: ids, sanitized titles, project ids, PR URLs, step names, states, timings, pool counts, the host line, and Flowryn's own one-line landing and batch texts (which can quote a git error, as `flowryn show` does). Never step output, a verification's detail, env values, tokens or paths.
- Known limit: anything on this Mac that can reach loopback can read it, which is what `flowryn capacity` shows a reader. Nothing on it changes anything.

## Tests

`test/unit/dashboard-eta.test.ts` (each estimate rule), `test/unit/dashboard-status.test.ts` (the summary over a seeded fleet from `test/helpers/dashboard-fleet.ts`: a running verify, a queue, a batch and a landing line; a broken section; no secrets; under 50 ms over 200 verifications), `test/unit/dashboard-server.test.ts` (port choice, Host and Origin guards, methods, headers, the cache, a taken port retried), `test/integration/dashboard.test.ts` (a real daemon: the verb, the page, a foreign Host refused, a notify-off home binds nothing, the same address after a restart), `test/integration/binary.test.ts` (the compiled daemon serves the embedded page), and `test/unit/verify-steps.test.ts` (a step's start, again on a hang retry).
