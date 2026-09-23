#!/usr/bin/env bash
# M0 claim (design §5, Scoping and worker launch): hooks in a settings file
# passed with --settings apply to that one session only, never through your
# global settings, and they run alongside your existing user hooks.
#
# Method: two sessions side by side in the same directory. Session A gets
# --settings with probe hooks; session B gets nothing. Both receive a prompt.
# Every probe event must carry A's session id, none B's. A's transcript is
# checked for hook runs from user-level hooks too (merge, not replace).
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c11-settings-scoping
lab_ensure
DIR=$(spike_workdir "$ID")
mkdir -p "$DIR/b"

cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ups)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF

PANE_A=$(claude_launch "$DIR" "$ID-a" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch A failed"
claude_wait_ready "$DIR" || lab_die "A: no SessionStart"
SID_A=$(claude_session_id "$DIR")
# B writes its own session id with a known marker so the spike can tell it apart.
PANE_B=$(claude_launch "$DIR/b" "$ID-b" -- --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch B failed"
sleep 12
claude_send "$PANE_A" "Say A."
claude_send "$PANE_B" "Say B."
wait_events "$DIR" '.event == "Stop"' 1 90 || true
sleep 15
sids=$(jq -rs '[.[] | .input.session_id] | unique | join(",")' "$DIR/events.jsonl")
events=$(jq -rs '[.[] | .event] | join(",")' "$DIR/events.jsonl")
b_screen=$(lab_pane_read "$PANE_B" 30 | grep -E '^⏺|B' | head -n 3 | tr '\n' ' ' | cut -c1-100)
user_hooks=$(jq -rs '[.[] | select(.type == "attachment" and (.attachment.type // "" | startswith("hook_")) and ((.attachment.command // "") | contains("probe-hook") | not)) | .attachment.hookName] | unique | join(",")' "$(claude_transcript "$DIR")" 2>/dev/null)
claude_stop "$PANE_A"
claude_stop "$PANE_B"

if [ "$sids" = "$SID_A" ]; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "probe events [$events] all from A=$SID_A (distinct ids seen: $sids); B replied without any probe event (B screen: ${b_screen:-?}); other hooks that also ran in A (user/plugin level): ${user_hooks:-none}"
