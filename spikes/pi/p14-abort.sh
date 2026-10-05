#!/usr/bin/env bash
# p14-abort: the extension aborts the current run (the Pi worker interrupt
# path), with no keystroke.
#
# API: ExtensionContext.abort() (0.87.1 types.d.ts; the previous orchestrator
# fm-branch-supervision.ts calls ctx.abort()).
# Method: prompt `sleep 29.7` through bash; at tool_execution_start the probe
# queues two follow-ups (Q14 custom message, U14 user message). Once the sleep
# process is seen running, the probe calls ctx.abort(). Require:
# agent_settled within 10 s of the abort, the sleep process gone, pi idle
# afterwards, and a fresh prompt runs normally.
# Informational (0.87.1 interactive-mode.js restoreQueuedMessagesToEditor):
# an abort clears the queues, moving queued user text into the composer and
# dropping queued custom messages; the spike records where Q14 and U14 end up.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p14-abort
pi_setup

pi_launch a
A=$PANE
t0=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"followUp","when":"tool_execution_start","text":"FLOWRYN-MARK-Q14 Flowryn follow-up (fact): queued before abort."}'
ctl a '{"op":"send","api":"user","deliverAs":"followUp","when":"tool_execution_start","text":"FLOWRYN-MARK-U14 queued user follow-up"}'
pane_prompt "$A" "$(scripted "Use the bash tool to run: sleep 29.7. Then reply with the single word done." "bash sleep 29.7 ;; say done")"
log_wait a 60 '.ev == "tool_execution_start"' || { pi_verdict partial "inconclusive: the bash tool never started"; exit 0; }
sleep_before=no
wait_for 10 "pgrep -f 'sleep 29.7' >/dev/null" && sleep_before=yes
sleep 2
ctl a '{"op":"abort"}'
log_wait a 15 '.ev == "ctl_exec" and .op == "abort"' || { pi_verdict partial "inconclusive: abort never executed"; exit 0; }
t_abort=$(log_t_first a '.ev == "ctl_exec" and .op == "abort"')
settled_fast=no
log_wait a 10 ".ev == \"agent_settled\" and .t > $t_abort" && settled_fast=yes
t_settled=$(log_t_first a ".ev == \"agent_settled\" and .t > $t_abort")
sleep 2
sleep_alive=$(pgrep -f 'sleep 29.7' >/dev/null && echo yes || echo no)
outcome=$(log_last a ".ev == \"agent_before_settle\" and .t > $t0 and .t <= ${t_settled:-0}" | jq -r '.outcome // "none"')
tool_error=$(log_last a ".ev == \"tool_execution_end\" and .t > $t0" | jq -r '.isError // "none"')
status=$(ctl_now a '{"op":"status"}' | jq -c '{isIdle, hasPendingMessages}')
composer=$(ctl_now a '{"op":"read_editor"}' | jq -r '.editorText // ""')
u14_in_composer=no; [[ "$composer" == *FLOWRYN-MARK-U14* ]] && u14_in_composer=yes
ctl_now a '{"op":"set_editor","text":""}' >/dev/null || true

t1=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
reusable=no
wait_settled_after a "$t1" && reusable=yes
wait_quiet a 5 60 || true
q14_delivered=$(log_count a ".ev == \"context\" and .t > $t_abort and (.markers | index(\"FLOWRYN-MARK-Q14\"))")
u14_delivered=$(log_count a ".ev == \"context\" and .t > $t_abort and (.markers | index(\"FLOWRYN-MARK-U14\"))")

latency=$([ -n "$t_settled" ] && echo "$(( t_settled - t_abort )) ms" || echo never)
evidence="sleep running before abort=$sleep_before; abort->agent_settled=$latency (within 10 s=$settled_fast); outcome=$outcome; bash tool isError=$tool_error; sleep still running=$sleep_alive; after abort $status; next prompt ran=$reusable; queued at abort: custom Q14 later delivered=$q14_delivered, user U14 moved to composer=$u14_in_composer delivered=$u14_delivered"
if [ "$sleep_before" = no ]; then
  pi_verdict partial "inconclusive: the sleep process was never seen before the abort; $evidence"
elif [ "$settled_fast" = yes ] && [ "$sleep_alive" = no ] && [ "$reusable" = yes ]; then
  pi_verdict confirmed "$evidence"
elif [ "$settled_fast" = no ]; then
  pi_verdict refuted "$evidence"
else
  pi_verdict partial "$evidence"
fi
