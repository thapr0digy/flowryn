# shellcheck shell=bash
# Shared plumbing for the M0 spikes: an isolated Herdr lab session, run output
# directories, and verdict recording.
#
# Source it from a spike script. Every Herdr call goes through lab_herdr, which
# delegates to Firstmate's fm-herdr-lab.sh helper; that helper appends
# --session <lab> and refuses server and session lifecycle operations.
#
# If FLOWRYN_LAB_SESSION is set (by spikes/lib/lab-hold.sh or run-all.sh), the
# spike reuses that session. Otherwise lab_ensure provisions a private session
# and installs an EXIT trap that tears it down through the helper.

SPIKES_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export SPIKES_ROOT
export SPIKES_RUNS="${SPIKES_RUNS:-$SPIKES_ROOT/.runs}"
export HERDR_LAB_HELPER="${HERDR_LAB_HELPER:-/Users/pr0digy/projects/firstmate/bin/fm-herdr-lab.sh}"
# Pin the helper's tripwire directory so sandboxed and unsandboxed shells agree.
export FM_HERDR_LAB_STATE_DIR="${FM_HERDR_LAB_STATE_DIR:-$SPIKES_RUNS/lab-state}"
mkdir -p "$SPIKES_RUNS/results" "$FM_HERDR_LAB_STATE_DIR"

lab_die() {
  echo "spike: $*" >&2
  exit 1
}

# The lab server's environment becomes every lab pane's environment. When the
# spikes are started from inside a Claude Code session or a Herdr pane, that
# environment carries the parent's CLAUDE_CODE_* session identity (including
# its messaging socket) and Herdr pane ids, which would contaminate every
# harness a spike launches. Drop them before provisioning.
lab_scrub_env() {
  local var
  for var in $(compgen -e); do
    case "$var" in
      CLAUDECODE|CLAUDE_*|HERDR_ENV|HERDR_PANE_ID|HERDR_TAB_ID|HERDR_WORKSPACE_ID|HERDR_SOCKET_PATH|FM_TASK_ID)
        unset "$var" ;;
    esac
  done
}

lab_ensure() {
  [ -x "$HERDR_LAB_HELPER" ] || lab_die "Herdr lab helper not found at $HERDR_LAB_HELPER"
  LAB_OWNED=no
  if [ -n "${FLOWRYN_LAB_SESSION:-}" ]; then
    HERDR_LAB_SESSION=$FLOWRYN_LAB_SESSION
  else
    lab_scrub_env
    HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name flowryn-m0)
    LAB_OWNED=yes
  fi
  trap lab_on_exit EXIT
  trap 'exit 130' INT TERM HUP
  if [ "$LAB_OWNED" = yes ]; then
    "$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION" || lab_die "lab provision failed"
  fi
  case "$HERDR_LAB_SESSION" in
    fm-lab-*) ;;
    *) lab_die "refusing non-lab session name: $HERDR_LAB_SESSION" ;;
  esac
  export HERDR_LAB_SESSION
}

# Workspaces this spike opened; closed on exit so harnesses never outlive it.
LAB_WORKSPACES=()

# EXIT handler: close this spike's workspaces (which ends any harness in them),
# then tear down the lab session if this process provisioned it.
lab_on_exit() {
  local ws
  if [ -f "$SPIKES_RUNS/.workspaces.$$" ]; then
    while IFS= read -r ws; do LAB_WORKSPACES+=("$ws"); done < "$SPIKES_RUNS/.workspaces.$$"
    rm -f "$SPIKES_RUNS/.workspaces.$$"
  fi
  for ws in "${LAB_WORKSPACES[@]}"; do
    lab_herdr workspace close "$ws" >/dev/null 2>&1 || true
  done
  if [ "${LAB_OWNED:-no}" = yes ]; then
    "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION"
  fi
}

lab_herdr() {
  "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"
}

# Socket path of the lab session, refusing the default session's socket.
lab_socket_path() {
  local sessions path default_path
  sessions=$(lab_herdr session list --json) || return 1
  path=$(printf '%s' "$sessions" | jq -r --arg n "$HERDR_LAB_SESSION" \
    '.sessions[] | select(.name == $n and .default == false) | .socket_path')
  default_path=$(printf '%s' "$sessions" | jq -r '.sessions[] | select(.default == true) | .socket_path')
  [ -n "$path" ] && [ "$path" != "null" ] && [ "$path" != "$default_path" ] || {
    echo "spike: cannot resolve a non-default socket for $HERDR_LAB_SESSION" >&2
    return 1
  }
  printf '%s\n' "$path"
}

# Creates a fresh workspace in the lab and prints its root pane id. Callers
# that run it in a command substitution lose the LAB_WORKSPACES update, so the
# workspace id is also appended to a per-process file read back on exit.
lab_new_pane() { # <cwd> <label>
  local out
  out=$(lab_herdr workspace create --cwd "$1" --label "$2" --no-focus) || return 1
  printf '%s\n' "$(printf '%s' "$out" | jq -r '.result.workspace.workspace_id')" >> "$SPIKES_RUNS/.workspaces.$$"
  printf '%s' "$out" | jq -r '.result.root_pane.pane_id // .result.pane.pane_id // .result.pane_id // empty'
}

lab_pane_run() { # <pane> <command>
  lab_herdr pane run "$1" "$2" >/dev/null
}

lab_pane_read() { # <pane> [lines]
  lab_herdr pane read "$1" --source recent --lines "${2:-60}"
}

lab_pane_close() { # <pane>
  lab_herdr pane close "$1" >/dev/null 2>&1 || true
}

# Per-spike scratch directory under spikes/.runs.
spike_workdir() { # <spike-id>
  local dir="$SPIKES_RUNS/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

# Records a verdict line and a JSON result for docs/m0-verdicts.md.
spike_verdict() { # <spike-id> <verdict> <tool-version> <evidence>
  local id=$1 verdict=$2 version=$3 evidence=$4
  jq -n --arg id "$id" --arg verdict "$verdict" --arg version "$version" \
    --arg evidence "$evidence" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, verdict: $verdict, version: $version, evidence: $evidence, at: $at}' \
    > "$SPIKES_RUNS/results/$id.json"
  printf 'VERDICT %s: %s (%s)\n  %s\n' "$id" "$verdict" "$version" "$evidence"
}

# Polls a shell condition (a string, re-evaluated on every poll) until it holds
# or the timeout (seconds) passes.
wait_for() { # <timeout-s> <condition-string>
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    eval "$2" && return 0
    sleep 1
  done
  return 1
}

# Polls a command until it succeeds or the timeout (seconds) passes. Arguments
# are expanded once by the caller, so use wait_for for "$(...)" conditions.
wait_until() { # <timeout-s> <command...>
  local deadline=$(( $(date +%s) + $1 ))
  shift
  while [ "$(date +%s)" -lt "$deadline" ]; do
    "$@" && return 0
    sleep 1
  done
  return 1
}
