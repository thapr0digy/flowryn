#!/usr/bin/env bash
# M0 claim (design §17 Herdr item, §6 reattach): Herdr's agent_session field
# can carry the harness session id for a pane.
#
# Method: in a lab pane, take agent authority with `pane report-agent`, then
# report a session id with `pane report-agent-session` from two sources: the
# Flowryn source ("flowryn") and Herdr's own integration source
# ("herdr:claude", the source its bundled integrations use). Read agent_session
# back after each. Also record whether a live Claude pane (with no Herdr Claude
# integration installed in user settings) gets agent_session on its own.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=h05-agent-session
lab_ensure
DIR=$(spike_workdir "$ID")
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')
SID1="11111111-1111-4111-8111-$(printf '%012d' "$RANDOM")"
SID2="22222222-2222-4222-8222-$(printf '%012d' "$RANDOM")"
session_of() { lab_herdr agent get "$1" | jq -c '.result.agent.agent_session'; }

PANE=$(lab_new_pane "$DIR" "$ID") || lab_die "no pane"
lab_herdr pane report-agent "$PANE" --source flowryn --agent claude --state idle --seq 1 >/dev/null
lab_herdr pane report-agent-session "$PANE" --source flowryn --agent claude --seq 2 --agent-session-id "$SID1" >/dev/null
from_flowryn=$(session_of "$PANE")
lab_herdr pane report-agent-session "$PANE" --source herdr:claude --agent claude --seq 3 --agent-session-id "$SID2" >/dev/null
from_herdr=$(session_of "$PANE")
lab_herdr pane release-agent "$PANE" --source flowryn --agent claude >/dev/null 2>&1 || true
lab_pane_close "$PANE"

cat > "$DIR/settings.json" <<EOF
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}]}}
EOF
CPANE=$(claude_launch "$DIR" "$ID-live" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
live=$(session_of "$CPANE")
claude_stop "$CPANE"

evidence="report from source flowryn -> agent_session=$from_flowryn; from source herdr:claude -> $from_herdr; live Claude pane without Herdr's Claude integration -> $live"
if printf '%s' "$from_flowryn" | grep -qF "$SID1"; then verdict=confirmed
elif printf '%s' "$from_herdr" | grep -qF "$SID2"; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
