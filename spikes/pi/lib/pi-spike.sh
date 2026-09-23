# shellcheck shell=bash
# Shared plumbing for the Pi bridge spikes (spikes/pi/pNN-*.sh).
#
# Order in every spike:
#   . "$(dirname "$0")/lib/pi-spike.sh"
#   pi_require <spike-id>     # records "not run" and exits 0 when pi is absent;
#                             # runs before anything touches Herdr
#   pi_setup                  # scratch dir under spikes/.runs/<id>, then lab_ensure
#   pi_launch <name> ...      # a lab pane running pi with the probe extension
#   ...drive with pane_prompt / pane_type / pane_key / ctl, poll with log_wait...
#   pi_verdict <verdict> <evidence>
#
# Pi isolation: everything is per invocation. The probe loads with -e (Pi's
# extension flag, docs/cli.md 0.87.1), sessions go to --session-dir inside the
# scratch dir, and no spike writes ~/.pi. Pi itself still reads the user's
# agent dir (auth, settings, global extensions) because a spike needs a working
# model; Pi may create its own files there (for example the proper-lockfile
# lock it takes while reading trust.json). Set FLOWRYN_PI_AGENT_DIR to point
# PI_CODING_AGENT_DIR at a prepared scratch agent dir to avoid even that.
#
# Optional environment:
#   FLOWRYN_PI_AGENT_DIR  exported as PI_CODING_AGENT_DIR for every spike pi
#   FLOWRYN_PI_MODEL   passed as --model (pick a cheap model; spikes send short prompts)
#   FLOWRYN_PI_ARGS    extra pi arguments, word-split (for example "--thinking off")
#   FLOWRYN_PI_TIMEOUT seconds to wait for a model run to settle (default 180)

PI_SPIKE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../../lib/lab.sh
. "$PI_SPIKE_DIR/../lib/lab.sh"
PROBE_EXTENSION="$PI_SPIKE_DIR/extension/flowryn-probe.ts"
PI_VERSION_LABEL="pi: not installed"
PI_RUN_TIMEOUT="${FLOWRYN_PI_TIMEOUT:-180}"
SPIKE_ID=""
WORK=""
CWD=""
SESSIONS=""
PANE=""
PANES=()
CTL_SEQ=0

# Must be the first call: a machine without pi records "not run" and exits 0
# before any Herdr lab is provisioned.
pi_require() { # <spike-id>
  SPIKE_ID=$1
  if ! command -v pi >/dev/null 2>&1; then
    spike_verdict "$SPIKE_ID" "not run" "pi: not installed" "pi not installed on this machine"
    exit 0
  fi
  local version
  version=$(pi --version 2>/dev/null | head -n 1 | tr -d '\r')
  PI_VERSION_LABEL="pi ${version:-unknown}"
  command -v jq >/dev/null 2>&1 || lab_die "jq is required"
}

pi_setup() {
  WORK=$(spike_workdir "$SPIKE_ID")
  CWD="$WORK/cwd"
  SESSIONS="$WORK/sessions"
  mkdir -p "$CWD" "$SESSIONS"
  lab_ensure
}

plog() { # <instance>
  printf '%s/%s.probe.jsonl\n' "$WORK" "$1"
}

pctl() { # <instance>
  printf '%s/%s.ctl.jsonl\n' "$WORK" "$1"
}

# Builds the pane command line. Arguments: <instance> <cwd> <probe:0|1>
# [VAR=value ...] -- [pi arguments ...]
pi_command() {
  local name=$1 dir=$2 with_probe=$3
  shift 3
  local envs=() args=() item cmd
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  args=("$@")
  cmd="cd $(printf %q "$dir") && env PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0"
  cmd+=" FLOWRYN_PROBE_INSTANCE=$(printf %q "$name")"
  cmd+=" FLOWRYN_PROBE_LOG=$(printf %q "$(plog "$name")")"
  cmd+=" FLOWRYN_PROBE_CTL=$(printf %q "$(pctl "$name")")"
  [ -n "${FLOWRYN_PI_AGENT_DIR:-}" ] && cmd+=" PI_CODING_AGENT_DIR=$(printf %q "$FLOWRYN_PI_AGENT_DIR")"
  for item in ${envs[@]+"${envs[@]}"}; do cmd+=" $(printf %q "$item")"; done
  cmd+=" pi"
  [ "$with_probe" = 1 ] && cmd+=" -e $(printf %q "$PROBE_EXTENSION")"
  cmd+=" --session-dir $(printf %q "$SESSIONS")"
  [ -n "${FLOWRYN_PI_MODEL:-}" ] && cmd+=" --model $(printf %q "$FLOWRYN_PI_MODEL")"
  # shellcheck disable=SC2086
  [ -n "${FLOWRYN_PI_ARGS:-}" ] && for item in $FLOWRYN_PI_ARGS; do cmd+=" $(printf %q "$item")"; done
  for item in ${args[@]+"${args[@]}"}; do cmd+=" $(printf %q "$item")"; done
  printf '%s' "$cmd"
}

