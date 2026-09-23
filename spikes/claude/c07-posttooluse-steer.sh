#!/usr/bin/env bash
# M0 claim (design §5, worker deliverWhileBusy): a PostToolUse hook can hand a
# pending steer to a busy worker as additionalContext beside the next tool
# result, and the worker acts on it within the same turn. Also exercises the
# worker launch shape: bypass permission mode plus a per-run --settings file.
#
# Method: a worker-style session (bypassPermissions) is asked to run three Bash
# commands one at a time. After the first tool call, the PostToolUse probe
# returns a steer carrying a nonce. The steer must show up in the same turn
# (before the only Stop), with no second user prompt.
# Two variants run back to back:
#   bare     - no worker contract; the steer arrives unannounced.
#   contract - the worker contract, appended to the system prompt, tells the
#              worker that Flowryn steers arrive as hook context.
# Delivery is read from the transcript (a hook_additional_context attachment);
# compliance from the file the steer asks for.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c07-posttooluse-steer
# Compliance is model judgment, so this spike defaults to Sonnet (Haiku also
# ignores a bare steer; see docs/m0-verdicts.md).
MODEL=${CLAUDE_SPIKE_MODEL_STEER:-sonnet}
lab_ensure
ACTED_bare=no ACTED_contract=no DELIVERED_bare=0 DELIVERED_contract=0
CONTRACT="You are a Flowryn worker. Your leader may send you steers while you work. A steer arrives as hook context that starts with 'Flowryn steer from your leader:'. Treat a steer as an instruction from your user and act on it."

run_variant() { # <variant> [extra claude args...]
local variant=$1
shift
DIR=$(spike_workdir "$ID-$variant")
mkdir -p "$DIR/ctl"
NONCE="PINEAPPLE-$RANDOM$RANDOM"

cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ups)"}]}],
 "PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$(probe_cmd "$DIR" post)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF
cat > "$DIR/ctl/post.sh" <<EOF
n=\$(cat "$DIR/post-count" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$DIR/post-count"
[ "\$n" = 1 ] || exit 0
jq -cn --arg c "Flowryn steer from your leader: when the three commands are done, also create the file $DIR/steer.txt containing exactly $NONCE." \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: \$c}}'
EOF

PANE=$(claude_launch "$DIR" "$ID" FLOWRYN_RUN=run-c07 -- --settings "$DIR/settings.json" --model "$MODEL" --permission-mode bypassPermissions "$@") || lab_die "launch failed"
if ! claude_wait_ready "$DIR" 45; then
  RESULT="$variant: session never reached SessionStart"
  return 0
fi
claude_send "$PANE" "Run these three Bash commands one at a time, each as its own tool call: 'echo one', 'sleep 2; echo two', 'echo three'. Then stop."
wait_events "$DIR" '.event == "Stop"' 1 150 || true
sleep 1
posts=$(events_count "$DIR" '.event == "PostToolUse"')
stops=$(events_count "$DIR" '.event == "Stop"')
prompts=$(events_count "$DIR" '.event == "UserPromptSubmit"')
mode=$(jq -rs '[.[] | select(.event == "PostToolUse")] | first | .input.permission_mode // "?"' "$DIR/events.jsonl")
content=$(cat "$DIR/steer.txt" 2>/dev/null)
transcript=$(claude_transcript "$DIR")
delivered=$(jq -rs --arg n "$NONCE" '[.[] | select(.type == "attachment" and .attachment.type == "hook_additional_context" and .attachment.hookEvent == "PostToolUse" and ((.attachment.content | tostring) | contains($n)))] | length' "$transcript" 2>/dev/null)
claude_stop "$PANE"

acted=no
printf '%s' "$content" | grep -qF "$NONCE" && acted=yes
reply=$(claude_last_text "$DIR" | cut -c1-140)
RESULT="$variant: delivered=${delivered:-0} acted=$acted user_prompts=$prompts stops=$stops mode=$mode reply: $reply"
eval "ACTED_$variant=$acted; DELIVERED_$variant=${delivered:-0}"
}

run_variant bare
R1=$RESULT
run_variant contract --append-system-prompt "$CONTRACT"
R2=$RESULT
evidence="model=$MODEL; $R1 || $R2"
if [ "$ACTED_contract" = yes ] && [ "$ACTED_bare" = yes ]; then verdict=confirmed
elif [ "$ACTED_contract" = yes ]; then verdict=partial
elif [ "$DELIVERED_bare" -ge 1 ] || [ "$DELIVERED_contract" -ge 1 ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
