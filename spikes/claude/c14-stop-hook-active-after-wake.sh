#!/usr/bin/env bash
# Turn-end guard (spec 2, ship A): what stop_hook_active reads at the Stop of
# a turn the asyncRewake waiter woke. The wake reaches the model as a "Stop
# hook blocking error" (c01), so the woken turn may count as a Stop-hook
# continuation. If it does, a guard that skips every stop_hook_active=true
# Stop would skip every steer-woken turn.
#
# Method: one session. Turn 1 from a typed prompt; its Stop arms a waiter.
# Fire the waiter (exit 2 with a line); the woken turn's Stop is logged. Then
# a second typed prompt for contrast.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c14-stop-hook-active-after-wake
lab_ensure
DIR=$(spike_workdir "$ID")
mkdir -p "$DIR/ctl" "$DIR/waiters"

cat > "$DIR/settings.json" <<EOF2
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ups)"}]}],
 "Stop":[{"hooks":[
   {"type":"command","command":"$(probe_cmd "$DIR" stop)"},
   {"type":"command","command":"$(probe_cmd "$DIR" waiter)","asyncRewake":true,"timeout":600}]}]
}}
EOF2
cat > "$DIR/ctl/waiter.sh" <<EOF2
n=\$(cd "$DIR/waiters" && ls waiter.*.pid 2>/dev/null | wc -l | tr -d ' '); n=\$((n+1))
echo \$\$ > "$DIR/waiters/waiter.\$n.pid"
probe_mark "armed-waiter-\$n"
i=0
while [ \$i -lt 2500 ]; do
  if [ -f "$DIR/waiters/waiter.\$n.fire" ]; then cat "$DIR/waiters/waiter.\$n.fire" >&2; exit 2; fi
  sleep 0.2; i=\$((i+1))
done
EOF2

stops() { events_count "$DIR" '.event == "Stop" and .label == "stop"'; }
has_mark() { [ "$(events_count "$DIR" ".phase == \"$1\"")" -ge 1 ]; }

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
claude_send "$PANE" "Say hello in two words."
wait_for 90 '[ "$(stops)" -ge 1 ]' || true
wait_until 20 has_mark armed-waiter-1 || true
sleep 2
N1="i$RANDOM$RANDOM"
printf '%s' "Flowryn: steer m1 from your leader is waiting. Mention $N1 in one short line." > "$DIR/waiters/waiter.1.fire"
wait_for 90 '[ "$(stops)" -ge 2 ]' || true
sleep 2
claude_send "$PANE" "Say ok."
wait_for 90 '[ "$(stops)" -ge 3 ]' || true
sleep 1
active=$(jq -rs '[.[] | select(.event == "Stop" and .label == "stop") | .input.stop_hook_active] | map(tostring) | join(",")' "$DIR/events.jsonl")
woke=no; claude_assistant_text "$DIR" | grep -qF "$N1" && woke=yes
claude_stop "$PANE"

second=$(printf '%s' "$active" | cut -d, -f2)
evidence="stop_hook_active per Stop [typed, waiter-woken, typed]=[$active]; waiter-woken turn mentioned nonce=$woke"
if [ "$woke" = yes ] && [ -n "$second" ]; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
