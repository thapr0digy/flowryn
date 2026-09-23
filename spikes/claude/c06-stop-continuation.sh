#!/usr/bin/env bash
# M0 claim (design §5, P0 while busy): a Stop hook continues the turn with one
# line in hookSpecificOutput.additionalContext, shown as hook feedback rather
# than an error, and a second consecutive continuation also works.
#
# Method: the Stop probe answers the first two Stops with
# {hookSpecificOutput:{hookEventName:"Stop", additionalContext:<P0 line>}},
# each carrying a nonce. The model must mention both nonces in continued
# replies without a new user prompt, and the pane must not show an error.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c06-stop-continuation
lab_ensure
DIR=$(spike_workdir "$ID")
mkdir -p "$DIR/ctl"
N1="i$RANDOM$RANDOM"
N2="i$RANDOM$RANDOM"

cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ups)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF
cat > "$DIR/ctl/stop.sh" <<EOF
n=\$(cat "$DIR/stop-count" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$DIR/stop-count"
case \$n in
  1) id=$N1 ;;
  2) id=$N2 ;;
  *) exit 0 ;;
esac
jq -cn --arg c "Flowryn P0 [\$id]: worker for \"migrate billing\" is blocked on a question for you. Mention \$id in one short line." \
  '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: \$c}}'
EOF

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
claude_send "$PANE" "Say hello in two words."
wait_events "$DIR" '.event == "Stop"' 3 120 || true
sleep 2
texts=$(claude_assistant_text "$DIR" | tr '\n' ' ')
screen=$(lab_pane_read "$PANE" 40)
stops=$(events_count "$DIR" '.event == "Stop"')
prompts=$(events_count "$DIR" '.event == "UserPromptSubmit"')
active=$(jq -rs '[.[] | select(.event == "Stop") | .input.stop_hook_active] | map(tostring) | join(",")' "$DIR/events.jsonl")
claude_stop "$PANE"

c1=no; c2=no; err=no
printf '%s' "$texts" | grep -qF "$N1" && c1=yes
printf '%s' "$texts" | grep -qF "$N2" && c2=yes
printf '%s' "$screen" | grep -qiE 'hook error|blocking error|failed' && err=yes
label=$(printf '%s' "$screen" | grep -iE 'stop hook|hook' | head -n 2 | tr '\n' ' ' | cut -c1-120)
evidence="stops=$stops user_prompts=$prompts stop_hook_active=[$active]; first continuation=$c1, second=$c2; error shown=$err; pane hook line: ${label:-<none>}; replies: $(printf '%s' "$texts" | cut -c1-160)"
if [ "$c1" = yes ] && [ "$c2" = yes ] && [ "$err" = no ] && [ "$prompts" = 1 ]; then verdict=confirmed
elif [ "$c1" = yes ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
