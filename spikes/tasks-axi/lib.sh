# shellcheck shell=bash
# Helpers for the tasks-axi spikes. Every call targets a scratch backlog under
# spikes/.runs/<spike>/ via --file; the previous orchestrator's data/backlog.md is never read
# or written.
. "$(dirname "${BASH_SOURCE[0]}")/../lib/lab.sh"

TAXI_VERSION="tasks-axi $(tasks-axi --version 2>/dev/null | tr -d '\n')"

# Runs tasks-axi against the scratch file; records exit code, output, and the
# file's hash before and after, as one TSV-ish line in $RUNLOG.
#   taxi <label> <args...>
taxi() {
  local label=$1 before after out rc
  shift
  before=$(shasum "$BACKLOG" 2>/dev/null | cut -c1-12)
  out=$(tasks-axi "$@" --file "$BACKLOG" --json 2>&1)
  rc=$?
  after=$(shasum "$BACKLOG" 2>/dev/null | cut -c1-12)
  LAST_RC=$rc
  LAST_OUT=$out
  LAST_CHANGED=no
  [ "$before" != "$after" ] && LAST_CHANGED=yes
  printf '%s\trc=%s\tchanged=%s\t%s\n' "$label" "$rc" "$LAST_CHANGED" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" >> "$RUNLOG"
}

# State of a task (queued, in_flight, done), read from `show` TOON output
# because read verbs take no --json in 0.2.5.
taxi_state() { # <id>
  tasks-axi show "$1" --file "$BACKLOG" 2>/dev/null | awk -F': ' '/^  state:/ {print $2; exit}'
}
taxi_field() { # <id> <field>
  tasks-axi show "$1" --file "$BACKLOG" 2>/dev/null | awk -F': ' -v f="  $2" '$1 == f {print $2; exit}'
}

taxi_init() { # <spike-id>
  TDIR=$(spike_workdir "$1")
  BACKLOG="$TDIR/backlog.md"
  RUNLOG="$TDIR/run.tsv"
  : > "$RUNLOG"
  case "$BACKLOG" in
    */data/backlog.md) lab_die "refusing a data/backlog.md path" ;;
  esac
}
