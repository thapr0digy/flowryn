# Notifications that reach you off the Mac

- Status: done
- Open: no real push service run end to end (tests never reach the network); your first `flowryn notify test` is that check
- Config: `[notify] command`, `[notify] command_timeout_s`

Scout finding 11 (scout-efficiency-and-fz): notifications reached only the Mac (osascript) and Herdr, so a P0 raised while you were away from the desk reached nobody. The predecessor had a `command:<cmd>` channel on its wedge alarm (firstmate `docs/wedge-alarm.md`) and a full mail client (`bin/fm-mail.sh`). This adds the command channel only: your script does the delivery, so Flowryn carries no credentials or service code.

## What changed

Plain code, no model.

- **`[notify] command`** (`src/config/leader.ts`): a shell command, empty (the default) for off. **`[notify] command_timeout_s`** (default 10) bounds each run.
- **Which sends reach it** (`src/attention/notify.ts`, `NotifyPump.plan`): every P0 send (the first, and each re-notify after `p0_renotify_min`), and the batched P1 send only while you are away (`flowryn away`, or automatic away). The timing and grouping are the existing ones; the command adds no rate of its own. At home the Mac channels keep their batch; a batch with no channel at all (Mac and Herdr off, not away) is not recorded, so it still goes out once you are away.
- **How it runs** (`runNotifyCommand`): `/bin/sh -c "<command>"` through `runBounded` (its own process group, the deadline, SIGTERM, grace, group SIGKILL, a ledger entry), cwd the Flowryn home, output capped at 64 KiB, stdout ignored.
  - stdin: the title line (`Flowryn: a P0 needs you`, `Flowryn: 3 items need you`, `Flowryn: test notification`), then `<item> <lane> <line>` for every item in the send (not the one-line "+N more" summary), through `redactSecrets`.
  - environment: the daemon's, scrubbed as verify steps are (`src/runtime/child-env.ts`: no `FLOWRYN_*`, Claude session variables, `GH_TOKEN` or `GITHUB_TOKEN`), plus `FLOWRYN_NOTIFY_ID` (`n12`; empty for a test), `FLOWRYN_NOTIFY_KIND` (`p0`, `batch` or `test`), `FLOWRYN_NOTIFY_AWAY` (`1` or `0`), `FLOWRYN_NOTIFY_ITEMS` (space-separated item ids) and `FLOWRYN_NOTIFY_TITLE`. Item text is never in the command line, an argument or the environment.
- **Each run is a `notification.command` event**: `{notification, kind, ok, code, timed_out, stderr}` (stderr one line, at most 300 characters, redacted). A failure is also a daemon log line. Nothing is retried: a script that delivered and then exited non-zero would send twice.
- **`flowryn notify test`** (your terminal only, `src/attention/verbs.ts`): the daemon runs the command once with a sample line, with the same environment, cwd and deadline as a real send, and records the run. Refused with `not_supported` under `FLOWRYN_NOTIFY=off`, `not_configured` with no command; a failed run is `notify_failed` with the exit code and stderr.
- **`flowryn doctor`** (`notifyCommandCheck`): with a command set, `info` before any run, `ok` with the last run's time, `warn` with the code and stderr when the last run failed.
- **`FLOWRYN_NOTIFY=off`** (every test home) stops this channel like the others: the send is recorded, the command never runs.

## Setting it up

```toml
[notify]
command = "/Users/you/bin/flowryn-push.sh"
command_timeout_s = 10
```

Then reload the config (`SIGHUP` to the daemon, or `flowryn daemon restart`) and run `flowryn notify test`. The daemon runs under launchd, whose `PATH` is short: use full paths in the script.

Example scripts (none ships with Flowryn):

```sh
#!/bin/sh
# ntfy.sh: the whole text as the message, the title as the header.
exec /usr/bin/curl -fsS -H "Title: $FLOWRYN_NOTIFY_TITLE" --data-binary @- https://ntfy.sh/your-private-topic
```

```sh
#!/bin/sh
# Pushover: the item lines as the message (the token and user from a file only you can read).
. "$HOME/.config/flowryn-pushover.env"
body=$(tail -n +2)
exec /usr/bin/curl -fsS --form-string "token=$PUSHOVER_TOKEN" --form-string "user=$PUSHOVER_USER" \
  --form-string "title=$FLOWRYN_NOTIFY_TITLE" --form-string "message=$body" https://api.pushover.net/1/messages.json
```

```sh
#!/bin/sh
# Local mail, only while away or for a P0.
exec /usr/bin/mail -s "$FLOWRYN_NOTIFY_TITLE" you@example.com
```

## Choices

- **P0 always, the batch only while away**: the task's scope. At the desk the Mac already shows the batch; a phone ping every 30 minutes would be noise.
- **One command, not a list**: a script can call several services itself.
- **stdin and env, not `$1`** (the predecessor passed the text as `$1` too): stdin keeps several lines whole and needs no quoting care.
- **Redacted before sending**: the text leaves the machine for a third party.
- **One `notification.command` event per run, success or failure** (the design page named a `notification.channel_failed` event for failures): doctor needs the last run either way, and a success recorded beside `notification.sent` would not tell a delivered send from one under `FLOWRYN_NOTIFY=off`.
- **The test runs in the daemon** (a mutation whose `prepare` awaits the pump): launchd's environment is the most likely way a script that works in your terminal breaks.
- **No migration**: `notifications.channel` already holds `<kind>:<channels>`, so a command send reads `p0:macos+herdr+command`.
- **No README change**: setup lives here, as AGENTS.md asks.
- **Not changed**: the alert `flowryn daemon relaunch` posts when a relaunch fails (`src/cli/commands/daemon.ts`) stays macOS only; it runs outside the daemon, with no pump.

## Tests

`test/unit/notify-command.test.ts`, with a real `/bin/sh` script that records its stdin and environment:

- config: the default, trimming, wrong types, the timeout bound, an unknown key;
- stdin and env shape, redaction, the scrubbed environment, and shell in an item line only read, never run;
- P0 always, the batch only while away (and not after the away expired), the Mac's batch at home unchanged, no command no change, `FLOWRYN_NOTIFY=off`;
- a non-zero exit (logged, recorded, not retried), a missing program (127), a hung command and the child it forked ended at a 1 s deadline, with the next send still delivered;
- `notify test` through the pump, its refusals, and through a real daemon (the test home's off switch refuses it inside `prepare`);
- doctor's check from seeded events.

Named assumptions: `runBounded` closes stdin after writing (so `cat` ends); the away check in the plan sees what `startAway` wrote; a daemon verb's `prepare` can await the command.
