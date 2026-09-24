#!/usr/bin/env bash
# Runs every Pi bridge spike (spikes/pi/pNN-*.sh) in order and prints a
# verdict table from spikes/.runs/results/<id>.json.
#
# All spikes share one isolated Herdr lab session, provisioned here through
# Firstmate's fm-herdr-lab.sh and torn down on exit, unless FLOWRYN_LAB_SESSION
# already names one (spikes/lib/lab-hold.sh). Every model turn comes from the
# offline scripted provider (lib/scripted-provider.ts), so a run needs no
# credentials.
#
# Exits non-zero when any spike exits non-zero, records no result, records
# "not run" (pi missing), or records an inconclusive verdict. A refuted or
# partial verdict with evidence is a finding, not a failure.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-m0-pi}"
# shellcheck source=../lib/lab.sh
. "$DIR/../lib/lab.sh"
# shellcheck source=lib/pi-spike.sh
. "$DIR/lib/pi-spike.sh"
RESULTS="$SPIKES_RUNS/results"
status=0
ids=()
if [ -n "$(pi_resolve_bin)" ]; then
  lab_ensure
  export FLOWRYN_LAB_SESSION=$HERDR_LAB_SESSION
fi
for script in "$DIR"/p[0-9][0-9]-*.sh; do
  id=$(basename "$script" .sh)
  ids+=("$id")
  rm -f "$RESULTS/$id.json"
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
  if [ ! -s "$file" ]; then
    printf '%s\tno result\t-\n' "$id"
    echo "!!! $id recorded no result" >&2
    status=1
    continue
  fi
  jq -r '"\(.id)\t\(.verdict)\t\(.version)"' "$file"
  if jq -e '.verdict == "not run" or (.evidence | test("inconclusive"))' "$file" >/dev/null; then
    echo "!!! $id did not reach a verdict: $(jq -r '.evidence' "$file")" >&2
    status=1
  fi
done
exit "$status"
