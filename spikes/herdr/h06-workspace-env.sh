#!/usr/bin/env bash
# Claim (design §5 launch): workspace.create takes env and cwd for its root
# pane, so a worker workspace needs no split and holds exactly one pane.
#
# Method: create a lab workspace with --cwd and --env FLOWRYN_RUN=<run> and a
# blanked FLOWRYN_BLANK=, then have the root pane's shell print the run, the
# blank variable's set-ness and its working directory. The installed API
# schema is checked for env on WorkspaceCreateParams.
set -u
. "$(dirname "$0")/../lib/lab.sh"
ID=h06-workspace-env
lab_ensure
DIR=$(spike_workdir "$ID")
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')
RUN="run-$RANDOM$RANDOM"
schema=$(lab_herdr api schema --json)
create_env=$(printf '%s' "$schema" | jq -r '.schemas.request["$defs"].WorkspaceCreateParams.properties | has("env")')

out=$(lab_herdr workspace create --cwd "$DIR" --label "$ID" --no-focus --env "FLOWRYN_RUN=$RUN" --env "FLOWRYN_BLANK=") || lab_die "workspace create failed"
PANE=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // .result.pane.pane_id // empty')
[ -n "$PANE" ] || lab_die "no root pane in: $out"
WS=$(printf '%s' "$out" | jq -r '.result.workspace.workspace_id')
printf '%s\n' "$WS" >> "$SPIKES_RUNS/.workspaces.$$"
panes_json=$(lab_herdr pane list --workspace "$WS")
panes=$(printf '%s' "$panes_json" | jq '[.. | objects | select(has("pane_id"))] | unique_by(.pane_id) | length')

sleep 2
# The pane wraps long lines, so the shell compares its own cwd and prints a word.
REAL_DIR=$(cd "$DIR" && pwd -P)
lab_pane_run "$PANE" "printf 'probe:%s:%s:%s\\n' \"\$FLOWRYN_RUN\" \"\${FLOWRYN_BLANK+set}\" \"\$([ \"\$(pwd -P)\" = '$REAL_DIR' ] && echo cwd-ok || echo cwd-wrong)\""
wait_for 20 '[ -n "$(lab_pane_read "$PANE" | grep "^probe:run-")" ]' || true
line=$(lab_pane_read "$PANE" | grep "^probe:run-" | tail -1)

expected="probe:$RUN:set:cwd-ok"
evidence="schema: WorkspaceCreateParams.env=$create_env; panes in workspace: $panes; root pane printed: $line"
if [ "$create_env" = true ] && [ "$line" = "$expected" ] && [ "$panes" = 1 ]; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
