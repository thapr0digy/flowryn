# Pi bridge spikes (M0)

These spikes check the Pi half of the M0 contract in `docs/design-v3.html`: section 17 "Pi bridge", plus every Pi-side M0 mark in sections 5, 7, 9 and 11. They are throwaway code. Each script ends with one verdict written by `spike_verdict` to `spikes/.runs/results/<id>.json`.

Pi is not installed on the machine where these were written. Every script checks `command -v pi` before it touches Herdr. When pi is missing, the script records `not run` / `pi: not installed` / `pi not installed on this machine` and exits 0. **No verdict below is live.** Each "desk-check" is a prediction from reading the docs and source. Label it that way wherever you quote it.

## What was researched

| Source | Version / revision |
|---|---|
| npm `@earendil-works/pi-coding-agent` tarball: `docs/*.md`, `CHANGELOG.md`, `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`, `dist/core/trust-manager.js`, `dist/modes/interactive/interactive-mode.js` | **0.87.1** (published 2026-09-22, gitHead `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`). Downloaded to a scratch dir and read only. Nothing was installed. |
| README, fetched from `raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md` | Current `main`. That repo now serves the moved project. The canonical repo is https://github.com/earendil-works/pi |
| Doc URLs cited below | `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/<file>`. The text quoted here is the 0.87.1 tarball copy. |
| Firstmate live extensions: `/Users/pr0digy/projects/firstmate/.pi/extensions/*.ts` (read-only) | Import `@earendil-works/pi-coding-agent`. Comments say they were verified against Pi 0.80.5 (`tool_call` block), 0.81.1, 0.82.0 and 0.84.4 (`agent_start`/`agent_settled`, `session_start` reasons). Firstmate CI installs the latest release unpinned. `docs/verification/runtime-backends.md` records runs on 0.84.1 through 0.84.4. |
| Old package `@mariozechner/pi-coding-agent` | Deprecated at 0.73.1: "please use @earendil-works/pi-coding-agent instead going forward". |

When pi is installed, each spike records the result of `pi --version` as its version string.

## Files

- `extension/flowryn-probe.ts` is the single probe extension. Every spike loads it with `-e`. It writes a JSONL log to `$FLOWRYN_PROBE_LOG` and polls a JSONL command file at `$FLOWRYN_PROBE_CTL`. Its header lists every control: send with `nextTurn`, `followUp`, `steer` or `triggerTurn` at a chosen event; `abort`; `compact`; `read_editor`; `activity`; `status`; `system_prompt`; `shutdown`. It also handles:
  - the briefing at `session_start` and after `session_compact`
  - the `flowryn_merge` tool, which calls `ctx.ui.confirm`
  - the block on shell `flowryn merge` and `flowryn approve`
  - `project_trust` answers
  - a provider baseUrl override for the error spike

  Each API call cites where it was verified. An offline smoke test drove the probe through a stub `ExtensionAPI` and passed: sends, queued triggers, block, confirm, markers and re-brief.
- `lib/pi-spike.sh` holds the shared helpers. `pi_require` is the not-installed gate and runs before `lab_ensure`. The file also has helpers for launch, JSONL queries, control commands, pane input and the verdict. All Herdr traffic goes through `lab_herdr` in `spikes/lib/lab.sh`.
- `p01`–`p14` are the spikes. `run-all.sh` runs them in order and prints the verdict table.

Every launch is scoped to one invocation. It uses `-e <probe>`, `--session-dir spikes/.runs/<id>/sessions` and a scratch cwd. `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0` are set. No spike writes `~/.pi`. `--approve` is used only for scratch cwds whose `.pi/settings.json` the spike writes itself. Pi still reads the user's agent dir for auth. Set `FLOWRYN_PI_AGENT_DIR` to redirect `PI_CODING_AGENT_DIR` to a prepared scratch dir.

Evidence method: the probe logs the `context` event, which fires before each LLM call. It extracts `FLOWRYN-MARK-*` markers from the messages the model is about to receive. "Delivered" means a marker appears in a model request. It does not mean the marker showed up on screen.

## Per-item notes

### p01-next-turn

