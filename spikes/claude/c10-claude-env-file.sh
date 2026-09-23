#!/usr/bin/env bash
# M0 claim (design §5, leader token): a SessionStart hook that writes
# `export FLOWRYN_TOKEN=...` into $CLAUDE_ENV_FILE makes the token visible to the
# leader's later Bash tool calls.
#
# Method: the SessionStart probe appends an export line with a nonce to
# $CLAUDE_ENV_FILE. The pane itself carries no FLOWRYN_TOKEN. The model runs
# `echo TOKEN=$FLOWRYN_TOKEN`; the PostToolUse probe records the tool output.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c10-claude-env-file
lab_ensure
DIR=$(spike_workdir "$ID")
mkdir -p "$DIR/ctl"
NONCE="tok-$RANDOM$RANDOM"

cat > "$DIR/settings.json" <<EOF
{"permissions":{"allow":["Bash(echo *)"]},
 "hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$(probe_cmd "$DIR" post)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF
cat > "$DIR/ctl/ss.sh" <<EOF
if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
  echo "export FLOWRYN_TOKEN=$NONCE" >> "\$CLAUDE_ENV_FILE"
  echo "\$CLAUDE_ENV_FILE" > "$DIR/env-file-path"
fi
EOF

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
claude_send "$PANE" 'Run this exact Bash command and report its output: echo TOKEN=$FLOWRYN_TOKEN'
wait_events "$DIR" '.event == "Stop"' 1 90 || true
out=$(jq -rs '[.[] | select(.event == "PostToolUse")] | first | .input.tool_response | tostring' "$DIR/events.jsonl" 2>/dev/null)
envfile=$(cat "$DIR/env-file-path" 2>/dev/null)
claude_stop "$PANE"

if printf '%s' "$out" | grep -qF "TOKEN=$NONCE"; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "CLAUDE_ENV_FILE=${envfile:-<unset>}; Bash tool output: $(printf '%s' "$out" | cut -c1-160)"
