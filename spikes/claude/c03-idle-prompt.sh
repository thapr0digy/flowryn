#!/usr/bin/env bash
# M0 claim (design §5 "You are inactive", §17 Claude bridge item 3): the
# Notification hook with notification_type idle_prompt fires inside a Herdr
# pane about 60 s after a turn ends with no typing, and does not fire while you
# type. (Firing after an interrupt is covered by c04-interrupt.)
#
# Method: one session in a lab pane with a Notification probe.
#  1. A short turn; measure Stop → idle_prompt delay (wait up to 120 s).
#  2. A second short turn; then type one character into the composer every
#     15 s for 90 s without submitting; no idle_prompt may fire in that window.
#     Then stop typing and wait up to 120 s more to see whether it fires with a
#     non-empty composer.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c03-idle-prompt
lab_ensure
DIR=$(spike_workdir "$ID")

cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}],
 "Notification":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" notif)"}]}]
}}
EOF
idle_count() { events_count "$DIR" '.event == "Notification" and .input.notification_type == "idle_prompt"'; }
last_t() { jq -rs "[.[] | select($1)] | last | .t // 0" "$DIR/events.jsonl"; }

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"

# 1. untouched idle
claude_send "$PANE" "Say hi."
wait_events "$DIR" '.event == "Stop"' 1 60 || lab_die "turn 1 never ended"
t_stop1=$(last_t '.event == "Stop"')
wait_for 120 '[ "$(idle_count)" -ge 1 ]' && fired1=yes || fired1=no
t_idle1=$(last_t '.event == "Notification" and .input.notification_type == "idle_prompt"')
delay1=$(( (t_idle1 - t_stop1) / 1000 ))

# 2. typing keeps it quiet
base=$(idle_count)
claude_send "$PANE" "Say hi again."
wait_events "$DIR" '.event == "Stop"' 2 60 || lab_die "turn 2 never ended"
t_stop2=$(last_t '.event == "Stop"')
for ch in a b c d e f; do
  sleep 15
  lab_herdr pane send-text "$PANE" "$ch" >/dev/null
done
during=$(( $(idle_count) - base ))
wait_for 120 '[ "$(idle_count)" -gt "$((base + during))" ]' && fired_after=yes || fired_after=no
t_idle2=$(last_t '.event == "Notification" and .input.notification_type == "idle_prompt"')
after_typing=n/a
[ "$fired_after" = yes ] && after_typing="$(( (t_idle2 - t_stop2) / 1000 ))s"
others=$(jq -rs '[.[] | select(.event == "Notification") | .input.notification_type] | join(",")' "$DIR/events.jsonl")
claude_stop "$PANE"

evidence="untouched: fired=$fired1 after ${delay1}s; typing every 15s for 90s: idle_prompt during typing=$during; after typing stopped (composer non-empty): fired=$fired_after (at $after_typing after the turn; waited 120 s after the last keystroke); all notification types: [$others]"
if [ "$fired1" = yes ] && [ "$delay1" -ge 45 ] && [ "$delay1" -le 90 ] && [ "$during" = 0 ]; then verdict=confirmed
elif [ "$fired1" = yes ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
