#!/usr/bin/env bash
# p03-trigger-turn: sendMessage(..., {deliverAs: "followUp", triggerTurn: true})
# opens a turn while idle, and what it does to a half-typed composer.
#
# Method:
#   A. Clean composer, idle: send T1 with triggerTurn. Require agent_start
#      within 15 s and T1 in that run's model request.
#   B. Type a draft into the composer (no Enter), confirm the probe reads it,
#      send T2 with triggerTurn, wait for the run to settle, then classify the
#      draft: survives (still in the composer, never sent), submitted (seen in
#      an input event or a model request), or clobbered (gone, never sent).
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p03-trigger-turn
pi_setup

pi_launch a FLOWRYN_PROBE_EDITOR_WATCH=1
A=$PANE
sleep 3

# A. clean composer
t_a=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"followUp","triggerTurn":true,"text":"FLOWRYN-MARK-T1 Flowryn P0 (fact): test wake. Reply with the single word ok."}'
opened=no
log_wait a 15 ".ev == \"agent_start\" and .t > $t_a" && opened=yes
wait_settled_after a "$t_a" || true
t1_seen=$(log_count a ".ev == \"context\" and .t > $t_a and (.markers | index(\"FLOWRYN-MARK-T1\"))")
wait_quiet a 5 60 || true

# B. half-typed composer
DRAFT="half typed FLOWRYN-DRAFT-3 do not send"
pane_type "$A" "$DRAFT"
sleep 1.5
before=$(ctl_now a '{"op":"read_editor"}' | jq -r '.editorText // ""')
t_b=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"followUp","triggerTurn":true,"text":"FLOWRYN-MARK-T2 Flowryn P0 (fact): test wake. Reply with the single word ok."}'
opened_b=no
log_wait a 15 ".ev == \"agent_start\" and .t > $t_b" && opened_b=yes
wait_settled_after a "$t_b" || true
sleep 2
after=$(ctl_now a '{"op":"read_editor"}' | jq -r '.editorText // ""')
pane_snapshot "$A" "$WORK/a.after-trigger.txt"
submitted=$(( $(log_count a ".t > $t_b and (.ev == \"input\" or .ev == \"context\" or .ev == \"message_start\") and (.markers | index(\"FLOWRYN-DRAFT-3\"))") ))
draft_state=clobbered
if [ "$submitted" -gt 0 ]; then
  draft_state=submitted
elif [ "$after" = "$before" ] && [ -n "$after" ]; then
  draft_state=survives
fi
ctl_now a '{"op":"set_editor","text":""}' >/dev/null || true

evidence="A: turn opened while idle=$opened, T1 in request=$t1_seen; B: composer before trigger='$before', turn opened=$opened_b, composer after='$after', draft=$draft_state"
if [ "$opened" = no ]; then
  pi_verdict refuted "$evidence"
elif [[ "$before" != *FLOWRYN-DRAFT-3* ]]; then
  pi_verdict partial "inconclusive for the composer half: the draft never reached the composer; $evidence"
elif [ "$t1_seen" -gt 0 ] && [ "$opened_b" = yes ] && [ "$draft_state" = survives ]; then
  pi_verdict confirmed "$evidence"
else
  pi_verdict partial "$evidence"
fi
