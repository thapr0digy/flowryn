#!/usr/bin/env bash
# p02-follow-up: deliverAs "followUp" is accepted while busy and delivered
# after the current run's work; a busy send without deliverAs is rejected.
#
# Method: prompt a run that calls bash (sleep 8). At tool_execution_start the
# probe sends, in order:
#   F1 sendMessage      {deliverAs: "followUp"}   (custom message; the bridge path)
#   F2 sendUserMessage  {deliverAs: "followUp"}   (user message)
#   F3 sendUserMessage  no deliverAs              (expected: rejected)
#   F4 sendMessage      no deliverAs              (informational: 0.87.1 source steers it)
# "After the current run" = first model request carrying the marker comes
# after the assistant message that ended the prompted work (stopReason stop,
# no tool calls) that follows the send.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p02-follow-up
pi_setup

pi_launch a
A=$PANE
t0=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"followUp","when":"tool_execution_start","text":"FLOWRYN-MARK-F1 Flowryn P0 (fact): a worker needs you. Acknowledge with the word noted."}'
ctl a '{"op":"send","api":"user","deliverAs":"followUp","when":"tool_execution_start","text":"FLOWRYN-MARK-F2 reply with the single word noted."}'
ctl a '{"op":"send","api":"user","when":"tool_execution_start","text":"FLOWRYN-MARK-F3 reply with the single word noted."}'
ctl a '{"op":"send","api":"message","when":"tool_execution_start","text":"FLOWRYN-MARK-F4 Flowryn note (fact): nothing to do."}'
pane_prompt "$A" "$(scripted "Use the bash tool to run: sleep 8. Then reply with the single word done." "bash sleep 8 ;; say done")"

log_wait a 60 '.ev == "tool_execution_start"' || { pi_verdict partial "inconclusive: model never ran the bash tool"; exit 0; }
wait_settled_after a "$t0" || { pi_verdict partial "inconclusive: run never settled"; exit 0; }
wait_quiet a 15 "$PI_RUN_TIMEOUT" || true   # let any continuation finish

t_send=$(log_t_first a '.ev == "ctl_exec" and .op == "send"')
busy_at_send=$(log_count a '.ev == "ctl_exec" and .op == "send" and .isIdle == false')
# First assistant stop (no tool calls) after the sends: end of the prompted work.
t_work_end=$(log_t_first a ".ev == \"message_end\" and .role == \"assistant\" and .toolCalls == 0 and .t > ${t_send:-0}")
first_ctx() { log_t_first a ".ev == \"context\" and (.markers | index(\"$1\"))"; }
f1=$(first_ctx FLOWRYN-MARK-F1)
f2=$(first_ctx FLOWRYN-MARK-F2)
f3=$(first_ctx FLOWRYN-MARK-F3)
f4=$(first_ctx FLOWRYN-MARK-F4)
f3_input=$(log_count a '.ev == "input" and .source == "extension" and .streamingBehavior == null and (.markers | index("FLOWRYN-MARK-F3"))')
settled=$(log_count a ".ev == \"agent_settled\" and .t > $t0")

after() { [ -n "$1" ] && [ -n "$t_work_end" ] && [ "$1" -ge "$t_work_end" ]; }
f1_ok=no; after "$f1" && f1_ok=yes
f2_ok=no; after "$f2" && f2_ok=yes
f3_rejected=no; [ -z "$f3" ] && f3_rejected=yes
f4_mode=never; [ -n "$f4" ] && { if after "$f4"; then f4_mode=after-work; else f4_mode=mid-run; fi; }

evidence="sends while busy=$busy_at_send/4; F1(message followUp) after work=$f1_ok; F2(user followUp) after work=$f2_ok; F3(user, no deliverAs) rejected=$f3_rejected (input event seen=$f3_input); F4(message, no deliverAs) delivered=$f4_mode; agent_settled count=$settled"
if [ "$busy_at_send" != 4 ]; then
  pi_verdict partial "inconclusive: sends did not all happen while busy; $evidence"
elif [ "$f1_ok" = yes ] && [ "$f2_ok" = yes ] && [ "$f3_rejected" = yes ]; then
  pi_verdict confirmed "$evidence"
elif [ "$f1_ok" = no ] && [ "$f2_ok" = no ]; then
  pi_verdict refuted "$evidence"
else
  pi_verdict partial "$evidence"
fi
