#!/usr/bin/env bash
# M0 claim (design §7 threat table, §14 "Validation gate boundary"): processes
# inside the no-mistakes gate carry no Flowryn token, because they do not
# inherit the pushing worker's environment.
#
# Method (read-only; never starts, stops or pushes to the shared daemon):
#  1. The gate's receive hooks: what they pass to the daemon (arguments over
#     its socket, or environment).
#  2. The daemon process: its parent (launchd or a shell), and the names of
#     the environment variables it runs with.
#  3. The launchd plist's EnvironmentVariables.
#  4. --watch <seconds>: while a pipeline run is active, scan every
#     descendant of the daemon for FLOWRYN_* / FM_* / HERDR_PANE_ID /
#     CLAUDE_CODE_SESSION_ID variables, which only a worker environment
#     would carry. Only variable names are read, never values.
set -u
. "$(dirname "$0")/../lib/lab.sh"
ID=n01-gate-env
NM=$(command -v no-mistakes) || { spike_verdict "$ID" "not run" "no-mistakes: not installed" "no-mistakes not installed"; exit 0; }
version="no-mistakes $("$NM" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9.]+' | head -n 1)"
WATCH=0
[ "${1:-}" = "--watch" ] && WATCH=${2:-600}

repo_root=$(git -C "$SPIKES_ROOT" rev-parse --show-toplevel)
gate=$(cd "$repo_root" && "$NM" status 2>/dev/null | awk '/gate:/ {print $2}')
hook_args="?"
if [ -n "$gate" ] && [ -f "$gate/hooks/post-receive" ]; then
  hook_args=$(grep -oE 'daemon (notify-push|admit-push)[^"]*' "$gate/hooks/post-receive" "$gate/hooks/pre-receive" 2>/dev/null | sed 's/.*daemon /daemon /' | sort -u | tr '\n' ';')
fi

pid=$("$NM" daemon status 2>/dev/null | grep -oE 'pid [0-9]+' | awk '{print $2}')
ppid=$(ps -o ppid= -p "${pid:-0}" 2>/dev/null | tr -d ' ')
names() { ps eww -p "$1" -o command= 2>/dev/null | tr ' ' '\n' | grep -oE '^[A-Z_][A-Z0-9_]*=' | tr -d '=' | sort -u | tr '\n' ' '; }
daemon_env=$(names "${pid:-0}")
plist=$(ls "$HOME"/Library/LaunchAgents/*no-mistakes*.plist 2>/dev/null | head -n 1)
plist_env="?"
[ -n "$plist" ] && plist_env=$(plutil -extract EnvironmentVariables json -o - "$plist" 2>/dev/null | jq -r 'keys | join(",")')

leaks=""
scanned=0
seen_pids=""
if [ "$WATCH" -gt 0 ] && [ -n "$pid" ]; then
  end=$(( $(date +%s) + WATCH ))
  while [ "$(date +%s)" -lt "$end" ]; do
    for p in $(pgrep -P "$pid"; for c in $(pgrep -P "$pid"); do pgrep -P "$c"; done); do
      # The daemon's permanent log-sink child is not a pipeline process.
      ps -o command= -p "$p" 2>/dev/null | grep -q 'daemon log-sink' && continue
      case " $seen_pids " in *" $p "*) continue ;; esac
      seen_pids="$seen_pids $p"
      scanned=$((scanned + 1))
      hit=$(names "$p" | tr ' ' '\n' | grep -E '^(FLOWRYN_|FM_|HERDR_PANE_ID|CLAUDE_CODE_SESSION_ID)' | tr '\n' ' ')
      [ -n "$hit" ] && leaks="$leaks pid $p: $hit;"
    done
    sleep 5
  done
fi

evidence="gate hooks call: ${hook_args}; daemon pid ${pid:-?} parent ${ppid:-?} ($( [ "$ppid" = 1 ] && echo launchd || echo not-launchd )); daemon env names: ${daemon_env:-?}; plist EnvironmentVariables: $plist_env; binary resolves a login-shell environment for agents and sets NO_MISTAKES_GATE=1 (strings: 'apply login shell environment', 'NO_MISTAKES_GATE=1'); watch: ${WATCH}s, ${scanned} distinct pipeline processes scanned, worker vars found: ${leaks:-none}"
if [ -n "$leaks" ]; then verdict=refuted
elif [ "$scanned" -gt 0 ] && [ "$ppid" = 1 ]; then verdict=confirmed
elif [ "$ppid" = 1 ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$version" "$evidence"
