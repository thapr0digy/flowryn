# Pi bridge spikes (M0)

These spikes check the Pi half of the M0 contract in `docs/design-v3.html`: the section 17 "Pi bridge" list, plus every Pi-side M0 mark in sections 5, 7, 9 and 11. They are throwaway code. Each script ends with one verdict written by `pi_verdict` to `spikes/.runs/results/<id>.json`. The curated record is [`docs/m0-verdicts.md`](../../docs/m0-verdicts.md).

All 14 ran live against **Pi 0.87.1** (`/opt/homebrew/bin/pi-signed`, the Pi Launcher build of `@earendil-works/pi-coding-agent` 0.87.1) on 2026-09-23. Each ran in an isolated Herdr lab session, with every model turn coming from the offline scripted provider below. Run them with `spikes/run-all.sh pi` or `spikes/pi/run-all.sh`.

## Files

- `lib/scripted-provider.ts` is a deterministic Pi model that needs no network and no credentials. It is registered with `pi.registerProvider` as `flowryn-scripted/scripted` (32k context window). Its API shape follows Pi's `docs/custom-provider.md` and the previous orchestrator's offline test providers.
  - A spike scripts the model inside the prompt. Everything after `FLOWRYN-SCRIPT:` is a list of steps separated by ` ;; `: `say <text>`, `bash <command>`, `tool <name> <json>`, `error <message>` (fails every attempt) and `overflow` (fails once with `context_length_exceeded`).
  - Step N answers the request that already has N assistant replies after the script message. Tool results, steers and follow-ups therefore advance the script the way a real turn would.
  - `say {markers}` echoes every `FLOWRYN-MARK-*` in the request, which proves what context the model received.
  - A `!` prefix reports near-full usage, which triggers threshold compaction.
  - Summarization requests get a fixed summary with no markers in it.
  - Each request is logged to `<instance>.provider.jsonl`.
- `extension/flowryn-probe.ts` is the observation probe, and every spike loads it with `-e`.
  - It writes a JSONL log to `$FLOWRYN_PROBE_LOG` and polls a JSONL command file at `$FLOWRYN_PROBE_CTL`. The file header lists every control.
  - It sends with `nextTurn`, `followUp`, `steer` or `triggerTurn` at a chosen event.
  - It aborts, compacts, reads the composer, and reports activity and status.
  - It sends the briefing and the numbered re-brief. `FLOWRYN_PROBE_REBRIEF_DELIVER=auto` steers when `willRetry` is set or the agent is busy.
  - It also provides the `flowryn_merge` tool with `ctx.ui.confirm`, the shell block, and `project_trust` answers.
- `lib/pi-spike.sh` holds the shared helpers: launch, JSONL queries, probe control, pane input and the verdict. All Herdr traffic goes through `lab_herdr` in `spikes/lib/lab.sh`. Each launch command is written to `<instance>.command.sh`, and the pane runs that file, because the full command line overflowed what Herdr types into the pane shell.
- `p01`–`p14` are the spikes. `run-all.sh` provisions one lab session (`fm-herdr-lab.sh name flowryn-m0-pi`), runs them in order and prints the verdict table. It exits non-zero when a spike exits non-zero, records no result, records "not run", or records an inconclusive verdict. A refuted or partial verdict backed by evidence is a finding, not a failure.

## Isolation

- Pi binary: `PI_BIN`, defaulting to `/opt/homebrew/bin/pi-signed` and then `pi` on `PATH`. `~/.zsh_aliases` is not used.
- Agent dir: every launch sets `PI_CODING_AGENT_DIR` to `spikes/.runs/<id>/agent`. No spike reads or writes `~/.pi`. `p11` hashes the real `~/.pi/agent/trust.json` before and after to prove it.
- Sessions go to `--session-dir spikes/.runs/<id>/sessions`, cwds are scratch dirs, and `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0` are set.
- `--approve` is used only for scratch cwds whose `.pi/settings.json` the spike wrote itself.
- The user's `~/.agents/skills` still load, read-only, into every system prompt.

Evidence method: the probe logs the `context` event, which fires before each model request, with the `FLOWRYN-MARK-*` markers found in the request's messages. "Delivered" means a marker was in a model request.

## Optional real-model smoke pass

`FLOWRYN_PI_MODEL=<provider/model>` replaces the scripted provider with a real model and removes the script from each prompt. It needs `FLOWRYN_PI_AGENT_DIR` pointing at a scratch agent dir that holds a *copy* of the provider's `auth.json` (and `models-store.json`), so `~/.pi` is never written. Point `SPIKES_RUNS` at a separate directory so scripted results are not overwritten. `p04` skips S5–S7 in this mode, because they need failures only the scripted provider can produce. The probe logs each assistant message's `responseModel`, the model that actually served it.

