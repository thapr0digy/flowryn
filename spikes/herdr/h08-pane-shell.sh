#!/usr/bin/env bash
# Claim (design §5 launch; docs/notes/2026-10-17-workers-launch-reliably-5a.md):
# a startup prompt in the user's shell rc eats the first character of the
# command agent.start types, so the harness never starts; naming Flowryn's pane
# shell as SHELL in workspace.create's env makes Herdr start the pane with it,
# no rc file runs, and the same agent.start brings the harness up with the
# user's login shell back in SHELL.
#
# Method: a ZDOTDIR whose .zshrc asks "Would you like to update? [Y/n]" and
# reads one key (oh-my-zsh's update prompt), and a stand-in pi on PATH that
# prints $SHELL and waits. Workspace A gets that ZDOTDIR and the server's own
# zsh; workspace B gets the same ZDOTDIR and SHELL=<Flowryn's pane shell>.
# agent.start pi in each, then read each pane's foreground process and text.
set -u
. "$(dirname "$0")/../lib/lab.sh"
ID=h08-pane-shell
lab_ensure
DIR=$(spike_workdir "$ID")
REPO=$(cd "$SPIKES_ROOT/.." && pwd)
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')

mkdir -p "$DIR/bin" "$DIR/zdot"
cat > "$DIR/bin/pi" <<'PI'
#!/bin/sh
printf 'pi stand-in ready, SHELL=%s\n> ' "$SHELL"
exec cat >/dev/null
PI
chmod +x "$DIR/bin/pi"
cat > "$DIR/zdot/.zshrc" <<'RC'
printf '[h08] Would you like to update? [Y/n] '
read -k 1 _answer
echo
RC
H08_REPO=$REPO H08_DIR=$DIR bun -e 'const m = await import(`${process.env.H08_REPO}/src/lifecycle/pane-shell.ts`); m.ensurePaneShell(process.env.H08_DIR, "/bin/zsh");' \
  || lab_die "could not write the pane shell"

mk() { # <label> [create flags...]
  local out label=$1
  shift
  out=$(lab_herdr workspace create --cwd "$DIR" --label "$label" --no-focus --env "PATH=$DIR/bin:$PATH" --env "ZDOTDIR=$DIR/zdot" "$@") || lab_die "workspace create $label failed"
  printf '%s' "$out" | jq -r '.result.workspace.workspace_id' >> "$SPIKES_RUNS/.workspaces.$$"
  printf '%s' "$out" | jq -r '.result.root_pane.pane_id'
}
foreground() { lab_herdr pane process-info --pane "$1" | jq -r '.result.process_info as $i | [$i.foreground_processes[]? | select(.pid == $i.foreground_process_group_id) | .name] | first // "none"'; }
screen() { lab_herdr pane read "$1" --source visible --lines 20 | tr '\n' ' ' | tr -s ' '; }

A=$(mk h08-user-shell)
B=$(mk h08-pane-shell --env "SHELL=$DIR/pane-shell")
sleep 2
lab_herdr agent start "h08a-$RANDOM" --kind pi --pane "$A" --timeout 8000 >/dev/null 2>&1
lab_herdr agent start "h08b-$RANDOM" --kind pi --pane "$B" --timeout 8000 >/dev/null 2>&1
sleep 3
fg_a=$(foreground "$A")
fg_b=$(foreground "$B")
text_a=$(screen "$A")
text_b=$(screen "$B")

evidence="user zsh pane $A: foreground ${fg_a}, screen: ${text_a:0:300}; Flowryn pane shell $B: foreground ${fg_b}, screen: ${text_b:0:300}"
if [ "$fg_a" != cat ] && [ "$fg_b" = cat ] && printf '%s' "$text_b" | grep -q 'SHELL=/bin/zsh'; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
