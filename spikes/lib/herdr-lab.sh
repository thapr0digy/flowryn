#!/usr/bin/env bash
# Provision and operate an isolated Herdr lab session without risking the live
# default session.
#
# Usage:
#   herdr-lab.sh name <label>
#   herdr-lab.sh prepare <session>
#   herdr-lab.sh provision <session>
#   herdr-lab.sh run <session> <herdr arguments...>
#   herdr-lab.sh stop <session>
#   herdr-lab.sh teardown <session>
#
# Session names must begin with "fl-lab-" and can never be "default".
# The name command sanitizes the label, caps it at 16 characters, and appends
# process/random suffixes to keep generated socket paths short.
# Every Herdr call made here carries a trailing --session <session>.
# The run command rejects caller-supplied --session flags, any leading option
# before the subcommand, all session lifecycle operations, and every server
# operation.
# Session stop is available only through guarded stop or teardown, and session
# delete is available only through teardown.
# Both paths perform a fresh refuse-default check immediately before each
# destructive call.
# Provision records the running default session as a fleet-state tripwire and
# teardown requires that record to be identical afterward.
#
# Vendored from the previous orchestrator's lab helper (its viewer command,
# which Flowryn never used, left out), under this license:
#
# MIT License
#
# Copyright (c) 2026 Kun Chen
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
set -u

herdr_lab_error() {
  echo "herdr-lab: $*" >&2
}

herdr_lab_validate_name() { # <session>
  local name=${1:-}
  [[ "$name" =~ ^fl-lab-[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] && return 0
  case "$name" in
    default) herdr_lab_error "refusing session name 'default'" ;;
    '') herdr_lab_error "refusing an empty session name" ;;
    *) herdr_lab_error "session name must start with 'fl-lab-' and contain only letters, digits, underscores, or dashes: $name" ;;
  esac
  return 1
}

herdr_lab_state_dir() {
  printf '%s' "${HERDR_LAB_STATE_DIR:-${TMPDIR:-/tmp}/flowryn-herdr-lab-${UID}}"
}

herdr_lab_tripwire_path() { # <session>
  printf '%s/%s.fleet-state.json' "$(herdr_lab_state_dir)" "$1"
}

herdr_lab_raw() { # <session> <herdr arguments...>
  local name=$1
  shift
  HERDR_SESSION="$name" herdr "$@" --session "$name"
}

herdr_lab_session_list() { # <session>
  herdr_lab_raw "$1" session list --json
}

herdr_lab_fleet_state() { # <session>
  local name=$1 sessions snapshot
  sessions=$(herdr_lab_session_list "$name" 2>/dev/null) || {
    herdr_lab_error "cannot read Herdr sessions for the fleet-state tripwire"
    return 1
  }
  snapshot=$(printf '%s' "$sessions" | jq -c '
    [.sessions[]? | select(.default == true)]
    | if length == 1 and .[0].name == "default" and .[0].running == true
      then .[0] | {name, default, running, socket_path}
      else empty
      end
  ' 2>/dev/null)
  [ -n "$snapshot" ] || {
    herdr_lab_error "fleet-state tripwire requires exactly one running default session"
    return 1
  }
  printf '%s\n' "$snapshot"
}

herdr_lab_prepare() { # <session>
  local name=$1 sessions state_dir tripwire
  herdr_lab_validate_name "$name" || return 1
  command -v herdr >/dev/null 2>&1 || { herdr_lab_error "herdr is required"; return 1; }
  command -v jq >/dev/null 2>&1 || { herdr_lab_error "jq is required"; return 1; }

  sessions=$(herdr_lab_session_list "$name" 2>/dev/null) || {
    herdr_lab_error "cannot list Herdr sessions before provisioning '$name'"
    return 1
  }
  if printf '%s' "$sessions" | jq -e --arg name "$name" '.sessions[]? | select(.name == $name)' >/dev/null 2>&1; then
    herdr_lab_error "session '$name' already exists; refusing to adopt or overwrite it"
    return 1
  fi

  state_dir=$(herdr_lab_state_dir)
  tripwire=$(herdr_lab_tripwire_path "$name")
  mkdir -p "$state_dir" || return 1
  [ ! -e "$tripwire" ] || {
    herdr_lab_error "tripwire already exists for '$name'; refusing ambiguous ownership"
    return 1
  }
  herdr_lab_fleet_state "$name" > "$tripwire" || {
    rm -f "$tripwire"
    return 1
  }
}

herdr_lab_refuse_if_default() { # <session>
  local name=$1 info flag
  herdr_lab_validate_name "$name" || return 1
  info=$(herdr_lab_session_list "$name" 2>/dev/null) || {
    herdr_lab_error "refusing destructive call because session list failed"
    return 1
  }
  flag=$(printf '%s' "$info" | jq -r --arg name "$name" \
    '.sessions[]? | select(.name == $name) | .default' 2>/dev/null)
  [ "$flag" = false ] && return 0
  herdr_lab_error "refusing destructive call for '$name': session is absent or default (default=${flag:-<not found>})"
  return 1
}

herdr_lab_cli() { # <session> <herdr arguments...>
  local name=$1 arg
  shift
  herdr_lab_validate_name "$name" || return 1
  [ "$#" -gt 0 ] || { herdr_lab_error "run requires Herdr arguments"; return 1; }
  case "$1" in
    -*)
      herdr_lab_error "run forbids a leading option before the Herdr subcommand; it could shift a server or session lifecycle operation past the guard or subvert session isolation"
      return 1
      ;;
  esac
  for arg in "$@"; do
    case "$arg" in
      --session|--session=*)
        herdr_lab_error "run forbids caller-supplied --session; the helper appends the lab session"
        return 1
        ;;
    esac
  done
  case "$1 ${2:-}" in
    "server "*)
      herdr_lab_error "run forbids server operations; use provision for the named lab server"
      return 1
      ;;
    "session list") ;;
    "session "*)
      herdr_lab_error "run forbids session lifecycle operations; use guarded teardown"
      return 1
      ;;
  esac
  herdr_lab_raw "$name" "$@"
}

