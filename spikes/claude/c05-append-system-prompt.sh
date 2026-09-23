#!/usr/bin/env bash
# M0 claim (design §11, §17): `flowryn lead` can append the terse style block to
# the leader's system prompt with Claude Code's --append-system-prompt, in an
# interactive session inside a Herdr pane.
#
# Method: launch an interactive session with --append-system-prompt carrying a
# nonce instruction, ask for the token, and look for the nonce in the reply.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c05-append-system-prompt
lab_ensure
DIR=$(spike_workdir "$ID")
NONCE="STYLE-$RANDOM$RANDOM"

cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF
STYLE="Reply in the fewest words that carry the outcome. When asked for the style token, answer exactly $NONCE and nothing else."

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL" --append-system-prompt "$STYLE") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
claude_send "$PANE" "What is the style token?"
wait_events "$DIR" '.event == "Stop"' 1 90 || lab_die "turn never ended"
reply=$(claude_last_text "$DIR")
claude_stop "$PANE"

if printf '%s' "$reply" | grep -qF "$NONCE"; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "interactive session in a Herdr pane; reply: $(printf '%s' "$reply" | cut -c1-120)"
