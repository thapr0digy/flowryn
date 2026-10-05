#!/usr/bin/env bash
# Holds one isolated Herdr lab session open so several spikes can share it.
# Writes the session name to $SPIKES_RUNS/lab-session and waits until
# $SPIKES_RUNS/lab-release exists (or a signal arrives), then tears the session
# down through the lab helper (herdr-lab.sh), which verifies the default session is
# unchanged.
#
#   spikes/lib/lab-hold.sh &            # start
#   export FLOWRYN_LAB_SESSION=$(cat spikes/.runs/lab-session)
#   ...run spikes...
#   touch spikes/.runs/lab-release      # stop
set -u
unset FLOWRYN_LAB_SESSION
# shellcheck source=lab.sh
. "$(dirname "$0")/lab.sh"

rm -f "$SPIKES_RUNS/lab-release" "$SPIKES_RUNS/lab-session"
lab_ensure
printf '%s\n' "$HERDR_LAB_SESSION" > "$SPIKES_RUNS/lab-session"
echo "lab session $HERDR_LAB_SESSION is up; touch $SPIKES_RUNS/lab-release to tear it down"
while [ ! -e "$SPIKES_RUNS/lab-release" ]; do
  sleep 2
done
rm -f "$SPIKES_RUNS/lab-release" "$SPIKES_RUNS/lab-session"
echo "releasing $HERDR_LAB_SESSION"
