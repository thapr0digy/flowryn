#!/usr/bin/env bash
# M0 claim (design §5 launch, §12 identity): env passed on pane.split
# (FLOWRYN_RUN, FLOWRYN_TOKEN, ...) reaches the harness launched in that pane
# and its hooks, while AgentStartParams has no env field.
#
# Method: split a lab pane with --env FLOWRYN_RUN/FLOWRYN_TOKEN/FLOWRYN_BIN,
# start Claude in it, and read the env the SessionStart and Stop hooks see.
# The installed API schema is checked for env on PaneSplitParams and its
# absence on AgentStartParams.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=h04-split-env
lab_ensure
DIR=$(spike_workdir "$ID")
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')
RUN="run-$RANDOM$RANDOM"
TOKEN="tok-$RANDOM$RANDOM"
cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF
schema=$(lab_herdr api schema --json)
split_env=$(printf '%s' "$schema" | jq -r '.schemas.request["$defs"].PaneSplitParams.properties | has("env")')
start_env=$(printf '%s' "$schema" | jq -r '.schemas.request["$defs"].AgentStartParams.properties | has("env")')

PANE=$(claude_launch "$DIR" "$ID" "FLOWRYN_RUN=$RUN" "FLOWRYN_TOKEN=$TOKEN" "FLOWRYN_BIN=/usr/bin/true" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
claude_send "$PANE" "Say ok."
wait_events "$DIR" '.event == "Stop"' 1 60 || true
seen=$(jq -rs '[.[] | "\(.event):\(.env.FLOWRYN_RUN)/\(.env.FLOWRYN_TOKEN)"] | join(" ")' "$DIR/events.jsonl")
claude_stop "$PANE"

ok=yes
for ev in SessionStart Stop; do
  [ "$(events_count "$DIR" ".event == \"$ev\" and .env.FLOWRYN_RUN == \"$RUN\" and .env.FLOWRYN_TOKEN == \"$TOKEN\"")" -ge 1 ] || ok=no
done
evidence="schema: PaneSplitParams.env=$split_env, AgentStartParams.env=$start_env; hook env seen: $seen"
if [ "$ok" = yes ] && [ "$split_env" = true ]; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
