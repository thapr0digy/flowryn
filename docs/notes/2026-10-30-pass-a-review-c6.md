# Pass a review gate from its page with a pass code

- Status: partial
- Open: the one-click pass (a code carried in the URL the daemon opens) needs lavish-axi to hand the page its fragment; the user chose the typed code now and one-click as its own later task. Not yet run live against a real notification or `[notify] command`.

A review page could only *request* a pass: the user then confirmed it again in chat or with `flowryn approve`. Now the page's "Send and pass" button passes the gate itself when the user types the pass code Flowryn sent to their notifications. Plain code throughout (a code store, fixed checks); no model.

## How it works

1. **No code typed.** "Send and pass" with the pass code field empty records the answers (every question must be answered, as before), opens the leader's `pass_requested` item as before, and mints a code: four letters from the `flowryn approve` alphabet, good for 10 minutes, bound to the gate and to the run's worktree HEAD (`PageCodeStore`, `src/policy/approvals.ts`).
2. **Delivery.** `NotifyPump.sendPassCode` (`src/attention/notify.ts`) sends it straight to the macOS notification (when `[notify] macos`) and to `[notify] command` (when set, away or not; `FLOWRYN_NOTIFY_KIND=pass_code`). Never to Herdr. A code no channel reached is dropped, and the page says the leader confirms instead.
3. **Code typed.** The widget puts the code in the Send's token (`k`, `src/lavish/poll-output.ts`), never in the prompt's words. The poller reads the gate run's HEAD before its transaction, then `passFromPage` (`src/policy/page-pass.ts`) checks: the run is live, the gate is the run's open review gate, every question is answered, then the code. Right: `recordGatePass` with channel `page` (a new member of `HUMAN_CHANNELS`; migration 45 `page-channel` rebuilds the `approvals` CHECK), so the approval is bound to the HEAD and used once, the gate passes, the plan it carries is approved, and the next stage is requested. The page hears "The review passed with your pass code; the <stage> stage starts now."
4. **Anything else falls back.** A wrong code (three wrong tries void it), an expired one, a HEAD that moved since it was minted, or no code waiting (a restart forgets them) is refused with a line on the page, and the leader's `pass_requested` item opens as before. A code that arrives with a Send the gate refuses before the check (an open question, a closed gate) is dropped: that Send went through Lavish, so the code is spent. `flowryn gate changes` needs no code; changes close the gate, so its code never passes another.

## Where the code never goes

The database (no column, no event payload: `gate.pass_code_sent` and `gate.page_pass_refused` name the gate, the channels and the outcome only), the daemon log, items, the `notifications` table, Lavish replies, the widget and the notes beside the page. A notify command's stderr is not kept in its `notification.command` event for a code send, since a command that echoes its input would put the code there. Tests check every file under the test home's state and data directories after a pass.

## Choices

- **Typed code, not the one-click fragment.** lavish-axi 0.1.88 shows the page in `<iframe sandbox="allow-scripts allow-forms allow-popups …">` without `allow-same-origin`, loading `/artifact/<key>/index.html` with its own query and rewriting the frame's URL on each reload; the chrome never reads `location.hash`. A fragment on the URL the daemon opens stays in the top window, and the opaque-origin frame can neither read it nor use `sessionStorage`. The user chose the typed code now (q128).
- **The board does not show the code** (q129): the board can pass the gate with its own approve key, and a verb that handed out the code could be used by a process faking your terminal (limit (b) in docs/cutover-notes.md) to pass without you.
- **Memory only**, like the `/dev/tty` challenge: a worker can read `flowryn.db` and the daemon log.
- **No `PROTO` bump** (the answers line is the page's format, not the daemon's wire) and **no `CONTRACT_REVISIONS` bump** (the worker path is unchanged).
- The pass runs after the batch's words are routed (`routePageBatch`), so a note sent with the pass still reaches the worker before the gate closes.

## Limits

- Only a gate with questions has the widget, so only those pages can pass this way (as before, a page without questions has no form).
- The macOS notification's `osascript` command line shows the code to process listings for a moment, the same class as the browser open's command line.
- docs/cutover-notes.md "C1 · Decisions" limit (d) is edited in place for the page pass.

## Tests

`test/unit/page-pass.test.ts` (the store, every refusal, the poller's mint, send and pass, nothing written where a worker reads), `test/unit/notify-command.test.ts` (the code send), `test/unit/gate-questions.test.ts` (the widget's field and token), and `test/integration/gate-questions.test.ts` "passing a review from its page with a pass code" through the real daemon with the notification recorder.
