#!/usr/bin/env bash
# M0 claim (design §6 startup step 5, §17 Herdr item): the session snapshot
# exposes `revision` and `state_change_seq` for agents, so the reconciler can
# apply only buffered events newer than its snapshot. (agent_session is
# h05-agent-session.)
#
# Method: start Claude in a lab pane, read `herdr api snapshot`, then drive one
# turn and poll `agent get` to see whether revision and state_change_seq move
# with the agent's state. At the same time, an events.subscribe stream on the
# lab socket (resolved and checked to be non-default) records whether
# pane.agent_status_changed / pane.updated events carry revision or
# state_change_seq, which the reconciler needs to drop buffered events older
# than its snapshot.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=h01-snapshot-fields
lab_ensure
DIR=$(spike_workdir "$ID")
cat > "$DIR/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ss)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" stop)"}]}]
}}
EOF
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')
proto=$(lab_herdr status --json | jq -r '.server.protocol // .protocol // "?"')

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"
snap=$(lab_herdr api snapshot)
printf '%s\n' "$snap" > "$DIR/snapshot-1.json"
agent_keys=$(printf '%s' "$snap" | jq -r --arg p "$PANE" '(.result.snapshot // .result // .) | .agents[] | select(.pane_id == $p) | keys | join(",")')
pane_keys=$(printf '%s' "$snap" | jq -r --arg p "$PANE" '(.result.snapshot // .result // .) | .panes[] | select(.pane_id == $p) | keys | join(",")')
top_keys=$(printf '%s' "$snap" | jq -r '(.result.snapshot // .result // .) | keys | join(",")')

SOCK=$(lab_socket_path) || lab_die "no lab socket"
SUBREQ=$(jq -cn --arg p "$PANE" '{id: "sub1", method: "events.subscribe", params: {subscriptions: [{type: "pane.agent_status_changed", pane_id: $p}, {type: "pane.updated"}]}}')
( printf '%s\n' "$SUBREQ"; sleep 45 ) | nc -U "$SOCK" > "$DIR/events-stream.jsonl" 2>/dev/null &
SUB=$!
sleep 1
agent_state() { lab_herdr agent get "$PANE" | jq -c '.result.agent | {agent_status, revision, state_change_seq, agent_session}'; }
s0=$(agent_state)
claude_send "$PANE" "Count from 1 to 40, one number per line."
seen="$s0"
for _ in $(seq 1 40); do
  s=$(agent_state)
  [ "$s" != "$(printf '%s' "$seen" | tail -n 1)" ] && seen="$seen
$s"
  [ "$(events_count "$DIR" '.event == "Stop"')" -ge 1 ] && break
  sleep 0.5
done
sleep 3
seen="$seen
$(agent_state)"
claude_stop "$PANE"
kill "$SUB" 2>/dev/null
wait "$SUB" 2>/dev/null
ev_kinds=$(jq -rs '[.[] | .event // .result.type // empty] | group_by(.) | map("\(.[0])x\(length)") | join(",")' "$DIR/events-stream.jsonl" 2>/dev/null)
ev_seq=$(jq -rs '[.[] | select(.event == "pane.agent_status_changed") | .data | keys[]] | unique | join(",")' "$DIR/events-stream.jsonl" 2>/dev/null)
ev_has_seq=no
jq -e -s 'any(.[]; (.event // "") == "pane.agent_status_changed" and ((.data | tostring) | test("state_change_seq|revision")))' "$DIR/events-stream.jsonl" >/dev/null 2>&1 && ev_has_seq=yes
upd_rev=no
jq -e -s --arg p "$PANE" 'any(.[]; (.event // "") == "pane_updated" and .data.pane.pane_id == $p and (.data.pane | has("revision")))' "$DIR/events-stream.jsonl" >/dev/null 2>&1 && upd_rev=yes

has_rev=no; has_seq=no; seq_moved=no
printf '%s' "$agent_keys" | grep -q 'revision' && has_rev=yes
printf '%s' "$agent_keys" | grep -q 'state_change_seq' && has_seq=yes
[ "$(printf '%s\n' "$seen" | jq -s 'map(.state_change_seq) | unique | length')" -gt 1 ] && seq_moved=yes
transitions=$(printf '%s\n' "$seen" | jq -rs 'map("\(.agent_status)/r\(.revision)/s\(.state_change_seq)") | join(" -> ")')
evidence="protocol $proto; snapshot top-level keys [$top_keys] (no snapshot-wide revision); agent keys [$agent_keys]; pane keys [$pane_keys]; revision=$has_rev state_change_seq=$has_seq; transitions: $transitions; subscription events seen [$ev_kinds]; pane.agent_status_changed data keys [$ev_seq]; carries revision/state_change_seq=$ev_has_seq; pane_updated carries pane revision=$upd_rev"
if [ "$has_rev" = yes ] && [ "$has_seq" = yes ] && [ "$seq_moved" = yes ] && [ "$ev_has_seq" = yes ]; then verdict=confirmed
elif [ "$has_rev" = yes ] && [ "$has_seq" = yes ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
