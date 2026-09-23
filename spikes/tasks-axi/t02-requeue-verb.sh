#!/usr/bin/env bash
# M0 claim (design §8 lifecycle table): a failed or cancelled run returns its
# task to Queued with a parked hold; M0 names the exact verb.
#
# Method: scratch backlog. An In flight task and a Done task are each sent
# back with `reopen` then `hold --kind parked`; the spike reads the resulting
# state, hold and whether links survive. `reopen` is also run twice.
set -u
. "$(dirname "$0")/lib.sh"
ID=t02-requeue-verb
taxi_init "$ID"

taxi seed-1 add tb-flight "in flight task" --start
taxi seed-2 add tb-done "done task" --start
taxi seed-3 done tb-done --pr https://github.com/o/r/pull/9

taxi reopen-flight reopen tb-flight; rc_a=$LAST_RC
taxi reopen-flight-again reopen tb-flight; rc_a2=$LAST_RC; ch_a2=$LAST_CHANGED
taxi park-flight hold tb-flight --kind parked --reason "run failed; parked"
taxi reopen-done reopen tb-done; rc_b=$LAST_RC
taxi park-done hold tb-done --kind parked --reason "cancelled with consent"

st_a=$(taxi_state tb-flight); hk_a=$(taxi_field tb-flight hold_kind)
st_b=$(taxi_state tb-done); hk_b=$(taxi_field tb-done hold_kind); links_b=$(taxi_field tb-done links)
queued=$(tasks-axi list --state queued --file "$BACKLOG" 2>/dev/null | tr '\n' ' ' | cut -c1-200)

evidence="in flight -> reopen rc=$rc_a (again rc=$rc_a2 changed=$ch_a2) -> state=$st_a hold_kind=$hk_a; done -> reopen rc=$rc_b -> state=$st_b hold_kind=$hk_b links=$links_b; list --state queued: $queued"
if [ "$st_a" = queued ] && [ "$hk_a" = parked ] && [ "$st_b" = queued ]; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$TAXI_VERSION" "exact verbs: reopen <id> then hold <id> --kind parked --reason ...; $evidence"