# Starts pi in a new lab pane and sets PANE. Options before the instance
# name: --no-probe (omit -e), --cwd <dir> (default $CWD), --no-wait (do not
# wait for session_start). Then [VAR=value ...] -- [pi arguments ...].
pi_launch() {
  local with_probe=1 dir=$CWD wait=1
  while :; do
    case "${1:-}" in
      --no-probe) with_probe=0; shift ;;
      --cwd) dir=$2; shift 2 ;;
      --no-wait) wait=0; shift ;;
      *) break ;;
    esac
  done
  local name=$1
  shift
  : > "$(pctl "$name")"
  local cmd pane
  cmd=$(pi_command "$name" "$dir" "$with_probe" "$@")
  printf '%s\n' "$cmd" > "$WORK/$name.command.txt"
  pane=$(lab_new_pane "$dir" "$SPIKE_ID-$name") || lab_die "workspace create failed for $name"
  [ -n "$pane" ] || lab_die "workspace create returned no pane id for $name"
  PANES+=("$pane")
  PANE=$pane
  lab_pane_run "$pane" "$cmd" || lab_die "pane run failed for $name"
  if [ "$wait" = 1 ] && [ "$with_probe" = 1 ]; then
    log_wait "$name" 90 '.ev == "session_start"' || {
      pane_snapshot "$pane" "$WORK/$name.start-failure.txt"
      pi_verdict "partial" "inconclusive: pi instance $name never logged session_start within 90 s (screen: $WORK/$name.start-failure.txt)"
      exit 0
    }
  fi
}

# --- probe log queries (jq filters over the instance's JSONL) --------------------

log_count() { # <instance> <jq-select-expression>
  local file
  file=$(plog "$1")
  [ -s "$file" ] || { echo 0; return 0; }
  jq -s "[.[] | select($2)] | length" "$file" 2>/dev/null || echo 0
}

log_has() { # <instance> <jq-select-expression>
  [ "$(log_count "$1" "$2")" -gt 0 ]
}

log_wait() { # <instance> <timeout-s> <jq-select-expression>
  wait_until "$2" log_has "$1" "$3"
}

log_first() { # <instance> <jq-select-expression>
  local file
  file=$(plog "$1")
  [ -s "$file" ] || return 0
  jq -cs "[.[] | select($2)] | first // empty" "$file" 2>/dev/null
}

log_last() { # <instance> <jq-select-expression>
  local file
  file=$(plog "$1")
  [ -s "$file" ] || return 0
  jq -cs "[.[] | select($2)] | last // empty" "$file" 2>/dev/null
}

# Epoch milliseconds of the first/last matching line, or empty.
log_t_first() { log_first "$1" "$2" | jq -r '.t // empty'; }
log_t_last() { log_last "$1" "$2" | jq -r '.t // empty'; }

now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || echo "$(( $(date +%s) * 1000 ))"
}

# Waits for the next agent_settled after epoch-ms <since>.
wait_settled_after() { # <instance> <since-ms> [timeout-s]
  log_wait "$1" "${3:-$PI_RUN_TIMEOUT}" ".ev == \"agent_settled\" and .t > $2"
}

# True when the instance has settled and started nothing for <quiet-s> seconds.
pi_is_quiet() { # <instance> <quiet-s>
  local last_start last_settled now
  last_start=$(log_t_last "$1" '.ev == "agent_start"')
  last_settled=$(log_t_last "$1" '.ev == "agent_settled"')
  [ -n "$last_settled" ] || return 1
  [ -z "$last_start" ] || [ "$last_settled" -ge "$last_start" ] || return 1
  now=$(now_ms)
  [ $((now - last_settled)) -ge $(($2 * 1000)) ]
}

wait_quiet() { # <instance> <quiet-s> <timeout-s>
  wait_until "$3" pi_is_quiet "$1" "$2"
}

# --- probe control -----------------------------------------------------------------

ctl() { # <instance> <json-object>; an "id" is added when missing
  CTL_SEQ=$((CTL_SEQ + 1))
  printf '%s\n' "$2" | jq -c --arg id "c$CTL_SEQ" 'if has("id") then . else . + {id: $id} end' >> "$(pctl "$1")"
}

# Runs a probe op now and waits for its ctl_exec line; prints that line.
ctl_now() { # <instance> <op-json>
  local id
  CTL_SEQ=$((CTL_SEQ + 1))
  id="n$CTL_SEQ"
  printf '%s\n' "$2" | jq -c --arg id "$id" '. + {id: $id}' >> "$(pctl "$1")"
  log_wait "$1" 15 ".ev == \"ctl_exec\" and .id == \"$id\"" || return 1
  log_first "$1" ".ev == \"ctl_exec\" and .id == \"$id\""
}

# --- pane input ----------------------------------------------------------------------
# Herdr key names follow Firstmate docs/verification/runtime-backends.md
# ("pane send-keys <pane> enter|escape|ctrl+c"); "down" and "ctrl+u" are
# assumed to follow the same naming.

pane_type() { # <pane> <text>
  lab_herdr pane send-text "$1" "$2" >/dev/null
}

pane_key() { # <pane> <key>
  lab_herdr pane send-keys "$1" "$2" >/dev/null
}

pane_prompt() { # <pane> <text>
  pane_type "$1" "$2"
  sleep 0.5
  pane_key "$1" enter
}

pane_snapshot() { # <pane> <file>
  lab_pane_read "$1" 80 > "$2" 2>&1 || true
}

# Stops one pi instance: probe shutdown, then /quit, then closes the pane.
pi_stop() { # <instance> <pane>
  ctl "$1" '{"op":"shutdown"}'
  if ! log_wait "$1" 15 '.ev == "session_shutdown"'; then
    pane_type "$2" "/quit"
    sleep 0.5
    pane_key "$2" enter
    log_wait "$1" 10 '.ev == "session_shutdown"' || true
  fi
  lab_pane_close "$2"
}

# --- verdict ------------------------------------------------------------------------

pi_verdict() { # <verdict> <evidence>
  local pane
  for pane in ${PANES[@]+"${PANES[@]}"}; do
    pane_snapshot "$pane" "$WORK/pane-${pane//[^A-Za-z0-9_-]/_}.final.txt"
    lab_pane_close "$pane"
  done
  PANES=()
  spike_verdict "$SPIKE_ID" "$1" "$PI_VERSION_LABEL" "$2 [logs: ${WORK#"$SPIKES_ROOT"/}]"
}
