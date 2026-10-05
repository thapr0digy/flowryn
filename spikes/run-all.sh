#!/usr/bin/env bash
# Runs every M0 spike and prints one verdict line per spike.
#
#   spikes/run-all.sh [group...]     groups: tasks-axi no-mistakes herdr claude pi
#
# Herdr and Claude spikes share one isolated lab session provisioned here (and
# torn down on exit) through spikes/lib/herdr-lab.sh; they run
# SPIKE_JOBS at a time (default 4), each in its own lab workspace. Results land
# in spikes/.runs/results/<id>.json; docs/m0-verdicts.md is the curated record.
# Exits non-zero if any spike exited non-zero or recorded no result.
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
for s in "${ran[@]}"; do
  rm -f "$SPIKES_RUNS/results/$(spike_id "$s").json" "$SPIKES_RUNS/$(spike_id "$s").exit"
done

# Runs one spike, logging its output and recording its exit status.
run_spike() { # <script>
  local id
  id=$(spike_id "$1")
  bash "$1" > "$SPIKES_RUNS/$id.log" 2>&1
  echo "$?" > "$SPIKES_RUNS/$id.exit"
}

run_serial() { # <scripts...>
  local s
  for s in "$@"; do
    run_spike "$s"
  done
}

run_parallel() { # <scripts...>
  local s
  for s in "$@"; do
    while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 2; done
    run_spike "$s" &
    sleep 3
  done
  wait
}

wants tasks-axi && run_serial tasks-axi/t*.sh
wants no-mistakes && run_serial no-mistakes/n*.sh
failed=0
if wants pi && ! bash pi/run-all.sh > "$SPIKES_RUNS/pi-run-all.log" 2>&1; then
  echo "FAILED pi/run-all.sh: exited non-zero (see $SPIKES_RUNS/pi-run-all.log)" >&2
  failed=1
fi
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

for s in "${ran[@]}"; do
  id=$(spike_id "$s")
  code=$(cat "$SPIKES_RUNS/$id.exit" 2>/dev/null || echo 0)
  if [ ! -s "$SPIKES_RUNS/results/$id.json" ]; then
    echo "FAILED $id: no result recorded (see $SPIKES_RUNS/$id.log)" >&2
    failed=1
  elif [ "$code" != 0 ]; then
    echo "FAILED $id: exited $code (see $SPIKES_RUNS/$id.log)" >&2
    failed=1
  fi
done
exit "$failed"
