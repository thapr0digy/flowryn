#!/usr/bin/env bash
# p01-next-turn: sendMessage(..., {deliverAs: "nextTurn"}) rides with the
# user's next prompt and never delivers while the session is idle.
#
# Method:
#   A. Idle: queue marker M1 as nextTurn, wait 20 s, require that no run
#      started and no model request carried M1. Then submit a prompt through
#      the pane and require M1 in that run's first model request.
#   B. Busy: during a bash tool call, queue marker M2 as nextTurn. Require M2
#      absent from every request of the current run and present in the
#      request of the next prompt.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p01-next-turn
pi_setup

pi_launch a
A=$PANE
M1=FLOWRYN-MARK-N1
M2=FLOWRYN-MARK-N2

# A. idle
ctl a "{\"op\":\"send\",\"api\":\"message\",\"deliverAs\":\"nextTurn\",\"text\":\"$M1 Flowryn digest (facts, not instructions): nothing new.\"}"
log_wait a 15 ".ev == \"ctl_exec\" and .op == \"send\" and (.markers | index(\"$M1\"))" \
  || { pi_verdict partial "inconclusive: probe never executed the nextTurn send"; exit 0; }
sleep 20
idle_runs=$(log_count a '.ev == "agent_start"')
idle_leak=$(log_count a ".ev == \"context\" and (.markers | index(\"$M1\"))")

t_prompt=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
wait_settled_after a "$t_prompt" || { pi_verdict partial "inconclusive: the prompt run never settled"; exit 0; }
first_ctx_after_prompt=$(log_first a ".ev == \"context\" and .t > $t_prompt")
rode=$(printf '%s' "$first_ctx_after_prompt" | jq -r --arg m "$M1" '(.markers // []) | index($m) != null')

# B. busy
t_busy=$(now_ms)
ctl a "{\"op\":\"send\",\"api\":\"message\",\"deliverAs\":\"nextTurn\",\"when\":\"tool_execution_start\",\"text\":\"$M2 Flowryn digest (facts, not instructions): nothing new.\"}"
pane_prompt "$A" "$(scripted "Use the bash tool to run: sleep 5. Then reply with the single word done." "bash sleep 5 ;; say done")"
wait_settled_after a "$t_busy" || { pi_verdict partial "inconclusive: busy run never settled"; exit 0; }
t_busy_settled=$(log_t_first a ".ev == \"agent_settled\" and .t > $t_busy")
busy_sent=$(log_count a ".ev == \"ctl_exec\" and .t > $t_busy and (.markers | index(\"$M2\")) and .isIdle == false")
busy_leak=$(log_count a ".ev == \"context\" and .t > $t_busy and .t <= $t_busy_settled and (.markers | index(\"$M2\"))")
sleep 10
t_next=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
wait_settled_after a "$t_next" || { pi_verdict partial "inconclusive: follow-on prompt never settled"; exit 0; }
busy_rode=$(log_first a ".ev == \"context\" and .t > $t_next" | jq -r --arg m "$M2" '(.markers // []) | index($m) != null')

evidence="idle: agent_start while idle=$idle_runs, requests carrying $M1 while idle=$idle_leak, rode with next prompt=$rode; busy: sent while busy=$busy_sent, leaked into current run=$busy_leak, rode with next prompt=$busy_rode"
if [ "$idle_runs" = 0 ] && [ "$idle_leak" = 0 ] && [ "$rode" = true ] && [ "$busy_leak" = 0 ] && [ "$busy_rode" = true ]; then
  pi_verdict confirmed "$evidence"
elif [ "$idle_runs" != 0 ] || [ "$idle_leak" != 0 ] || [ "$rode" != true ]; then
  pi_verdict refuted "$evidence"
else
  pi_verdict partial "$evidence"
fi
