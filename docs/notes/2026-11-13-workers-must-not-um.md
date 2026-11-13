# Toolkit: workers may not kill by name, pattern, port or process group

- Status: done

Leader finding, 2026-11-13: workers ran `pkill -f <pattern>` to stop their own dev instances, and the pattern matched other workers' processes. `pkill -f signal-dev-instance` stopped another worker's dev instance, and earlier a session-wide SIGTERM from a `pkill` stopped the user's apps, terminal and daemons. Patterns seen: `port 9105`, `dev-instance.sh`, `signal-dev-instance`, `bun ui/build.ts --watch`, `/tmp/.../signal`.

## The rule

A new toolkit rule, `process-kill` (`src/policy/toolkit.ts`, `processKillVerdict`), for workers only (a run token, Claude or Pi). The leader and the user keep every kill. It reads the shell line through the existing normalizer (`src/policy/shell.ts`), so `command`, `env`, `sudo`, `timeout`, `xargs`, an absolute path, quotes or a backslash in the name, `sh -c '…'`, `eval`, backticks and `$()` are all seen through. It denies:

- `pkill`, `killall`, `killall5` and `skill` in any form (`pkill -u`, `killall -9 name`, ...), and `fuser -k`.
- `kill` of a process group or of every process: a negative pid (`kill -- -4321`, `kill -TERM -4321`), pid `0`, and any `-1` (`kill -- -1`, `kill -9 -1`, and also `kill -1 <pid>`, where `-1` is SIGHUP; write `kill -HUP <pid>`).
- `kill` on a line that also searches for pids: `pgrep`, `pidof`, `fuser`, `lsof -t`, or a `ps`/`lsof` whose output the line pipes on. This covers `kill $(pgrep -f x)`, `kill $(lsof -ti tcp:8081)` (a kill by port can hit the user's own 8081), `pgrep -f x | xargs kill`, `lsof -i :8081 | awk … | xargs kill` and `ps aux | grep x | awk '{print $2}' | xargs kill`.

It allows a kill of literal pids or job specs (`kill 1234`, `kill -TERM 1234`, `kill -s TERM 1234`, `kill %1`, `kill $!`), a kill of a variable or of a substitution that searches nothing (`kill "$PID"`, `kill $(cat "$TMPDIR/x.pid")`, `cat pids | xargs kill`), `wait`, and pid searches on their own (`pgrep -f x`, `lsof -ti :8081`, `ps aux | grep x`). A line that both searches and kills is denied even when the kill names a literal pid. That is the one deliberate over-match. Variable indirection stays a miss, as for every toolkit rule (docs/cutover-notes.md C1).

## The message

```
Blocked by Flowryn's toolkit rule (process-kill): `pkill -f signal-dev-instance` is not allowed; a kill by name, pattern, port or process group also hits other workers' processes and the user's own apps. Stop only what you started, by its pid: use the project's own stop command if it has one; otherwise record the pid when you start the process (`cmd & echo $! > "$TMPDIR/<name>.pid"`) and run `kill <pid>` or `kill -TERM $(cat "$TMPDIR/<name>.pid")`.
```

A kill fed by a search names both: `` `kill -9` fed by `lsof -ti :8081` ``. The `toolkit.denied` event records `{rule: "process-kill", use: "kill <pid>"}`. appsec-signal has no stop target: `make dev-agent` (`scripts/dev-instance.sh`) runs in the foreground and stops its instance when the command ends, so the message points to the recorded pid.

## The static layer

`src/policy/static.ts` adds `workerBashDenies()`: `Bash(pkill *)`, `Bash(killall *)`, `Bash(killall5 *)` and `Bash(skill *)`, built from the rule's own `KILL_BY_NAME` list. The launcher (`src/lifecycle/launcher.ts`) appends them to each worker's settings only. The shared `staticLayers` and the leader settings do not include them. Prefix rules cannot express the other shapes, so the hook covers those. Worker settings are written at each launch, so nothing migrates.

No `CONTRACT_REVISIONS` bump: the contract suite's toolkit step proves the `gh` deny and the static MCP hide, and nothing about kills.

Tests: `test/unit/toolkit.test.ts` (each indirection and shape denied, the allowed pid kills, leaders untouched, the exact reason, Pi workers), `test/unit/static-layers.test.ts` (the worker backstop matches kills by name only, and the shared layers carry none), `test/integration/toolkit.test.ts` (`pkill -f signal-dev-instance` and `kill $(lsof -ti tcp:8081)` denied through the real pre-tool hook, `kill -TERM 1234` passes).
