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

# Early states (the #69 regression): what process_info says about the
# foreground group in a pane that has just opened, while agent.start brings
# Claude up, and right after it returns. Each read is reduced to a shape:
# group=absent, group=null, group=shell, group=<n procs>, or the raw type.
shape_of() { # <pane>
  local raw
  raw=$(lab_herdr pane process-info --pane "$1" 2>/dev/null)
  printf '%s' "$raw" | jq -e '.result.process_info | (.foreground_process_group_id | type) != "number"' >/dev/null 2>&1 &&
    printf '%s\n' "$raw" >> "$DIR/early-no-group.jsonl"
  printf '%s' "$raw" | jq -r '.result.process_info
    | if (has("foreground_process_group_id") | not) then "group=absent"
      elif .foreground_process_group_id == null then "group=null"
      elif (.foreground_process_group_id | type) != "number" then "group=" + (.foreground_process_group_id | type)
      elif .foreground_process_group_id == .shell_pid then "group=shell"
      else "group=job(\(.foreground_processes | length) procs)" end
    + " shell_pid=" + (.shell_pid | type)' 2>/dev/null || echo "no-answer"
}
burst() { # <pane> <reads> <out>
  local i
  for ((i = 0; i < $2; i++)); do shape_of "$1" >> "$3"; done
}
tally() { sort "$1" | uniq -c | awk '{c=$1; $1=""; printf "%s%s x%s", sep, substr($0,2), c; sep="; "}'; }
# The lab helper appends --session <lab> to every Herdr call, so agent.start's
# own arguments cannot pass; a shim first on the pane's PATH supplies them, as
# the launcher's shim directory does for a worker.
mkdir -p "$DIR/shim"
printf '#!/bin/sh\nexec %q --setting-sources user --model %q\n' "$(command -v claude)" "$CLAUDE_SPIKE_MODEL" > "$DIR/shim/claude"
chmod +x "$DIR/shim/claude"
out=$(lab_herdr workspace create --cwd "$CLAUDE_SPIKE_CWD" --label "$ID-early" --env "PATH=$DIR/shim:$PATH" --no-focus) || lab_die "no early pane"
printf '%s\n' "$(printf '%s' "$out" | jq -r '.result.workspace.workspace_id')" >> "$SPIKES_RUNS/.workspaces.$$"
EARLY=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // .result.pane.pane_id')
burst "$EARLY" 15 "$DIR/early-open.txt"
burst "$EARLY" 2000 "$DIR/early-start.txt" &
burster=$!
# A fresh pane answers agent_pane_busy until its shell is at the prompt; retry as the runtime does.
for _ in $(seq 1 40); do
  lab_herdr agent start "$ID-early" --kind claude --pane "$EARLY" > "$DIR/early-agent-start.json" 2>&1
  grep -q agent_pane_busy "$DIR/early-agent-start.json" || break
  sleep 0.4
done
kill "$burster" 2>/dev/null; wait "$burster" 2>/dev/null
burst "$EARLY" 15 "$DIR/early-after.txt"
lab_pane_read "$EARLY" 40 > "$DIR/early-pane.txt" 2>&1
claude_stop "$EARLY"
early_start=$(jq -r 'if .error then "error " + .error.code else "ok" end' "$DIR/early-agent-start.json" 2>/dev/null)
early="early: after workspace.create [$(tally "$DIR/early-open.txt")]; during agent.start (answered $early_start) [$(tally "$DIR/early-start.txt")]; after agent.start returned [$(tally "$DIR/early-after.txt")]"

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
evidence="process_info fields [$fields]; per-process fields [$proc_fields]; foreground: $fg; ps for pid $pid: ${ps_line:-<none>}; start time in Herdr's answer=$has_start; process gone after /exit=$gone; $early"
if [ -n "$exe" ] && [ "$has_start" = yes ]; then verdict=confirmed
elif [ -n "$exe" ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
