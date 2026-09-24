#!/usr/bin/env bash
# p13-steer-mode: is deliverAs "steer" (0.87.1 types.d.ts: sendMessage
# deliverAs "steer" | "followUp" | "nextTurn") a better busy-worker channel
# than followUp?
#
# Docs (docs/usage.md, 0.87.1): a steer "waits until the current response and
# its tool calls finish, then guides the next response"; a follow-up "waits
# until Pi finishes the current task".
# Method: prompt three sequential `sleep 4` bash calls. At the first
# tool_execution_start send S (steer) and F (followUp) as custom messages.
# Compare when each marker first reaches a model request: S should arrive
# with the request right after the first tool batch; F only after the
# assistant's final stop. Also count bash calls after S arrived (did the
# worker change course?).
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p13-steer-mode
pi_setup

pi_launch a
A=$PANE
t0=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"steer","when":"tool_execution_start","text":"FLOWRYN-MARK-S13 Flowryn steer (fact): the user changed plans; skip any remaining sleeps and reply with the word steered."}'
ctl a '{"op":"send","api":"message","deliverAs":"followUp","when":"tool_execution_start","text":"FLOWRYN-MARK-F13 Flowryn follow-up (fact): acknowledge with the word followed."}'
pane_prompt "$A" "$(scripted "Use the bash tool three times, one call at a time, waiting for each to finish: sleep 4, then sleep 4, then sleep 4. Then reply with the single word done." "bash sleep 4 ;; bash sleep 4 ;; bash sleep 4 ;; say done")"
log_wait a 60 '.ev == "tool_execution_start"' || { pi_verdict partial "inconclusive: model never ran bash"; exit 0; }
wait_settled_after a "$t0" || true
wait_quiet a 10 "$PI_RUN_TIMEOUT" || true

t_s=$(log_t_first a '.ev == "context" and (.markers | index("FLOWRYN-MARK-S13"))')
t_f=$(log_t_first a '.ev == "context" and (.markers | index("FLOWRYN-MARK-F13"))')
t_first_tool_end=$(log_t_first a ".ev == \"tool_execution_end\" and .t > $t0")
t_stop=$(log_t_first a ".ev == \"message_end\" and .role == \"assistant\" and .toolCalls == 0 and .t > $t0")
bash_total=$(log_count a ".ev == \"tool_execution_start\" and .toolName == \"bash\" and .t > $t0")
bash_after_s=0
[ -n "$t_s" ] && bash_after_s=$(log_count a ".ev == \"tool_execution_start\" and .toolName == \"bash\" and .t > $t_s")
settled=$(log_count a ".ev == \"agent_settled\" and .t > $t0")

rel() { [ -n "$1" ] && echo "+$(( ($1 - t0) / 1000 ))s" || echo never; }
evidence="steer reached model at $(rel "$t_s") (first tool end $(rel "$t_first_tool_end"), first assistant stop $(rel "$t_stop")); followUp reached model at $(rel "$t_f"); bash calls total=$bash_total, after steer=$bash_after_s; agent_settled=$settled"
if [ -n "$t_s" ] && [ -n "$t_f" ] && [ "$t_s" -lt "$t_f" ] && { [ -z "$t_stop" ] || [ "$t_s" -le "$t_stop" ]; }; then
  pi_verdict confirmed "steer lands mid-run, before followUp; $evidence"
elif [ -z "$t_s" ]; then
  pi_verdict refuted "steer never reached the model; $evidence"
else
  pi_verdict partial "$evidence"
fi
