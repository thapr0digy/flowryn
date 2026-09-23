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

spike_id() { basename "$1" .sh; }

ran=()
wants tasks-axi && ran+=(tasks-axi/t*.sh)
wants no-mistakes && ran+=(no-mistakes/n*.sh)
wants pi && ran+=(pi/p[0-9][0-9]-*.sh)
wants herdr && ran+=(herdr/h*.sh)
wants claude && ran+=(claude/c*.sh)
for s in "${ran[@]}"; do rm -f "$SPIKES_RUNS/results/$(spike_id "$s").json"; done

run_serial() { # <scripts...>
  local s
  for s in "$@"; do
    bash "$s" > "$SPIKES_RUNS/$(spike_id "$s").log" 2>&1 || echo "spike exited non-zero: $s" >&2
  done
}

run_parallel() { # <scripts...>
  local s
  for s in "$@"; do
    while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 2; done
    bash "$s" > "$SPIKES_RUNS/$(spike_id "$s").log" 2>&1 &
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

for s in "${ran[@]}"; do
  f="$SPIKES_RUNS/results/$(spike_id "$s").json"
  if [ -s "$f" ]; then
    jq -r '"\(.id)\t\(.verdict)\t\(.version)"' "$f"
  else
    printf '%s\tno verdict (spike failed before recording)\t-\n' "$(spike_id "$s")"
  fi
done | sort | column -t -s $'\t'