- **Claim:** "nextTurn: rides with your next prompt; never delivers while idle." Section 9 adds: "Pi nextTurn while idle never delivers → P0 uses triggerTurn; P1 waits by design."
- **Docs:** `types.d.ts` gives `sendMessage(message, {triggerTurn?, deliverAs?: "steer" | "followUp" | "nextTurn"})`. CHANGELOG: "`sendMessage()` supports `deliverAs: "nextTurn"` to queue messages for the next user prompt". In `agent-session.js` (0.87.1), `sendCustomMessage` pushes nextTurn into `_pendingNextTurnMessages`, and only `prompt()` drains it: "Inject any pending "nextTurn" messages as context alongside the user message".
- **Method:** Queue marker N1 while idle, wait 20 s, then check that no run started and no request carried N1. Type a prompt and check that N1 is in the first request. Then queue N2 during a bash call and check two things: it stays out of the current run, and it rides with the next prompt.
- **Desk-check (not a live verdict):** confirmed. Caveats from the source:
  - nextTurn does **not** ride a `triggerTurn` run, because `_runAgentPrompt` is called directly.
  - It does not ride a steer or follow-up queued while streaming.
  - It lives only in memory, so a quit or crash loses it.

### p02-follow-up

- **Claim:** "followUp: delivered after the current run; accepted while busy." Section 5 adds: "deliverAs: "followUp" (Pi rejects a busy send without it)".
- **Docs:** `docs/usage.md`: "A follow-up sent with `Alt+Enter` waits until Pi finishes the current task." In `agent-session.js`, `sendCustomMessage` calls `agent.followUp(...)` while streaming. `prompt()` throws "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." when busy with no behavior set.
- **Method:** During a `sleep 8` bash call, send four messages: F1 (sendMessage followUp), F2 (sendUserMessage followUp), F3 (sendUserMessage with no deliverAs) and F4 (sendMessage with no deliverAs). Check each against the first assistant stop message.
- **Desk-check (not a live verdict):** confirmed for F1, F2 and F3: F1 and F2 arrive after the work, and F3 is rejected. Two refinements:
  - F4 (a busy **custom** message with no deliverAs) is *steered*. It is not rejected.
  - F3's rejection is reported through the runner's error channel and is not thrown to the extension. The probe can only infer it: an `input` event appears, then nothing is delivered.
  - Follow-ups continue inside the same run, so only one `agent_settled` fires.

### p03-trigger-turn

- **Claim:** "triggerTurn: opens a turn when idle; interaction with a half-typed composer."
- **Docs:** The `sendCustomMessage` JSDoc in `agent-session.js` says: "Not streaming + triggerTurn: appends to state/session, starts new turn". Since 0.87.0, a trigger from inside an `agent_settled` handler is deferred until all settled handlers finish. CHANGELOG: "Queued steering/follow-up messages no longer wipe unsent editor input". In interactive mode, `agent_start` does not touch the editor.
- **Method:** Trigger T1 while idle. Then type a draft without pressing Enter, trigger T2, and classify the draft as survives, submitted or clobbered using `getEditorText`, `input` events and requests.
- **Desk-check (not a live verdict):** confirmed. The turn opens and the draft survives unsubmitted. The triggered run gets no `before_agent_start` and no `input` event.

### p04-agent-settled

- **Claim:** "agent_settled: fires once per run, including abort, retry, error and compaction." Section 5 adds: "emitted from a finally block, so it covers abort, retry and compaction".
- **Docs:** `types.d.ts`: "Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run." `docs/extensions.md`: "`agent_settled` is final and notification-only". In source, `_runAgentPrompt`'s `finally` calls `_emitAgentSettled()`, and retry and compaction loop inside that `try`. The new `agent_before_settle` reports `outcome: completed | aborted | error`.
- **Method:** Six scenarios:
  - S1: a normal run.
  - S2: `ctx.abort()` mid-tool.
  - S3: `ctx.compact()` mid-run.
  - S4: an idle `/compact` (informational).
  - S5: a provider baseUrl pointed at a closed port, so automatic retries end in an error.
  - S6: threshold compaction in a run. Opt-in with `FLOWRYN_P04_THRESHOLD=1`.
