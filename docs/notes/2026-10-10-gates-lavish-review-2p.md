# Toolkit gates, ship 3: the lavish review URL and the quota floor

- Status: done
- Open: the quota probe has not been run from the launchd daemon (only from a shell); no live reading under the floor yet
- Config: `[capacity.quota] floor`, `[sched] quota_cache_ms`

Ship 3 of the toolkit report (§6). It adds the two gates that have no raw command to deny: Q3, which says a review is a lavish page, and Q4, which says new Claude work waits when the quota is low. Both are plain code: a hash comparison, a JSON field and a threshold. No model is involved.

## The review URL (Q3)

`stage done --review` used to accept any `http(s)://` or `file://` URL. Now it accepts only lavish's URL for a page under `$FLOWRYN_REPORT_DIR` (`checkReviewUrl` in `src/lifecycle/stages.ts`, keys in `src/lavish/session-key.ts`).

- **How lavish names a page.** In lavish-axi 0.1.65 (`dist/cli.mjs`), a page is named by `sessionKey(canonicalFile(file))`: the first 16 hex digits of the SHA-256 of the file's real path. The URL is `http://<link host>:<port>/session/<key>`. The link host may be loopback, the Tailscale MagicDNS name, `LAVISH_AXI_LINK_HOST` or `LAVISH_AXI_HOST`, so Flowryn checks the key and never the host or port. This was checked live: lavish printed `/session/254ed28a675a185f` for this feature's design page, and the SHA-256 of that page's path starts with the same 16 digits (the vector is in `test/unit/session-key.test.ts`).
- **The rule:**
  - When `--page` is given, the URL's key must be that page's key. A QA stage counts its own `qa/evidence.html` as the page.
  - Without `--page`, the `.html` page under the report directory with that key is the page. The search goes at most 4 levels deep, looks at 500 entries at most, and never follows a symlink. The daemon now listens on that page too, so the old "no --page: Flowryn cannot listen" hint is gone.
  - A `file://` URL is accepted only while lavish-axi is not installed (`[tools] lavish_axi` or PATH names no file), and only for an `.html` page under the report directory.
  - Anything else is refused with `review_invalid` (exit 3) and a hint: `lavish-axi <page>` prints the URL to pass.
- **No network.** `stage done` is spooled while the daemon is down and replayed later. A GET to lavish would make the verdict depend on timing, and the key check needs none.
- **The QA page** is checked first (`checkQaPage` now returns its real path), so a missing card still answers `qa_page_invalid`.
- **The m5 lab** (`scripts/lab/m5-live.ts`) hands in `file://` pages, so its home sets `lavish_axi` to a path that does not exist. That is the documented fallback, and it keeps a real lavish-axi from opening pages on your Mac.

## The quota floor (Q4)

`src/sched/quota.ts`. Before a new Claude run starts, the scheduler reads `quota-axi --provider claude --json --no-credential-refresh`. The argv is fixed, has no shell and a 10 s timeout, and puts node's directory first on PATH, because quota-axi is a node script. The binary is `[tools] quota_axi` or the one on PATH.

- **The reading** (`parseQuota`, quota-axi 0.1.37, `schemaVersion` 5): `providers[claude].quotaSemantics.effectiveAvailability[scope = all_models]`, its `effectivePercentRemaining`, and its first `limitingWindowIds` with that window's `resetsAt`. quota-axi already takes the minimum over the session and weekly windows. The model scopes (`model:fable`) are left out, because mapping Flowryn's model config onto quota-axi's names would be a guess. Anything else is `unknown`: another schema, no claude provider, a status other than `known`, a non-number, a non-zero exit, a timeout, or quota-axi missing. `test/fixtures/quota-axi-0.1.37-claude.json` is a real output from this Mac.
- **The verdict:**
  - `low` when the reading is strictly under `[capacity.quota] floor` (default 5; 0 turns it off; at most 100).
  - `ok` when it is at or over the floor.
  - `unknown` when there is no reading. An unknown reading holds nothing, because quota-axi needs the network and a broken probe must not stop all work (unlike the host probe).
