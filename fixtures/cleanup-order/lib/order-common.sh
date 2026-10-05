#!/usr/bin/env bash
# fixtures/cleanup-order/lib/order-common.sh - shared builders for the second
# cleanup-guard fixture set (the cleanup ORDER cases). Sourced by every
# <case>/build.sh and <case>/setup.sh.
#
# The git state reuses the first set's builders (fixtures/cleanup-guard/lib/
# build-common.sh: deterministic clock, fixed identity, bare origin, primary
# clone, linked worktree on fm/task-x1). On top of that a scenario gets:
#   bin/          fake tools, first on PATH for the implementation:
#                 no-mistakes (always: the real one must never be reached),
#                 and per case lsof, ps or a git wrapper
#   nm/           the fake no-mistakes' answers and its abort log
#   runtime/      what setup.sh started: pids (killed by the runner), marks
#   tuning.json   the clocks the implementation should use (small, for speed)
set -euo pipefail

OC_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=../../cleanup-guard/lib/build-common.sh
. "$OC_LIB_DIR/../../cleanup-guard/lib/build-common.sh"

# The first set's "landed" shape: a shippable commit pushed to origin, so the
# verdict is allow (on_remote_tracking_branch) and the order steps all run.
oc_land_shippable_commit() {
  fx_wt_commit "shippable work"
  git -C "$FX_WT" push -q origin "$FX_TASK_BRANCH"
  git -C "$FX_PRIMARY" fetch -q origin
}

# oc_fake <name> [<dest-name>]: install a fake from lib/fakes into bin/.
oc_fake() {
  local name=$1 dest=${2:-}
  [ -n "$dest" ] || dest=${name%%-*}
  mkdir -p "$FX_ROOT/bin"
  cp "$OC_LIB_DIR/fakes/$name" "$FX_ROOT/bin/$dest"
  chmod +x "$FX_ROOT/bin/$dest"
}

# oc_finish [<tuning-json>]: the first set's scenario files, plus the fake
# no-mistakes, the nm/ and runtime/ directories and tuning.json.
oc_finish() {
  local tuning=${1:-'{}'}
  fx_finish
  oc_fake no-mistakes no-mistakes
  mkdir -p "$FX_ROOT/nm" "$FX_ROOT/runtime"
  : > "$FX_ROOT/nm/status"
  jq -n --argjson t "$tuning" '{lock_age_ms: 1000, lock_wait_ms: 100, lock_retries: 2, reap_grace_ms: 300, reap_passes: 3, nomistakes_timeout_ms: 5000} + $t' > "$FX_ROOT/tuning.json"
}

# --- runtime helpers for setup.sh ---------------------------------------------
# oc_runtime <scenario-dir>: load paths from scenario.json.
oc_runtime() {
  OC_DIR=$(cd "$1" && pwd -P)
  OC_WT=$(jq -r '.paths.worktree' "$OC_DIR/scenario.json")
  OC_HEAD=$(jq -r '.refs.local_head' "$OC_DIR/scenario.json")
  mkdir -p "$OC_DIR/runtime"
}

# oc_track <pid>: the runner kills every tracked pid when the case ends.
oc_track() {
  printf '%s\n' "$1" >> "$OC_DIR/runtime/pids"
}

# oc_start_in <dir> <perl-program> [args...]: a detached process whose cwd is <dir>; echoes its pid.
oc_start_in() {
  local dir=$1 program=$2 pid
  shift 2
  ( cd "$dir" && exec perl -e "$program" "$@" ) </dev/null >/dev/null 2>&1 &
  pid=$!
  oc_track "$pid"
  printf '%s\n' "$pid"
}

# oc_lock <old|fresh>: create the worktree's git index.lock; old is year 2000.
oc_lock() {
  local lock
  lock=$(git -C "$OC_WT" rev-parse --git-path index.lock)
  case "$lock" in /*) ;; *) lock="$OC_WT/$lock" ;; esac
  : > "$lock"
  [ "$1" != old ] || touch -t 200001010000 "$lock"
  printf '%s\n' "$lock" > "$OC_DIR/runtime/lock-path"
}

# oc_nm_parked <branch> <head> [run-id]: the fake no-mistakes reports a run parked at a gate.
oc_nm_parked() {
  cat > "$OC_DIR/nm/status" <<NM
run:
  id: "${3:-01RUN}"
  branch: $1
  status: awaiting_approval
  awaiting_agent: parked 2m10s
  head: "$2"
  pr: ""
  findings: none
gate: review
NM
}

oc_nm_running() {
  cat > "$OC_DIR/nm/status" <<NM
run:
  id: "${3:-01RUN}"
  branch: $1
  status: running
  head: "$2"
  pr: ""
steps[1]{step,status,findings,summary}:
  test,running,0,"agent under way"
NM
}

# --- fake ps (written at setup time: it needs the pid) ----------------------
# The fakes answer both forms a guard may use for a process's start time:
# `ps -o pid=,lstart=,comm= -p <pids>` (Flowryn) and `ps -p <pid> -o lstart=`
# (the reference). Calls about other pids go to the real /bin/ps untouched.
oc_write_fake_ps() {  # <pid> <mode>: flip:<n> | ghost | mark:<file>
  printf '%s\n' "$1" > "$OC_DIR/runtime/ps-pid"
  printf '%s\n' "$2" > "$OC_DIR/runtime/ps-mode"
  cp "$OC_LIB_DIR/fakes/ps-rules" "$OC_DIR/bin/ps"
  chmod +x "$OC_DIR/bin/ps"
}

# The pid's start time reads differently after its first <n> reads: a reused pid.
oc_fake_ps_flip() { oc_write_fake_ps "$1" "flip:$2"; }
# A pid the process table always names with the same start time, alive or not.
oc_fake_ps_ghost() { oc_write_fake_ps "$1" ghost; }
# The first read of the pid creates <file> (the process then execs) and gives it time to.
oc_fake_ps_mark() { oc_write_fake_ps "$1" "mark:$2"; }
