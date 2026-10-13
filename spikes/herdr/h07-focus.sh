#!/usr/bin/env bash
# Claim (Flowryn launch and cleanup keep the user's focus): a worker launch
# (workspace.create with focus:false, then agent.start in its root pane) leaves
# the focused workspace and pane where they were; workspace.close of an
# unfocused workspace moves focus to the workspace that takes the closed one's
# slot in the list (the new list's [min(index, length - 1)]), whatever was
# focused; workspace.focus puts it back, with that workspace's own focused pane;
# pane.close of a workspace's last pane closes the workspace the same way.
#
# Method: in the lab, open workspaces a, leader (split, its second pane
# focused), then launch a worker the way the launcher does (stand-in pi on
# PATH) and read workspace.list and the snapshot's focused pane after each
# step. Then open two more workers, close the one right after the leader,
# focus the leader back, and pane.close the last worker's only pane.
set -u
. "$(dirname "$0")/../lib/lab.sh"
ID=h07-focus
lab_ensure
DIR=$(spike_workdir "$ID")
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')
focus_default=$(lab_herdr api schema --json | jq -r '.schemas.request["$defs"].WorkspaceCreateParams.properties.focus.default')

# A stand-in pi: a process named pi that waits at a prompt.
mkdir -p "$DIR/bin"
cat > "$DIR/bin/pi" <<'PI'
#!/bin/sh
printf 'pi stand-in ready\n> '
exec cat >/dev/null
PI
chmod +x "$DIR/bin/pi"

# <focused workspace>/<focused pane>, from workspace.list and the snapshot.
focused() {
  local ws pane
  ws=$(lab_herdr workspace list | jq -r '[.result.workspaces[] | select(.focused) | .workspace_id] | join(",")')
  pane=$(lab_herdr api snapshot | jq -r '.result.snapshot // .result | [.panes[] | select(.focused) | .pane_id] | join(",")')
  printf '%s/%s' "${ws:-none}" "${pane:-none}"
}
mk() { # <label> [create flags...]
  local out label=$1
  shift
  out=$(lab_herdr workspace create --cwd "$DIR" --label "$label" "$@") || lab_die "workspace create $label failed"
  printf '%s' "$out" | jq -r '.result.workspace.workspace_id' | tee -a "$SPIKES_RUNS/.workspaces.$$"
}
root_pane() { lab_herdr api snapshot | jq -r --arg w "$1" '.result.snapshot // .result | [.panes[] | select(.workspace_id == $w) | .pane_id] | first'; }

A=$(mk a --no-focus)
L=$(mk leader --focus)
lab_herdr pane split "$(root_pane "$L")" --direction right --focus >/dev/null || lab_die "split failed"
lab_herdr workspace focus "$L" >/dev/null
before=$(focused)

W1=$(mk w1 --no-focus --env "PATH=$DIR/bin:$PATH")
after_create=$(focused)
sleep 2
start=$(lab_herdr agent start "h07-$RANDOM" --kind pi --pane "$(root_pane "$W1")" --timeout 10000 2>&1 | jq -r '.result.agent.agent_status // .error.code' 2>/dev/null)
after_start=$(focused)

W2=$(mk w2 --no-focus)
W3=$(mk w3 --no-focus)
order=$(lab_herdr workspace list | jq -r '[.result.workspaces[].workspace_id] | join(",")')
lab_herdr workspace close "$W1" >/dev/null
after_close=$(focused)
lab_herdr workspace focus "$L" >/dev/null
after_refocus=$(focused)
lab_herdr pane close "$(root_pane "$W3")" >/dev/null
w3_left=$(lab_herdr workspace list | jq -r --arg w "$W3" '[.result.workspaces[] | select(.workspace_id == $w)] | length')
after_pane_close=$(focused)

evidence="schema focus default=$focus_default; a=$A leader=$L w1=$W1 w2=$W2 w3=$W3; order before close: $order; focused before=$before, after create=$after_create, after agent.start ($start)=$after_start, after close w1=$after_close, after workspace.focus leader=$after_refocus, after pane.close of w3's only pane (w3 workspaces left: $w3_left)=$after_pane_close"
leader_ws=${before%%/*}
if [ "$after_create" = "$before" ] && [ "$after_start" = "$before" ] && [ "$start" = idle ] \
  && [ "${after_close%%/*}" = "$W2" ] && [ "$after_refocus" = "$before" ] \
  && [ "$w3_left" = 0 ] && [ "${after_pane_close%%/*}" = "$W2" ] && [ "$leader_ws" = "$L" ]; then
  verdict=confirmed
else
  verdict=refuted
fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
