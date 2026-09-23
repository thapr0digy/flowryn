# shellcheck shell=bash
# Helpers for the Claude Code spikes. Source after lab.sh and call lab_ensure
# first. Each spike gets its own lab workspace, a per-spike settings file passed
# with --settings, and a probe log at <dir>/events.jsonl (see probe-hook.sh).

CLAUDE_SPIKE_MODEL="${CLAUDE_SPIKE_MODEL:-haiku}"
CLAUDE_SPIKE_CWD=$(git -C "$SPIKES_ROOT" rev-parse --show-toplevel)
PROBE="$SPIKES_ROOT/lib/probe-hook.sh"

claude_version() {
  claude --version 2>/dev/null | awk '{print "Claude Code " $1}'
}

# Hook command string for settings files.
probe_cmd() { # <dir> <label>
  printf '%s %s %s' "$PROBE" "$1" "$2"
}

# Opens a workspace for the spike, splits a pane carrying the given env
# (the pane.split env path the design relies on), writes a launcher, and
# starts claude in that pane. Prints the pane id.
#   claude_launch <dir> <name> [KEY=VALUE ...] -- <claude args...>
claude_launch() {
  local dir=$1 name=$2 root out pane
  shift 2
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    envs+=(--env "$1")
    shift
  done
  [ "${1:-}" = "--" ] && shift
  root=$(lab_new_pane "$dir" "$name") || return 1
  out=$(lab_herdr pane split "$root" --direction right --cwd "$dir" "${envs[@]}" --no-focus) || return 1
  pane=$(printf '%s' "$out" | jq -r '.result.pane.pane_id')
  {
    echo '#!/usr/bin/env bash'
    # Claude runs from the repo root, not from <dir>. From a subdirectory,
    # the repo's CLAUDE.md import of AGENTS.md counts as external, and Claude
    # stops at the "Allow external CLAUDE.md file imports?" dialog (one of the
    # wedge dialogs in design section 5); approving it would mean editing
    # ~/.claude.json. --setting-sources user keeps the worktree's own
    # .claude/settings.local.json (the supervisor's hooks for this task) out
    # of every spike session; the spike's --settings file still applies.
    printf 'cd %q || exit 1\n' "$CLAUDE_SPIKE_CWD"
    # A spike can shadow commands (for example a fake flowryn) in <dir>/bin.
    [ -d "$dir/bin" ] && printf 'export PATH=%q:"$PATH"\n' "$dir/bin"
    printf 'exec claude --setting-sources user'
    printf ' %q' "$@"
    printf '\n'
  } > "$dir/launch.sh"
  chmod +x "$dir/launch.sh"
  lab_pane_run "$pane" "$dir/launch.sh" || return 1
  printf '%s\n' "$pane"
}

# Types a prompt into the composer and submits it.
claude_send() { # <pane> <text>
  lab_herdr pane send-text "$1" "$2" >/dev/null || return 1
  sleep 0.5
  lab_herdr pane send-keys "$1" Enter >/dev/null
}

claude_keys() { # <pane> <key...>
  lab_herdr pane send-keys "$@" >/dev/null
}

# Counts probe events matching a jq boolean filter.
events_count() { # <dir> <jq-filter>
  [ -f "$1/events.jsonl" ] || { echo 0; return; }
  jq -s "[.[] | select($2)] | length" "$1/events.jsonl"
}

# Waits until at least <n> events match the filter.
wait_events() { # <dir> <jq-filter> <n> <timeout-s>
  local dir=$1 filter=$2 n=$3
  wait_until "$4" _events_at_least "$dir" "$filter" "$n"
}
_events_at_least() {
  [ "$(events_count "$1" "$2")" -ge "$3" ]
}

# Waits for the session's SessionStart probe, then gives the TUI a moment.
claude_wait_ready() { # <dir> [timeout]
  wait_events "$1" '.event == "SessionStart"' 1 "${2:-60}" || return 1
  sleep 3
}

# Session id and transcript path as reported to the SessionStart probe.
claude_session_id() { # <dir>
  jq -rs '[.[] | select(.event == "SessionStart")] | last | .input.session_id' "$1/events.jsonl"
}
claude_transcript() { # <dir>
  jq -rs '[.[] | select(.input.transcript_path != null)] | last | .input.transcript_path' "$1/events.jsonl"
}

# All assistant text in the transcript, one message per line.
claude_assistant_text() { # <dir>
  local t
  t=$(claude_transcript "$1")
  [ -f "$t" ] || return 0
  jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' "$t" 2>/dev/null
}

# Text of the last assistant message that carried text, flattened to one line.
claude_last_text() { # <dir>
  local t
  t=$(claude_transcript "$1")
  [ -f "$t" ] || return 0
  jq -rs '[.[] | select(.type == "assistant") | [.message.content[]? | select(.type == "text") | .text] | join(" ") | select(length > 0)] | last // ""' "$t" | tr '\n' ' '
}

# Waits until the transcript's assistant text contains a string.
wait_assistant_says() { # <dir> <needle> <timeout-s>
  wait_until "$3" _assistant_has "$1" "$2"
}
_assistant_has() {
  claude_assistant_text "$1" | grep -qF -- "$2"
}

# Stops the harness in a pane: /exit, then close the pane.
claude_stop() { # <pane>
  lab_herdr pane send-keys "$1" Escape >/dev/null 2>&1 || true
  sleep 0.5
  claude_send "$1" "/exit" >/dev/null 2>&1 || true
  sleep 2
  lab_pane_close "$1"
}
