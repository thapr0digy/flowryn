#!/usr/bin/env bash
# M0 claim (design §8 intent journal): replaying a pending intent is safe.
# start and hold are idempotent by their help text; this spike checks done,
# unhold, update and mv (and add, which the journal guards with show first),
# because the journal re-runs any intent whose "applied" mark was lost.
#
# Method: scratch backlog; each verb runs twice with the same arguments. A
# verb is replay-safe when the second run exits 0 and leaves the file
# byte-identical (or reports already-applied without a harmful change).
set -u
. "$(dirname "$0")/lib.sh"
ID=t01-idempotency
taxi_init "$ID"
OTHER="$TDIR/other-backlog.md"
PR=https://github.com/o/r/pull/7

taxi seed-a add ta-done "done target" --start
taxi seed-b add ta-hold "hold target" --start
taxi seed-c add ta-upd "update target" --start
taxi seed-d add ta-mv "mv target"
taxi seed-e add ta-start "start target"

declare -A RC1 RC2 CH2
run_twice() { # <verb-label> <args...>
  local label=$1
  shift
  taxi "$label#1" "$@"; RC1[$label]=$LAST_RC
  taxi "$label#2" "$@"; RC2[$label]=$LAST_RC; CH2[$label]=$LAST_CHANGED
  OUT2[$label]=$LAST_OUT
}
declare -A OUT2

run_twice done done ta-done --pr "$PR"
taxi hold-for-unhold hold ta-hold --kind captain --reason "question pending"
run_twice unhold unhold ta-hold
run_twice update update ta-upd --title "updated title" --priority 1
run_twice mv mv ta-mv --to "$OTHER"
run_twice start start ta-start
run_twice hold hold ta-start --kind parked --reason "parked by spike"
run_twice add add ta-new "new task" --kind ship

row() { # <label>
  printf '%s: 1st rc=%s, 2nd rc=%s changed=%s' "$1" "${RC1[$1]}" "${RC2[$1]}" "${CH2[$1]}"
  printf '%s' "${OUT2[$1]}" | grep -q '"already": *true' && printf ' already=true'
  printf '%s' "${OUT2[$1]}" | grep -q '^code:' && printf ' (%s)' "$(printf '%s' "${OUT2[$1]}" | awk '/^code:/ {print $2}')"
}
safe() { [ "${RC2[$1]}" = 0 ] && [ "${CH2[$1]}" = no ]; }
done_title=$(taxi_field ta-done title)

summary="$(row done); $(row unhold); $(row update); $(row mv); control $(row start); control $(row hold); $(row add). Title of ta-done after done --pr: $done_title"
if safe done && safe unhold && safe update && safe mv; then verdict=confirmed
elif safe done && safe unhold && safe update; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$TAXI_VERSION" "$summary"
