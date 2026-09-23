#!/usr/bin/env bash
# M0 claim (design §6 reattach): pane metadata written with no TTL
# (flowryn:<run>) persists and can be used to find reattach candidates.
#
# Method: in one lab pane, report a token and a title from source "flowryn"
# with no --ttl-ms, and a control token from source "flowryn-ttl" with a 3 s
# TTL. Read the pane back immediately, after 10 s, and after 90 s with the pane
# busy in between (a command runs and exits), to see which metadata survives.
set -u
. "$(dirname "$0")/../lib/lab.sh"
ID=h03-metadata-no-ttl
lab_ensure
DIR=$(spike_workdir "$ID")
herdr_version=$(herdr --version | awk '{print "Herdr " $2}')
RUN="r$RANDOM$RANDOM"

PANE=$(lab_new_pane "$DIR" "$ID") || lab_die "no pane"
lab_herdr pane report-metadata "$PANE" --source flowryn --token "flowryn=$RUN" --title "flowryn:$RUN" > "$DIR/report.json"
lab_herdr pane report-metadata "$PANE" --source flowryn-ttl --token "flowryn_ttl=$RUN" --ttl-ms 3000 > "$DIR/report-ttl.json"
read_meta() { lab_herdr pane get "$PANE" | jq -c '.result.pane | {title, tokens, state_labels}'; }
m0=$(read_meta)
sleep 10
m10=$(read_meta)
lab_pane_run "$PANE" "echo busy; sleep 2; echo done" || true
sleep 80
m90=$(read_meta)
snap=$(lab_herdr api snapshot | jq -c --arg p "$PANE" '[(.result.snapshot // .result // .) | .panes[] | select(.pane_id == $p) | .tokens] | first')
lab_pane_close "$PANE"

kept=no; ttl_expired=no
printf '%s' "$m90" | grep -qF "flowryn\":\"$RUN" && kept=yes
printf '%s' "$m10" | grep -qF "flowryn_ttl" || ttl_expired=yes
evidence="immediately: $m0; after 10s: $m10; after 90s and a command: $m90; snapshot tokens: $snap; no-TTL token kept=$kept; 3s-TTL control expired=$ttl_expired"
if [ "$kept" = yes ] && [ "$ttl_expired" = yes ]; then verdict=confirmed
elif [ "$kept" = yes ]; then verdict=partial
else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$herdr_version" "$evidence"
