#!/usr/bin/env bash
# Runs every M0 spike and prints one verdict line per spike.
#
#   spikes/run-all.sh [group...]     groups: tasks-axi no-mistakes herdr claude pi
#
# Herdr and Claude spikes share one isolated lab session provisioned here (and
# torn down on exit) through Firstmate's fm-herdr-lab.sh; they run
# SPIKE_JOBS at a time (default 4), each in its own lab workspace. Results land
# in spikes/.runs/results/<id>.json; docs/m0-verdicts.md is the curated record.
set -u
cd "$(dirname "$0")" || exit 1
. lib/lab.sh
JOBS=${SPIKE_JOBS:-4}
SELECTED=("$@")
[ "${#SELECTED[@]}" -gt 0 ] || SELECTED=(tasks-axi no-mistakes herdr claude pi)

wants() { local g; for g in "${SELECTED[@]}"; do [ "$g" = "$1" ] && return 0; done; return 1; }

run_serial() { # <scripts...>
  local s
  for s in "$@"; do
    bash "$s" > "$SPIKES_RUNS/$(basename "$s" .sh).log" 2>&1 || echo "spike exited non-zero: $s" >&2
  done
}

run_parallel() { # <scripts...>
  local s
  for s in "$@"; do
    while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 2; done
    bash "$s" > "$SPIKES_RUNS/$(basename "$s" .sh).log" 2>&1 &
    sleep 3
  done
  wait
}

wants tasks-axi && run_serial tasks-axi/t*.sh
wants no-mistakes && run_serial no-mistakes/n*.sh
wants pi && bash pi/run-all.sh > "$SPIKES_RUNS/pi-run-all.log" 2>&1
if wants herdr || wants claude; then
  lab_ensure
  export FLOWRYN_LAB_SESSION=$HERDR_LAB_SESSION
  scripts=()
  wants herdr && scripts+=(herdr/h*.sh)
  wants claude && scripts+=(claude/c*.sh)
  run_parallel "${scripts[@]}"
fi

for f in "$SPIKES_RUNS"/results/*.json; do
  jq -r '"\(.id)\t\(.verdict)\t\(.version)"' "$f"
done | sort | column -t -s $'\t'
