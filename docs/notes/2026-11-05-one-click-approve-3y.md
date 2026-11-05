# One-click approve on every review page

- Status: done
- Open: not yet run live in a real browser beyond the probe below (Chrome only; Safari and Firefox are untested), nor with the browser-folder deny on a real QA run of chrome-devtools-axi.

Approve on a review page passes its gate in one click: no code to type, no confirmation in chat, no `flowryn approve`. Every review page carries the widget, so pages without questions get the button too. A worker still cannot pass its own gate. Plain code (a random key, a hash, fixed checks); no model.

## How it works

1. **The key.** When the opener claims a gate's page (`src/lavish/opener.ts`), it mints a pass key (32 random bytes, base64url, `mintPassKey` in `src/policy/pass-key.ts`), stores its SHA-256 on the gate (`gates.pass_key_hash`, migration 53 `page-pass-key`) in the claim's transaction, and hands `open` the review URL with `?flowryn_pass=<key>`. Only that argument carries the key: the gate's `review_url`, the `gate.browser_*` events (`one_click: true|false`), the gate_ready item and the log keep the URL without it, and a failed open's message is redacted. A file:// page gets no key.
2. **One key per tab.** A page resubmitted after changes is `skipped` (Lavish live-reloads the tab you have), and its gate takes the tab's live hash from the latest earlier gate of the run with that URL.
3. **The page reads it.** lavish-axi 0.1.96 ignores the query (`/session/:key` reads only its layout-gate flag) and loads the page in a sandboxed frame whose `document.referrer` is the full top-level address, query included, across live reloads (measured 2026-11-05 with a probe page in Chrome). The fragment never reaches the frame, which is why the c6 design parked one click. The widget (`src/lavish/widget.ts`) reads `flowryn_pass` from the referrer when its state says the gate has a live key (`oneClick`), and puts it in the Send's token as `t` on Approve only, never in the prompt's words.
4. **The check.** `passFromPage` (`src/policy/page-pass.ts`) runs every check it ran for a code (run live, gate open and the run's own, every question answered, the draft page unchanged), then the key against the hash (constant time), then the HEAD now against `gates.pass_head`, the HEAD `stage done` read when the review opened. Right: `recordGatePass` on channel `page` (actor `<you> (review page, one click)`), bound to that HEAD and used once; the next stage is requested and the page hears "Approved: the review passed; the <stage> stage starts now."
5. **Spent on arrival.** The Send that carries the key sits in lavish's files, which a worker can read, so a right key that arrives is spent whatever the outcome (`spendPassKey` clears the hash on every gate of the tab, event `gate.pass_key_spent` with the gate and why). A wrong key spends nothing: it reveals nothing, and spending it would let a worker spoil your button.
6. **Fallback.** No live key (spent, the page opened by hand from a copied link, a browser that hides the referrer): the widget shows the c6 pass code field and Approve works as "Send and pass" did. A refusal for a spent key (`no_key`) or moved work (`key_moved`) opens the leader's request and sends you a code at once; a wrong key (`wrong_key`) opens the leader's request only.

## What the guard stops, and what it doesn't

- **Stops:** a worker posting Approve to Lavish (no key, or a guessed one: 256 bits), a worker's CLI (`gate pass` is a leader verb), a replay of your click (the gate is closed and the key spent), an approval of work that moved since the review opened.
- **Does not stop:** anything that reads your browser's history or session files on disk, where the address with the key is kept. Claude workers are denied reading browser profile folders (`browserProfileReads`, `src/policy/static.ts`: Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Firefox under `~/Library/Application Support`, and `~/Library/Safari`), which Claude applies to its Bash sandbox too; a Pi worker has no such fence. `/usr/bin/open`'s command line shows the address to process listings for a moment while the worker is idle (the c6 notification's class). A program that drives your own browser can click the button. These are listed with limit (d) in docs/cutover-notes.md "C1 · Decisions".

## Where the key never goes

The database (only the hash), events, the daemon log, items, notifications, Lavish replies, the widget, and the notes beside the page: a poll's raw output kept there now has each answer token replaced with `(recorded)` (`withoutAnswerTokens`, `src/lavish/poll-output.ts`), for codes as well as keys. The integration test scans every file under the test home's state and data directories and its logs after a pass (the open recorder, which stands in for your browser, aside).

## Choices

- **The query, not the fragment:** the only daemon-to-browser path a worker cannot read that reaches the frame.
- **The hash in the database, not the key in memory:** a daemon restart during a review would otherwise drop you back to typing; the hash is useless to a reader.
- **Keep the typed code** as the fallback above, rather than leaving only chat.
- **Every review page mounts the widget:** `stage done` refuses a page given with `--page`, or a Lavish page found from `--review`, that does not mount it; the design and QA templates mount it, and the draft page always did.
- **The leader skill** (`src/bridges/skill.ts`) says an Approve on the page is the user's pass and is never confirmed again in chat.
- **No `PROTO` bump** (the token is the page's format, not the wire) and **no `CONTRACT_REVISIONS` bump**: the contract suite never runs `stage done` or a review page.

## Tests

`test/unit/page-pass.test.ts` "one click" (the key helpers, a pass, a replay, a worker's key, a stale HEAD, a closed gate, an open question, and the poller: a pass, a Send without the key, a guessed key, moved work), `test/unit/review-opener.test.ts` "one click" (the key minted at the claim and only in the open argument, a resubmission taking the tab's hash, no key for file://, a redacted failed open), `test/unit/gate-questions.test.ts` (the widget's Approve, the key from the referrer in the token only, a page without questions, the fallback), and `test/integration/gate-questions.test.ts` "one-click approve" through the real daemon: the opened address, a worker's own `gate pass` and its forged Sends refused, one click passing on channel `page` and the build stage starting, and the key absent from every file a worker reads.