- **Desk-check (not a live verdict):** confirmed: exactly one per run. Refinements:
  - `agent_start` can fire **more than once** per settled run, because every `agent.continue()` emits it. That happens on retry, compaction continue and before-settle continue.
  - A prompt rejected before a run starts produces neither event. Examples: busy without deliverAs, no auth, or compaction in progress.
  - An idle manual `/compact` is not a run and produces no `agent_settled`. `compact()` aborts any active run first, and that run settles once.

### p05-system-prompt-append

- **Claim:** Section 11: "That is Claude Code's --append-system-prompt and Pi's equivalent M0."
- **Docs:** `docs/cli.md`: "`--append-system-prompt <text|path>` Appends text or an existing file to the system prompt and is repeatable." `types.d.ts` provides `ctx.getSystemPrompt()` and `before_agent_start.systemPrompt`.
- **Method:** Pass the flag twice, once as literal text and once as a file path. Check the markers through `getSystemPrompt()` at `session_start` and through the per-run `systemPrompt`. A second instance without the flag is the control.
- **Desk-check (not a live verdict):** confirmed. The flag name is `--append-system-prompt`, the same as Claude's. Avoid `<agent-dir>/APPEND_SYSTEM.md` and `.pi/APPEND_SYSTEM.md`, because they are global or project-wide rather than per process.

### p06-briefing

- **Claim:** "session_start attaches the briefing to the first turn with deliverAs: "nextTurn"; re-brief after compaction M0."
- **Docs:**
  - `session_start` reasons are `startup | reload | new | resume | fork`.
  - `session_compact` carries `reason: manual | threshold | overflow` and `willRetry`.
  - Firstmate's `fm-primary-turnend-guard.ts` re-delivers on `session_compact` with `pi.sendMessage(message)`. Its comment: "Manual compaction is idle and auto-compaction may retry without another before_agent_start".
  - `docs/compaction.md`: overflow recovery "start[s] the retry as a fresh run".
- **Method:** The probe sends BRIEF as nextTurn at `session_start`. The spike checks that BRIEF is not delivered while idle and is in the first prompt's request. After `/compact`, the probe sends REBRIEF as nextTurn. The spike checks that REBRIEF is in the first request after compaction. A scratch `.pi/settings.json` sets `keepRecentTokens: 1` with `--approve`, so a short session can be compacted.
- **Desk-check (not a live verdict):** confirmed for manual and threshold compaction. Gap: after **overflow** compaction with `willRetry`, the retry is a fresh run that bypasses `prompt()`. A nextTurn re-brief therefore misses the retried turn and arrives with the next user message. To cover it, re-brief with `steer` when `willRetry` is true or the session is busy.

### p07-ui-confirm

- **Claim:** "ctx.ui.confirm() inside the extension's flowryn_merge tool". Section 7: "Its flowryn_merge tool shows PR title, URL, head SHA and checks through ctx.ui.confirm()."
- **Docs:**
  - `types.d.ts` has `confirm(title, message, opts?: {signal, timeout}): Promise<boolean>`.
  - `ToolDefinition.execute(..., ctx)`.
  - Interactive mode renders `showExtensionSelector(title+message, ["Yes","No"])`.
  - Without a UI, the runner's default `confirm` returns `false`.
  - `ui_prompt_start` and `ui_prompt_end` events exist.
  - `examples/extensions/permission-gate.ts` uses `ctx.ui.select` from `tool_call`.
- **Method:** Ask the model to call `flowryn_merge`. On `ui_prompt_start`, press Enter to choose Yes. In a second round, press Escape. The tool logs each answer.
- **Desk-check (not a live verdict):** confirmed: `true` for Enter/Yes and `false` for Escape. In print or JSON mode it is always `false`, which fails closed.

### p08-block-shell

- **Claim:** "The extension blocks shell calls to flowryn merge and flowryn approve" / "M0 the extension can intercept and block a shell tool call."
- **Docs:**
  - `types.d.ts`: `ToolCallEventResult {block?, reason?, terminate?}`, "Fired before a tool executes. Can block."
  - `docs/extensions.md`: "A `tool_call` handler failure blocks the tool as a fail-safe."
  - Firstmate `fm-primary-turnend-guard.ts`: "pi.on("tool_call", ...) can block (verified 2026-07-09 against pi 0.80.5: returning {block: true} prevents the bash command from running)".