herdr_lab_cancel_provision() { # <pid>
  local pid=$1 attempt=0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 10 ]; do
      sleep 0.1
      attempt=$((attempt + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
}

herdr_lab_provision() { # <session>
  local name=$1 sessions tripwire running attempt server_pid max_attempts timeout_seconds
  herdr_lab_validate_name "$name" || return 1
  command -v herdr >/dev/null 2>&1 || { herdr_lab_error "herdr is required"; return 1; }
  command -v jq >/dev/null 2>&1 || { herdr_lab_error "jq is required"; return 1; }

  sessions=$(herdr_lab_session_list "$name" 2>/dev/null) || {
    herdr_lab_error "cannot list Herdr sessions before provisioning '$name'"
    return 1
  }
  if printf '%s' "$sessions" | jq -e --arg name "$name" '.sessions[]? | select(.name == $name)' >/dev/null 2>&1; then
    tripwire=$(herdr_lab_tripwire_path "$name")
    [ -f "$tripwire" ] || {
      herdr_lab_error "missing fleet-state tripwire for existing session '$name'; refusing to adopt it"
      return 1
    }
    herdr_lab_refuse_if_default "$name" || return 1
    running=$(printf '%s' "$sessions" | jq -r --arg name "$name" \
      '.sessions[]? | select(.name == $name) | .running' 2>/dev/null)
    [ "$running" = false ] || {
      herdr_lab_error "session '$name' is not stopped; refusing to re-provision it"
      return 1
    }
    herdr_lab_check_tripwire "$name" || return 1
  else
    herdr_lab_prepare "$name" || return 1
  fi
  herdr_lab_raw "$name" server >/dev/null 2>&1 &
  server_pid=$!
  attempt=0
  max_attempts=300
  timeout_seconds=60
  while [ "$attempt" -lt "$max_attempts" ]; do
    running=$(herdr_lab_cli "$name" status --json 2>/dev/null | jq -r '.server.running // false' 2>/dev/null) || running=false
    if [ "$running" = true ]; then
      herdr_lab_refuse_if_default "$name" || {
        herdr_lab_cancel_provision "$server_pid"
        return 1
      }
      return 0
    fi
    sleep 0.2
    attempt=$((attempt + 1))
  done
  herdr_lab_cancel_provision "$server_pid"
  herdr_lab_error "lab session '$name' did not report running within $timeout_seconds seconds"
  return 1
}

herdr_lab_check_tripwire() { # <session>
  local name=$1 tripwire before after
  tripwire=$(herdr_lab_tripwire_path "$name")
  [ -f "$tripwire" ] || {
    herdr_lab_error "missing fleet-state tripwire for '$name'; refusing unverified teardown"
    return 1
  }
  before=$(cat "$tripwire")
  after=$(herdr_lab_fleet_state "$name") || return 1
  [ "$before" = "$after" ] || {
    herdr_lab_error "FLEET-STATE TRIPWIRE FAILED: default session changed during lab work"
    herdr_lab_error "before: $before"
    herdr_lab_error "after:  $after"
    return 1
  }
}

herdr_lab_verify_tripwire() { # <session>
  local name=$1 tripwire
  herdr_lab_check_tripwire "$name" || return 1
  tripwire=$(herdr_lab_tripwire_path "$name")
  rm -f "$tripwire"
}

herdr_lab_stop() { # <session>
  local name=$1 tripwire
  herdr_lab_validate_name "$name" || return 1
  tripwire=$(herdr_lab_tripwire_path "$name")
  [ -f "$tripwire" ] || {
    herdr_lab_error "missing fleet-state tripwire for '$name'; refusing stop"
    return 1
  }
  herdr_lab_refuse_if_default "$name" || return 1
  herdr_lab_raw "$name" session stop "$name" --json
}

herdr_lab_teardown() { # <session>
  local name=$1 tripwire sessions delete_status=0
  herdr_lab_validate_name "$name" || return 1
  tripwire=$(herdr_lab_tripwire_path "$name")
  [ -f "$tripwire" ] || {
    herdr_lab_error "missing fleet-state tripwire for '$name'; refusing destructive calls"
    return 1
  }
  sessions=$(herdr_lab_session_list "$name" 2>/dev/null) || {
    herdr_lab_error "cannot list Herdr sessions before teardown"
    return 1
  }
  if ! printf '%s' "$sessions" | jq -e --arg name "$name" '.sessions[]? | select(.name == $name)' >/dev/null 2>&1; then
    herdr_lab_verify_tripwire "$name"
    return
  fi
  herdr_lab_stop "$name" >/dev/null 2>&1 || true
  sleep 0.5
  herdr_lab_refuse_if_default "$name" || return 1
  herdr_lab_raw "$name" session delete "$name" --json >/dev/null 2>&1 || delete_status=$?
  sessions=$(herdr_lab_session_list "$name" 2>/dev/null) || {
    herdr_lab_error "cannot confirm removal of lab session '$name' after teardown"
    return 1
  }
  if printf '%s' "$sessions" | jq -e --arg name "$name" '.sessions[]? | select(.name == $name)' >/dev/null 2>&1; then
    if [ "$delete_status" -ne 0 ]; then
      herdr_lab_error "session delete failed for '$name' and the lab session remains"
    else
      herdr_lab_error "lab session '$name' remains after teardown"
    fi
    return 1
  fi
  herdr_lab_verify_tripwire "$name"
}

herdr_lab_name() { # <label>
  local label=${1:-lab}
  label=$(printf '%s' "$label" | tr -cd 'a-zA-Z0-9_-' | sed 's/^[^a-zA-Z0-9]*//; s/-*$//')
  [ -n "$label" ] || label=lab
  label=${label:0:16}
  label=${label%-}
  [ -n "$label" ] || label=lab
  printf 'fl-lab-%s-%s-%s\n' "$label" "$$" "$RANDOM"
}

herdr_lab_usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

herdr_lab_main() {
  local command=${1:-}
  case "$command" in
    name)
      [ "$#" -eq 2 ] || { herdr_lab_usage >&2; return 2; }
      herdr_lab_name "$2"
      ;;
    prepare)
      [ "$#" -eq 2 ] || { herdr_lab_usage >&2; return 2; }
      herdr_lab_prepare "$2"
      ;;
    provision)
      [ "$#" -eq 2 ] || { herdr_lab_usage >&2; return 2; }
      herdr_lab_provision "$2"
      ;;
    run)
      [ "$#" -ge 3 ] || { herdr_lab_usage >&2; return 2; }
      shift
      herdr_lab_cli "$@"
      ;;
    stop)
      [ "$#" -eq 2 ] || { herdr_lab_usage >&2; return 2; }
      herdr_lab_stop "$2"
      ;;
    teardown)
      [ "$#" -eq 2 ] || { herdr_lab_usage >&2; return 2; }
      herdr_lab_teardown "$2"
      ;;
    -h|--help|help)
      herdr_lab_usage
      ;;
    *)
      herdr_lab_usage >&2
      return 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -e
  herdr_lab_main "$@"
fi
