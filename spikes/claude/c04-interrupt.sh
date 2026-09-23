#!/usr/bin/env bash
# M0 claims (design §5 Busy/Idle/interrupt rows, §9 races, §17 Claude item 4):
#   - which hooks fire on a manual interrupt (Stop should not);
#   - Escape sent through Herdr pane input interrupts a busy worker;
#   - idle_prompt fires after an interrupt, so the busy lease recovers
#     (busy clears at once on idle_prompt, or after 10 min without events).
#
# Method: a session with probes on every relevant event runs a 60 s foreground
# Bash command (perl sleep; Claude Code 2.1.281 blocks a bare `sleep`).
# Three seconds into the tool call, the spike sends Escape via
# `herdr pane send-keys`. It then records every hook event for 120 s, checks the
# transcript for the interrupt marker and the process table for the sleep, and
# reads Herdr's agent_status.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c04-interrupt
lab_ensure
DIR=$(spike_workdir "$ID")
MARK="flowryn-c04-$RANDOM"

hooks=""
for ev in UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure Stop StopFailure SessionEnd Notification; do
  hooks+="\"$ev\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"$(probe_cmd "$DIR" "$ev")\"}]}],"
done
cat > "$DIR/settings.json" <<EOF
{"permissions":{"allow":["Bash(perl *)"]},
 "hooks":{ $hooks
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}]
}}
EOF

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
claude_send "$PANE" "Run exactly this Bash command in the foreground, not in the background: perl -e 'sleep 60' $MARK"
wait_events "$DIR" '.event == "PreToolUse"' 1 60 || lab_die "tool never started"
sleep 3
pgrep -f "$MARK" >/dev/null && sleeping_before=yes || sleeping_before=no
t_int=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
claude_keys "$PANE" Escape
sleep 5
pgrep -f "$MARK" >/dev/null && sleeping_after=yes || sleeping_after=no
status_after=$(lab_herdr agent get "$PANE" 2>/dev/null | jq -r '.result.agent.agent_status // "?"')
wait_for 120 '[ "$(events_count "$DIR" ".event == \"Notification\" and .input.notification_type == \"idle_prompt\"")" -ge 1 ]' && idle=yes || idle=no
after=$(jq -rs --argjson t "$t_int" '[.[] | select(.t > $t) | "\(.event)\(if .input.notification_type then ":" + .input.notification_type else "" end)@+\(((.t - $t) / 1000) | floor)s"] | join(",")' "$DIR/events.jsonl")
marker=$(jq -r 'select(.type == "user") | .message.content | tostring' "$(claude_transcript "$DIR")" | grep -o 'Request interrupted[^"\\]*' | head -n 1)
stop_after=$(jq -rs --argjson t "$t_int" '[.[] | select(.t > $t and .event == "Stop")] | length' "$DIR/events.jsonl")

# Variant: interrupt while the model is generating text rather than in a tool.
base_idle=$(events_count "$DIR" '.event == "Notification" and .input.notification_type == "idle_prompt"')
base_ups=$(events_count "$DIR" '.event == "UserPromptSubmit"')
claude_send "$PANE" "Write a 600-word essay about lighthouses."
wait_for 60 '[ "$(events_count "$DIR" ".event == \"UserPromptSubmit\"")" -gt "$base_ups" ]' || true
sleep 4
t_int2=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
claude_keys "$PANE" Escape
wait_for 120 '[ "$(events_count "$DIR" ".event == \"Notification\" and .input.notification_type == \"idle_prompt\"")" -gt "$base_idle" ]' && idle2=yes || idle2=no
after2=$(jq -rs --argjson t "$t_int2" '[.[] | select(.t > $t) | "\(.event)\(if .input.notification_type then ":" + .input.notification_type else "" end)@+\(((.t - $t) / 1000) | floor)s"] | join(",")' "$DIR/events.jsonl")
status2=$(lab_herdr agent get "$PANE" 2>/dev/null | jq -r '.result.agent.agent_status // "?"')
claude_stop "$PANE"
evidence="sleep running before Escape=$sleeping_before, after=$sleeping_after; transcript marker: ${marker:-<none>}; hooks after interrupt: [${after}]; Stop after interrupt=$stop_after; idle_prompt after interrupt=$idle; Herdr agent_status 5s after=$status_after || mid-text interrupt: hooks after: [${after2}]; idle_prompt within 120s=$idle2; Herdr agent_status=$status2"
if [ "$sleeping_after" = no ] && [ "$stop_after" = 0 ] && [ "$idle" = yes ] && [ "$idle2" = yes ]; then verdict=confirmed
elif [ "$sleeping_after" = no ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