- **Method:** Run three bash commands and check the side-effect files. The control runs. `touch merge-ran && echo flowryn merge T17` and the matching approve command must be blocked.
- **Desk-check (not a live verdict):** confirmed. Caveat: the regex gate only sees text. A model can still reach the binary another way, such as another interpreter or an encoded string. The design already accepts this: the approval key never enters any environment.

### p09-composer-read

- **Claim:** "Only if M0 proves the extension can read the composer: idle for 60 s and the composer empty M0."
- **Docs:** `types.d.ts` `ExtensionUIContext` has `getEditorText(): string`, `setEditorText`, and `onTerminalInput(handler)`. Firstmate `fm-calm.ts` reads `ctx.ui.getEditorText()` inside `onTerminalInput`. In interactive mode, `getEditorText` is `editor.getExpandedText?.() ?? editor.getText()`. The no-UI runner default returns `""`.
- **Method:**
  1. Type a draft and read it back.
  2. Clear it with Ctrl+U and read it again.
  3. Wait 62 s untouched; the probe's `activity` check must report inactive.
  4. Press one key; `activity` must report active.

  The inactive rule is: no `onTerminalInput` for at least 60 s, an empty composer, and `isIdle()`.
- **Desk-check (not a live verdict):** confirmed in TUI mode. The API has existed since at least Firstmate's 0.8x use. It returns `""` in RPC and print modes, so a Pi leader outside the TUI must not use the wake path.

### p10-session-resume

- **Claim:** "session_start in the extension reports the same [session id]" / "resume: Pi's session-resume flag with the stored session M0".
- **Docs:**
  - `docs/cli.md`: `--session <path|id>` "Opens by file path, exact ID, or partial ID. Pi searches the current project first and offers to fork a cross-project match". `--session-id <id>` "Opens the exact project session ID or creates it if absent". `--session-dir <dir>` overrides storage and lookup.
  - `ReadonlySessionManager` has `getSessionId()` and `getSessionFile()`.
  - Bash tool children get `PI_SESSION_ID` and `PI_SESSION_FILE` (`docs/environment-variables.md`).
  - A resume through the CLI arrives as `session_start` reason **`startup`**. The reason `resume` is only the in-process `/resume`. Firstmate infers a resume from argv plus the header timestamp.
- **Method:** Capture the id and file, then quit. Relaunch with `--session <file>` and check the same id, the prior entries, and recall of a codeword. Separately, launch with `--session-id <preassigned>`, quit, and relaunch with the same id.
- **Desk-check (not a live verdict):** confirmed. Recommend `--session-id` so Flowryn assigns the id before launch and does not need to capture it. Otherwise use `--session <absolute file>`. Avoid a bare id or partial id with `--session`, because it can trigger a fork prompt for a match in another project.

### p11-trust

- **Claim:** "Pi asks for trust per path on first run; pre-register it M0 where the trust record lives".
- **Docs:**
  - `docs/security.md`: trust is required only when the cwd has protected resources: `.pi/settings.json`, `.pi/{extensions,skills,prompts,themes}`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, or project `.agents/skills` in the cwd or an ancestor. `~/.agents/skills` is ignored (`trust-manager.js`).
  - Precedence: "A command-line `--approve` or `--no-approve` override applies first". Next, user-level or `-e` extensions answer `project_trust`. Next, "Saved decisions ... live in `~/.pi/agent/trust.json`" (nearest ancestor wins). Last, `defaultProjectTrust` (default `"ask"`).
  - Also: "Pi reads the project `sessionDir` setting ... before it resolves project trust."
- **Method:** Four cases: A, a plain cwd; B, a cwd with `.pi/settings.json` and the probe answering `undecided`, where the prompt is expected and never answered; C, the probe answering `yes` without `remember`; D, `--approve`. The spike hashes `trust.json` before and after.
- **Desk-check (not a live verdict):** **partial.** Pi has a trust prompt, but only for protected project resources. A plain worktree has no gate. `--approve`, or a `project_trust` answer from Flowryn's `-e` extension, settles trust for one process with no write to `trust.json`. If the spike finds no gate even in case B, it reports `refuted: no trust prompt at all`.

