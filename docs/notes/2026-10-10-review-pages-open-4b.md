# Review pages open in your browser

- Status: done
- Open: `open -a` not yet run from the launchd daemon (only from a shell); Chrome with the screen locked not checked
- Config: `[review] open_browser`, `[review] browser`

When a review gate opens, flowrynd (outside any sandbox) opens its page in your browser: `/usr/bin/open -a "Google Chrome" <url>`, once per page per run, after Flowryn's own Lavish poll of the page is listening. A failed open shows on the gate item and in `flowryn show`, with the URL to open by hand; Flowryn never says a page opened when it did not. The design (task review-pages-open-mh, gate g97) was approved in the leader's chat on 2026-10-10; this ship (review-pages-open-4b) built it. Plain code: a state column, a WebSocket read and a spawn. No model.

## How a gate's page gets opened

1. The worker hosts the page with `lavish-axi --no-open <page>` (its env also has `LAVISH_AXI_NO_OPEN=1`) and hands the URL in with `stage done --review`.
2. `stage done` opens the gate with `open_state = pending` (`off` when `[review] open_browser = false`).
3. The daemon's poller (`src/lavish/poller.ts`) starts its `lavish-axi poll` for the gate, then offers the gate to the opener (`src/lavish/opener.ts`).
4. The opener waits until Lavish itself shows the page's poll **listening**, at most 60 s (below).
5. It claims the gate: `open_state = opening` and a `gate.browser_opening` event, committed **before** the spawn.
6. It runs `/usr/bin/open -a <browser> <url>` (fixed argv, no shell, 10 s timeout) and records `opened` (exit 0) or `failed` with why, on the gate, its gate_ready item and a `gate.browser_opened` / `gate.browser_failed` event, in one transaction (precedent: `src/sched/usage.ts`). The item's short line (200 characters) always ends with the result, ` · opened in <browser>` or ` · NOT opened (<why>); relay the URL to open it by hand`: a long title or URL is cut before it, and the whole text with the full URL stays in `full_line` (`show --full`) and in `flowryn show`.

The claim makes it at most once: a restart, a spool replay or a second offer finds the gate past `pending` and does nothing. A daemon that dies between the claim and the result leaves `opening`, which `flowryn show` reads as "opening, or the daemon stopped while opening HH:MM; open by hand: <url>" (it is also the state for the at most 10 s a running daemon waits on `open`). "Opened" means `open` exited 0: Launch Services handed the URL to the app. Flowryn cannot see the tab render, and says only that.

## States

`gates.open_state` (migration 18, `gate-browser-open`, with `open_detail` and `open_at`):

| State | Meaning |
|---|---|
| `pending` | waits for the gate's poll to listen |
| `opening` | claimed; `open` ran or was about to (left over only by a daemon that died) |
| `opened` | `open` exited 0 |
| `failed` | `open` failed, or Lavish never showed the poll listening; `open_detail` says why |
| `off` | `[review] open_browser = false`, or `FLOWRYN_NOTIFY=off` with no recorder |
| `skipped` | the run already opened this page for an earlier gate, or the gate was open at upgrade |

A merge gate has none (`NULL`). Review gates open when the migration runs become `skipped`, so an upgrade opens no burst of tabs for pages you may already have.

## Your answers to the design's questions

- **Re-open after a 'changes' verdict (q49): once per page per run.** A resubmitted page (a new gate with the same URL in the same run) is `skipped` ("already opened for g12") when an earlier gate of the run is `opening` or `opened`; Lavish live-reloads the tab you have. An earlier `failed` attempt never opened a tab, so the next gate tries again. If you closed the tab, the item and `flowryn show` still carry the URL.
- **A file:// page with no lavish-axi (q50): open it right away.** Nothing listens on a file:// page and nothing can be sent from it, so the presence wait is skipped. With lavish-axi missing, the poller offers the gate at once.

## Lavish presence

lavish-axi 0.1.65 (`dist/cli.mjs`) has no REST read of presence. The browser's WebSocket `/events/<key>` on the page's own origin sends `chat-sync`, then `agent-presence {state}` on connect (`listening` while a poll of the page is active, else `working` or `waiting`), and every change after. It refuses an upgrade without a same-origin `Origin` header. The probe connects with that header and stays connected until it reads `listening` or the 60 s pass; one that cannot connect tries again every 2 s.