```bash
FLOWRYN_PI_MODEL=openrouter/openrouter/free FLOWRYN_PI_AGENT_DIR=/tmp/pi-agent-copy \
  SPIKES_RUNS=$PWD/spikes/.runs/smoke-openrouter bash spikes/pi/p01-next-turn.sh
```

Free models are rate-limited. A 429 or routing error means the provider was unavailable. It is not a verdict against Pi.

## Results (Pi 0.87.1, scripted provider)

| Spike | Verdict | What the live run showed |
|---|---|---|
| p01-next-turn | confirmed | A `nextTurn` queued while idle started no run in 20 s and rode with the next prompt. One queued during a bash call stayed out of that run and rode with the next prompt. |
| p02-follow-up | confirmed | Busy `followUp` sends (custom and user) arrived after the work ended, in the same run (one `agent_settled`). A busy `sendUserMessage` with no `deliverAs` was rejected: the TUI shows `Extension "<runtime>" error: Agent is already processing. Specify streamingBehavior…`, and the extension gets no exception. A busy `sendMessage` with no `deliverAs` was steered into the running turn. |
| p03-trigger-turn | confirmed | An idle `triggerTurn` opened a turn. A half-typed draft stayed in the composer, unsent. |
| p04-agent-settled | confirmed (refined) | One `agent_settled` per run in each case: normal; abort; compaction mid-run; error after 3 retries (4 `agent_start`s); threshold compaction; overflow recovery (2 `agent_start`s). An aborted run emits no `agent_before_settle`. An idle `/compact` emits no `agent_settled`, and a second one fails "Already compacted". |
| p05-system-prompt-append | confirmed | `--append-system-prompt` takes text or a file path, is repeatable, and reaches both `getSystemPrompt()` and the per-run system prompt. |
| p06-briefing | confirmed (gap confirmed) | The briefing is not sent while idle, and it is in the first prompt's request. The `/compact` re-brief is in the next request. After **overflow** compaction (`willRetry: true`), a `nextTurn` re-brief missed the retried run and arrived with the next prompt. A `steer` re-brief reached the retried run. |
| p07-ui-confirm | confirmed | `ctx.ui.confirm` inside `flowryn_merge` showed a selector: Enter gave `true` and Escape gave `false`. |
| p08-block-shell | confirmed | `tool_call` returning `{block: true}` stopped both commands (their side-effect files were never created). The model received the block reason as the tool result, and `tool_execution_end` reported `isError`. A blocked call emits no `tool_result` event. |
| p09-composer-read | confirmed | `getEditorText()` returned the typed draft and then `""` after Ctrl+U. After 62 s untouched, the activity check read inactive. One keystroke made it active. |
| p10-session-resume | confirmed | `--session <file>` reopened the same id with its entries (reason `startup`), and the model saw the earlier codeword. `--session-id <preassigned>` created the session, and relaunching with the same id reopened it. |
| p11-trust | partial | A plain cwd has no trust gate. A cwd with `.pi/settings.json` blocks startup at "Trust project folder?" with five choices, and the spikes never answer it. A `-e` extension answering `project_trust` yes, or `--approve`, starts the session with no `trust.json` write. |
| p12-extension-flag | confirmed (refined) | `-e` loads only in its own process. A user-level extension in `<agent-dir>/extensions` loaded in every launch; `--no-extensions` disabled it and still loaded `-e`. |
| p13-steer-mode | confirmed: steer is better for workers | The steer reached the model right after the first tool batch (+5 s), and the `followUp` only after the final stop (+13 s). The two bash calls after the steer were scripted, so they are not a model decision. |
| p14-abort | confirmed (queue side effect) | `ctx.abort()` 2 s into `sleep 29.7` settled in 8–12 ms and killed the sleep, and the next prompt ran. No `agent_before_settle`. The queued user follow-up moved into the composer, and the queued custom follow-up was dropped. In an earlier run the abort happened in the same tick as the queueing, and the user follow-up stayed queued; it was delivered after the next prompt. |

## Harness notes

- `ctl_now` is called inside `$(...)`, so its id comes from the clock and `$RANDOM`. A `CTL_SEQ` counter did not survive the subshell, and repeated reads returned the first answer.
- The log queries read JSONL line by line and skip a half-written last line, because the probe appends while the spike reads.
- A trust dialog in a spike's own scratch cwd means the launch forgot `--approve` or a plain cwd. Fix the launch; never answer the dialog.