### p12-extension-flag

- **Claim:** "Extension loaded by flowryn lead --pi M0 flag" / "the Flowryn extension loaded for the run M0".
- **Docs:** `docs/cli.md`: "`-e`, `--extension <path>` Loads an extension file or directory and is repeatable." "`-ne`, `--no-extensions` Disables discovered and configured extensions. Explicit `-e` paths still load." "Resource paths apply only to the current process."
- **Method:** Start instance a with `-e` and instance b without it, both with `FLOWRYN_PROBE_LOG` set. b must log nothing. Instance c uses `-e -ne` and is informational.
- **Desk-check (not a live verdict):** confirmed. The flag is `-e`/`--extension`. Workers still load the user's **global** `~/.pi/agent/extensions`, for example Herdr's `herdr-agent-state.ts`, which Firstmate's live test relies on. Decide whether workers should run with `-ne`.

### p13-steer-mode

- **Claim:** "deliverWhileBusy: sendMessage(…, {deliverAs: "followUp"}); M0 whether a mid-run steer mode is better".
- **Docs:** A steer mode **exists**. `sendMessage` accepts `deliverAs: "steer"`, and so does `sendUserMessage`. `docs/usage.md`: "A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up ... waits until Pi finishes the current task." CHANGELOG: "Fixed steering messages to wait until the current assistant message's tool-call batch fully finishes."
- **Method:** Run three sequential `sleep 4` calls. Send a steer S and a follow-up F at the first tool start. Compare when each reaches a request, and count the bash calls made after S.
- **Desk-check (not a live verdict):** confirmed. A steer reaches the model after the current tool batch, mid-run. That makes it the right `deliverWhileBusy` for a worker, and the equivalent of Claude's PostToolUse steer. Keep `followUp` for the leader's "after this turn" P0.

### p14-abort

- **Claim:** "interrupt: Extension abort of the current run M0".
- **Docs:** `types.d.ts`: `ExtensionContext.abort()`, "Abort the current agent operation". In interactive mode, the extension abort handler runs `restoreQueuedMessagesToEditor({abort: true})` and then `session.abort()`. `docs/usage.md`: "Aborting returns queued messages to the editor."
- **Method:** Run `sleep 29.7` and have the probe queue Q14 (a custom follow-up) and U14 (a user follow-up), then call `ctx.abort()`. The spike measures:
  - `abort → agent_settled` latency
  - `agent_before_settle` outcome
  - whether the sleep process still runs
  - whether a new prompt then works
  - where Q14 and U14 end up
- **Desk-check (not a live verdict):** confirmed: fast settle, outcome `aborted`, and the worker is reusable. Side effect: an abort **clears the queues**. Queued user-text steers and follow-ups are moved into the composer, ahead of any draft. Queued custom messages are dropped, because `agent.clearAllQueues()` clears them. A steer queued just before an interrupt is therefore lost or lands in the composer. The ticket/re-ring rule (section 9) must treat it as not presented.

## Desk-check summary (predictions, NOT live verdicts)