- **Checked live** on this Mac against lavish-axi 0.1.65, with Bun's WebSocket client: `waiting` on connect, `listening` about 100 ms after a `lavish-axi poll` of the page started, and a 1002 refusal without the `Origin` header. Bun does send the header.
- **Failure is visible, never early.** No presence message within 60 s fails the gate with "Lavish never showed the page listened to in 60 s"; no connection at all fails it with "cannot read Lavish presence (…)". A lavish upgrade that changes the route fails gates this way, with the URL shown.
- **Side effect:** while connected, the probe counts as a live client for the page in Lavish (it keeps Lavish's idle timer up), for 60 s at most.
- **Why lavish-axi's "opened" lied:** its `status: opened` is the Lavish *session*, not a browser tab. It prints it even with `--no-open` (checked live), and its own `open()` does not wait for `open`'s exit, so a sandbox refusal never surfaced. The design and QA skills now host with `--no-open` and say not to trust it; the stage instructions and the leader skill say Flowryn opens the page and the item says whether it did.

## What you see

The gate_ready item gains a suffix when the result is known:

```
design ready for review (g89): Policy follow-through (flowryn) http://127.0.0.1:4387/session/254e… · opened in Google Chrome
design ready for review (g89): … http://127.0.0.1:4387/session/254e… · NOT opened (open exited 1: Unable to find application named 'Google Chrome'); relay the URL to open it by hand
```

`flowryn show <task>` adds the browser state to each open review gate's line and, unless it opened, the URL to open by hand:

```
g89 review design: open http://127.0.0.1:4387/session/254e… page …/design.html; browser: failed 14:02 (Lavish never showed the page listened to in 60 s); open by hand: http://127.0.0.1:4387/session/254e…
```

On `/remote-control` Chrome opens on the Mac harmlessly, and the item still carries the URL for the leader to relay.

## Configuration

```toml
[review]
open_browser = true        # false: gates open with open_state = off, nothing is opened
browser = "Google Chrome"  # the application `open -a` hands the page to
```

`browser` is an application name: at most 100 characters, no control characters, not starting with `-`. An unknown key is `config_invalid`. An older binary ignores the whole section.

## Worker side

The worker env gets `LAVISH_AXI_NO_OPEN=1` (`src/lifecycle/launcher.ts`), so a worker's lavish-axi never tries to open a tab (a Pi worker outside the sandbox would otherwise open a second one), and the design and QA skills run `lavish-axi --no-open <page>` (`src/skills/stages.ts`). The `review_invalid` hint says the same.

## Tests never open anything

- `FLOWRYN_OPENER=record:<path>` turns the opener into a recorder: each open is a line `<browser>\t<url>` in that file, it fails with the text of `<path>.fail` while that exists, and presence is `listening` unless `<path>.presence` names another state. Every test home sets it to `browser-opens.log` beside `FLOWRYN_NOTIFIER`.
- `FLOWRYN_NOTIFY=off` with no recorder (the lab, the contract scratch homes, the spikes) turns the opener off: gates settle `off` ("FLOWRYN_NOTIFY=off"), nothing is probed or opened.
- The test preload (`test/helpers/no-notifications.ts`) refuses `/usr/bin/open` in-process like osascript, and fails the file on any attempt.
- `test/unit/review-opener.test.ts`: every state with an injected `open` and presence (opened, failed, presence never listening, file://, once per page per run, a failed page tried again, off by setting and by env, a leftover `opening`, a gate closed during the wait, a stopping daemon), the recorder and the mode, the `[review]` config, migration 18, and the real presence probe against a Bun stand-in of Lavish's `/events` socket (origin required, waiting then listening, the timeout, no server, a stop).
- `test/integration/review-open.test.ts`: through the fake fleet, the page is recorded once after the daemon's poll ran, the item and `show` say it opened, a restarted daemon opens nothing more, the worker pane has `LAVISH_AXI_NO_OPEN=1`; a failing open shows on the item and in `show` with the URL; `open_browser = false` opens nothing.
- `test/unit/notify-guard.test.ts`: `runOpen` is refused in the test process, and test homes record.

## Version

0.21.0. `PROTO` stays 6: no verb's arguments changed (`stage done` only records one more column, and `gate.opened`'s payload has a `browser` field).
