#!/usr/bin/env bash
# p16-settled-follow-up (turn-end guard, spec 2 ship A): a sendMessage with
# deliverAs "followUp" + triggerTurn sent from inside the agent_settled
# handler opens a new run that carries the message. The worker extension
# sends the turn-end reminder that way.
#
# Method: queue a followUp + triggerTurn bound to the next agent_settled, then
# one prompt. Require a second agent_start after the first agent_settled, the
# marker in a model request, and a second agent_settled.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p16-settled-follow-up
pi_setup

pi_launch a
A=$PANE
sleep 3
t0=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"followUp","triggerTurn":true,"when":"agent_settled","text":"FLOWRYN-MARK-R16 You ended your turn without an outcome. Reply with the single word ok."}'
pane_prompt "$A" "$(scripted "Reply with the single word hi." "say hi ;; say {markers}")"
log_wait a 60 ".ev == \"agent_settled\" and .t > $t0" || { pi_verdict partial "inconclusive: the first run never settled"; exit 0; }
t_settled=$(log_t_first a ".ev == \"agent_settled\" and .t > $t0")
opened=no
log_wait a 20 ".ev == \"agent_start\" and .t > $t_settled" && opened=yes
wait_quiet a 5 60 || true
seen=$(log_count a ".ev == \"context\" and .t > $t_settled and (.markers | index(\"FLOWRYN-MARK-R16\"))")
settled=$(log_count a ".ev == \"agent_settled\" and .t > $t0")

evidence="second run opened after agent_settled=$opened; reminder marker in a model request=$seen; agent_settled total=$settled"
if [ "$opened" = yes ] && [ "$seen" -gt 0 ] && [ "$settled" -ge 2 ]; then
  pi_verdict confirmed "$evidence"
else
  pi_verdict refuted "$evidence"
fi
