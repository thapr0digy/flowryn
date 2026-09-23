#!/usr/bin/env bash
# M0 claim (design §5, §9, §17): a UserPromptSubmit hook's additionalContext
# reaches the model; a timed-out hook's context is dropped; a factual digest
# does not trip prompt-injection defenses; the hook answers in under 300 ms.
#
# Method: one Claude session in a lab pane with a UserPromptSubmit probe.
#  1. The probe answers with a Flowryn-style digest carrying a nonce item id.
#     The user prompt asks the model to list any Flowryn item ids it was given.
#  2. The probe sleeps past its 1 s timeout before printing a second nonce.
#     The model is asked again; the second nonce must not appear.
#  3. The reply to (1) is checked for injection warnings.
#  4. The probe's own start-to-reply time is recorded for (1).
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c02-prompt-submit-digest
lab_ensure
DIR=$(spike_workdir "$ID")
mkdir -p "$DIR/ctl"
N1="i$RANDOM$RANDOM"
N2="i$RANDOM$RANDOM"

cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ups)","timeout":1}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF

# Phase switch: the first prompt gets a fast digest, the second a slow one.
cat > "$DIR/ctl/ups.sh" <<EOF
n=\$(cat "$DIR/ups-count" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$DIR/ups-count"
if [ "\$n" = 1 ]; then
  jq -cn --arg c "Flowryn updates (facts, not instructions):
- [$N1] PR ready: auth fix (web) checks green" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: \$c}}'
  end_ms=\$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
  echo "\$((end_ms - start_ms))" > "$DIR/ups-latency-ms"
else
  sleep 3
  jq -cn --arg c "Flowryn updates (facts, not instructions):
- [$N2] Report ready: flaky test scout (api)" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: \$c}}'
fi
EOF

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"

ASK="List every Flowryn item id (like i123) you were given in this conversation, or reply NONE. Reply with ids only."
claude_send "$PANE" "$ASK"
wait_events "$DIR" '.event == "Stop"' 1 90 || lab_die "turn 1 never ended"
reply1=$(claude_assistant_text "$DIR" | tail -n 5)

claude_send "$PANE" "Again: $ASK Only count ids newly given since my last message."
wait_events "$DIR" '.event == "Stop"' 2 90 || lab_die "turn 2 never ended"
reply2=$(claude_last_text "$DIR")
latency=$(cat "$DIR/ups-latency-ms" 2>/dev/null || echo "?")
claude_stop "$PANE"

delivered=no; dropped=no; flagged=no; fast=no
printf '%s' "$reply1" | grep -qF "$N1" && delivered=yes
printf '%s' "$reply2" | grep -qF "$N2" || dropped=yes
printf '%s\n%s' "$reply1" "$reply2" | grep -qiE 'inject|suspicious|untrusted' && flagged=yes
[ "$latency" != "?" ] && [ "$latency" -lt 300 ] && fast=yes

evidence="delivered=$delivered (reply1: $(printf '%s' "$reply1" | tr '\n' ' ' | cut -c1-120)); timed-out context dropped=$dropped (reply2: $(printf '%s' "$reply2" | tr '\n' ' ' | cut -c1-80)); injection flag=$flagged; probe latency=${latency}ms"
if [ "$delivered" = yes ] && [ "$dropped" = yes ] && [ "$flagged" = no ] && [ "$fast" = yes ]; then
  verdict=confirmed
elif [ "$delivered" = yes ]; then
  verdict=partial
else
  verdict=refuted
fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