| Item | Predicted | Key evidence (0.87.1) |
|---|---|---|
| p01-next-turn | confirmed | Only `prompt()` drains `_pendingNextTurnMessages`. Not triggerTurn, not a queued steer or follow-up, memory only. |
| p02-follow-up | confirmed (refined) | `agent.followUp()` while streaming. `prompt()` throws when busy without behavior (`sendUserMessage` only). A custom message with no deliverAs is steered. |
| p03-trigger-turn | confirmed | Idle trigger calls `_runAgentPrompt`. The editor is untouched and the draft survives. |
| p04-agent-settled | confirmed (refined) | `finally` in `_runAgentPrompt`. `agent_start` repeats per continue. Pre-run rejections and idle `/compact` emit nothing. |
| p05-system-prompt-append | confirmed | `--append-system-prompt <text\|path>`, repeatable. |
| p06-briefing | confirmed (gap for overflow retry) | nextTurn at `session_start`. `session_compact` reports `willRetry`. |
| p07-ui-confirm | confirmed | `ctx.ui.confirm` shows a Yes/No selector. No UI means `false`. |
| p08-block-shell | confirmed | `tool_call` returns `{block: true}`, verified on 0.80.5 by Firstmate. |
| p09-composer-read | confirmed (TUI only) | `ctx.ui.getEditorText()` and `onTerminalInput`. |
| p10-session-resume | confirmed | `--session <path\|id>`, `--session-id <id>`, `getSessionId()`. |
| p11-trust | partial | Prompt only for protected project resources. `~/.pi/agent/trust.json`. `--approve` or an `-e` `project_trust` answer settles it per process. |
| p12-extension-flag | confirmed | `-e/--extension`, process-scoped. Global extensions still load. |
| p13-steer-mode | confirmed: steer is better for workers | `deliverAs: "steer"` is delivered after the current tool batch. |
| p14-abort | confirmed (queue side effect) | `ctx.abort()` calls `restoreQueuedMessagesToEditor({abort: true})` and then `session.abort()`. |

## Design claims the docs already contradict or refine

These should change `docs/design-v3.html` before M1. Each one is still to be confirmed live by its spike.

1. **Package and repo identity.** Pi is now `@earendil-works/pi-coding-agent` at `github.com/earendil-works/pi`. `@mariozechner/pi-coding-agent` is deprecated at 0.73.1. Contract records and `flowryn doctor --contracts` must pin the new name.
2. **"Pi rejects a busy send without [deliverAs]"** is true only for `sendUserMessage`, and the rejection is reported asynchronously rather than thrown. A busy `sendMessage` (custom message) without deliverAs is **steered**. The bridge must always pass `deliverAs` explicitly.
3. **"Pi asks for trust per path on first run; pre-register it"** is inaccurate. The trust gate exists only when the worktree, or an ancestor with `.agents/skills`, has protected project resources. The record is `<agent-dir>/trust.json`, a map of canonical path to boolean where the nearest ancestor wins. `preTrust` for Pi should be a launch argument (`--approve`, or `--no-approve` to ignore project resources) or a `project_trust` answer in the Flowryn extension. It should not be a file write. Pre-registering an ancestor path in `trust.json` would also work, but it edits the user's global config.
4. **"M0 whether a mid-run steer mode is better"**: the mode exists. `deliverAs: "steer"` is delivered after the current tool batch. Prefer it for `deliverWhileBusy` on Pi workers.
5. **Composer read hedge.** `ctx.ui.getEditorText()` and `ctx.ui.onTerminalInput()` exist, and Firstmate already uses them. The "otherwise a Pi P0 never starts a turn" fallback (sections 5, 9 and 18) is likely unnecessary in TUI mode. It is still needed for RPC and print leaders.
6. **Busy/idle from `agent_start`/`agent_settled`.** `agent_settled` is once per run, but `agent_start` can repeat within one run, on every retry or continue. Pre-run rejections emit neither event. An idle manual `/compact` emits no `agent_settled`. Busy tracking must be idempotent and must not pair the two events 1:1. `agent_before_settle` (0.87.0+) also gives the run outcome.
7. **Re-brief after compaction.** A nextTurn re-brief misses the retried turn after overflow compaction (`willRetry: true`). Use steer or followUp in that case.
8. **nextTurn is volatile.** It is held in memory until the next `prompt()`. It is lost on quit or crash, and it does not ride `triggerTurn` runs. The "carried again, dedup by id" rule must re-queue P1 digests in every new session.
9. **Resume flag.** `--session <path|id>` resumes and arrives as `session_start` reason `startup`, not `resume`. `--session-id <id>` lets Flowryn choose the id at launch, which removes the capture step. `--session-dir` isolates storage per run.
10. **Interrupt side effect.** Extension abort clears Pi's queues. Queued user text moves into the composer, and queued custom messages are dropped. A steer queued before an interrupt is not presented.
11. **Extension scoping.** `-e` is process-scoped as designed, but the user's global Pi extensions still load in every Flowryn-launched Pi. This includes Herdr's state extension. Decide on `-ne` for workers deliberately.
