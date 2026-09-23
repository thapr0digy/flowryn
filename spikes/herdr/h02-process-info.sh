#!/usr/bin/env bash
# M0 claim (design §5 exit, §6 reattach, §17 Herdr item): pane.process_info
# identifies the harness process by pid, start time and executable, so reattach
# and exit can prove "the process we launched" and never act on a reused pid.
#
# Method: start Claude in a lab pane and call `pane process-info`. Record the
# fields Herdr returns, match the foreground pid against the Claude process in
# the process table, and read its start time with ps (the field Herdr would
# need to supply for the identity triple).
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=h02-process-info
lab_ensure
DIR=$(spike_workdir "$ID")
cat > "$DIR/settings.json" <<EOF
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}]}}
EOF
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
info=$(lab_herdr pane process-info --pane "$PANE")
printf '%s\n' "$info" > "$DIR/process-info.json"
pi=$(printf '%s' "$info" | jq -c '.result.process_info')
fields=$(printf '%s' "$pi" | jq -r 'keys | join(",")')
proc_fields=$(printf '%s' "$pi" | jq -r '[.foreground_processes[]? | keys[]] | unique | join(",")')
fg=$(printf '%s' "$pi" | jq -c '[.foreground_processes[]? | {pid, name, argv0, cwd}]')
pid=$(printf '%s' "$pi" | jq -r '[.foreground_processes[]? | select((.name // "") | test("claude|node|2\\.1"; "i"))] | first | .pid // empty')
[ -n "$pid" ] || pid=$(printf '%s' "$pi" | jq -r '.foreground_processes[0].pid // empty')
ps_line=$(ps -p "$pid" -o pid=,lstart=,comm= 2>/dev/null | tr -s ' ')
exe=$(ps -p "$pid" -o comm= 2>/dev/null)
claude_stop "$PANE"
sleep 3
ps -p "$pid" >/dev/null 2>&1 && gone=no || gone=yes

has_start=no
printf '%s %s' "$fields" "$proc_fields" | grep -qiE 'start' && has_start=yes
evidence="process_info fields [$fields]; per-process fields [$proc_fields]; foreground: $fg; ps for pid $pid: ${ps_line:-<none>}; start time in Herdr's answer=$has_start; process gone after /exit=$gone"
if [ -n "$exe" ] && [ "$has_start" = yes ]; then verdict=confirmed
elif [ -n "$exe" ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
