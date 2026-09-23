#!/usr/bin/env bash
# Generic Claude Code hook probe used by the Claude spikes.
#
#   probe-hook.sh <spike-dir> <label>
#
# Appends one JSON line per invocation to <spike-dir>/events.jsonl with the
# hook input, a millisecond timestamp, the probe pid, and the FLOWRYN_* env the
# hook process sees. If <spike-dir>/ctl/<label>.sh exists it is sourced after
# logging, with the raw hook input in $HOOK_INPUT, so each spike can script the
# hook's reply (stdout, stderr, exit code, blocking) without a new probe.
set -u
dir=$1
label=$2
HOOK_INPUT=$(cat)
start_ms=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')

log_event() { # <phase>
  local input_json
  input_json=$(printf '%s' "$HOOK_INPUT" | jq -c . 2>/dev/null) || input_json=$(jq -cn --arg raw "$HOOK_INPUT" '{raw: $raw}')
  jq -cn --arg label "$label" --arg phase "$1" --argjson t "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')" \
    --argjson pid "$$" --argjson input "$input_json" \
    --arg run "${FLOWRYN_RUN:-}" --arg token "${FLOWRYN_TOKEN:-}" --arg envfile "${CLAUDE_ENV_FILE:-}" \
    '{t: $t, label: $label, phase: $phase, pid: $pid, event: ($input.hook_event_name // null),
      env: {FLOWRYN_RUN: $run, FLOWRYN_TOKEN: $token, CLAUDE_ENV_FILE: $envfile}, input: $input}' \
    >> "$dir/events.jsonl"
}

# Lets ctl scripts log a second line (for example when a waiter wakes up).
probe_mark() { # <phase>
  log_event "$1"
}

log_event start
export HOOK_INPUT start_ms
if [ -f "$dir/ctl/$label.sh" ]; then
  # shellcheck disable=SC1090
  . "$dir/ctl/$label.sh"
fi
exit 0
