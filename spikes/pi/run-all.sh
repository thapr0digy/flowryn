#!/usr/bin/env bash
# Runs every Pi bridge spike (spikes/pi/pNN-*.sh) in order and prints a
# verdict table from spikes/.runs/results/<id>.json.
#
# To share one Herdr lab session across spikes, start spikes/lib/lab-hold.sh
# first and export FLOWRYN_LAB_SESSION (see that file); otherwise each spike
# provisions and tears down its own lab. Without pi installed every spike
# records "not run" and no lab is provisioned.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
RESULTS="${SPIKES_RUNS:-$DIR/../.runs}/results"
status=0
ids=()
for script in "$DIR"/p[0-9][0-9]-*.sh; do
  id=$(basename "$script" .sh)
  ids+=("$id")
  echo "=== $id"
  if ! bash "$script"; then
    echo "!!! $id exited non-zero" >&2
    status=1
  fi
done

echo
echo "=== Pi spike verdicts"
for id in "${ids[@]}"; do
  file="$RESULTS/$id.json"
  if [ -s "$file" ]; then
    jq -r '"\(.id)\t\(.verdict)\t\(.version)"' "$file"
  else
    printf '%s\tno result\t-\n' "$id"
  fi
done
exit "$status"