- **What waits under the floor** (`Scheduler.quotaHeld`):
  - a new Claude run's first launch (`pending_launch = fresh`)
  - auto-dispatch of a Claude plan phase
  - the daemon's auto contract check (`src/contracts/auto.ts`, from the recorded state)
- **What goes on:**
  - the next stage of a live run, a fresh stage worker, a resume, a relaunch (drain before fill)
  - Pi runs
  - `doctor --contracts`, whose scratch home sets `floor = 0` because you asked for that run

  The usage-limit pause still stops everything once the quota really runs out.
- **When it is read:** only when a new Claude run or a Claude phase could start, at most every `[sched] quota_cache_ms` (default 120 s). The reading falls slowly: 5% of a 5 h window lasts about 15 min at full burn. It rises only at a reset, so it does not flap around the floor, and there is no hysteresis.
- **State and attention:**
  - The state (meta `claude_quota`) is written only when its verdict or the floor changes, with an event: `sched.quota_ok`, `sched.quota_low` or `sched.quota_unknown`.
  - `low` opens one P1 `quota_low`: "Claude quota 3% (seven_day), under the 5% floor; new Claude runs wait until it resets at 04:00; flowryn capacity resume --harness claude starts them anyway". Any other verdict resolves it.
  - The `capacity_wait` P1 names "the Claude quota floor" after the host check and the usage limit.
- **Override:** `flowryn capacity resume --harness claude` is human-only, as before. It now also starts new Claude runs while the quota is low (`sched.quota_override`, and the P1 resolves), until the next reading that is not low. One command covers both "start Claude work anyway" cases.
- **Where it shows:**
  - `flowryn capacity` has a `quota` line, for example `claude 80% (floor 5%) ok (since 3m ago)`. A held run's `why` reads `Claude quota 3% under floor 5%`.
  - `flowryn doctor` runs the same probe. It shows `quota probe` as ok over the floor, and warns under the floor or when the probe fails. A missing quota-axi is now `warn` while the floor is above 0 (ship 2 left it as info until this probe used it).
- **Test homes** get a stand-in `quota-axi` (`test/helpers/harness.ts`). It prints `$FLOWRYN_HOME/quota.json` when a test writes one (`quotaJson(percent)`, otherwise 80%) and fails while `$FLOWRYN_HOME/quota.fail` exists. Contract scratch homes copy it with the other tools, so no test reaches the network or the keychain.

## Tests

- `test/unit/session-key.test.ts`: the live lavish vector, URL shapes (loopback, Tailscale, IPv6; rejects uppercase, a short key, a trailing slash, a query, another path, `file://`), and the page search (subdirectories, no symlinks, the depth limit).
- `test/integration/gate-questions.test.ts`:
  - A lavish URL without `--page` finds its page and is listened on.
  - These are each refused with `review_invalid`: a URL that is not lavish's, a key no page has, a key for another file than `--page`, and `file://` while lavish-axi is installed.
  - With no lavish-axi, a `file://` page under the report directory is the page, and one outside is refused.
- The fake worker's `lavish:<file>` argument (in `stage-done` and `verb`) becomes lavish's URL for that page. Every review hand-in in the integration tests uses it now.
- `test/unit/quota.test.ts`:
  - parsing the real fixture and each unknown case
  - the floor's edges
  - flips, events and the P1, including a no-op on an unchanged reading and a new floor
  - the override's lifetime
  - the probe's argv, failures and a missing tool
  - doctor's line
- `test/unit/workflows.test.ts` covers the config. `test/unit/static-layers.test.ts` covers quota-axi's doctor tier.
- `test/integration/quota.test.ts`:
  - Under the floor, a Claude run waits with the P1 and the `capacity` lines while Pi starts, and a reading back over the floor starts it.
  - A live run's next stage starts under the floor, a leader's `capacity resume` is refused, and yours starts the held run.
  - A failed reading holds nothing and is logged once.
  - A floor of 0 never reads quota-axi.

## Version

0.15.0. `PROTO` stays 6, because no verb's arguments changed (`capacity resume` only replies with one more field). An older binary refuses a config that has `[capacity.quota]` or `[sched] quota_cache_ms` (`config_invalid`). The daemon restarts onto a merged build by itself.
