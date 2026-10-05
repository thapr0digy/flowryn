#!/usr/bin/env bash
# p15-urgent: the Pi side of urgent steers (steer latency Tier 2, design
# assumptions A4-A6 in the steer-urgent-tier design).
#
# A4: a steer queued (deliverAs "steer") while the model issues a tool call,
#     with that tool_call blocked, reaches the very next model request, and the
#     blocked command never runs.
# A5: a steer queued at turn_end of a tool-free final message: is it delivered
#     before agent_settled (Pi continues), or only later? Either way the daemon
#     re-rings an unseen urgent steer at agent_settled; this records which.
# A6: ctx.abort() during a bash tool kills the command's child processes too
#     (a backgrounded sleep inside the command), not only the agent loop.
#
# Method: scripted provider; the probe's block_tools control blocks every
# tool_call; markers in the context event prove delivery.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p15-urgent
pi_setup

pi_launch a
A=$PANE

# --- A4 ---------------------------------------------------------------------------------
t0=$(now_ms)
ctl a '{"op":"block_tools","reason":"Blocked by Flowryn: urgent steer [m1] is waiting; read it, then redo this call if it still applies."}'
ctl a '{"op":"send","api":"message","deliverAs":"steer","when":"tool_call","text":"FLOWRYN-MARK-U15 Flowryn steer [m1]: urgent test steer."}'
pane_prompt "$A" "$(scripted "Use the bash tool to run: touch should-not-run. Then reply with the markers you were given." "bash touch should-not-run ;; say {markers}")"
wait_settled_after a "$t0" || true
wait_quiet a 3 60 || true
ctl a '{"op":"block_tools","reason":null}'
t_call=$(log_t_first a ".ev == \"tool_call\" and .t > $t0")
t_seen=$(log_t_first a ".ev == \"context\" and .t > $t0 and (.markers | index(\"FLOWRYN-MARK-U15\"))")
contexts_between=$( [ -n "$t_call" ] && [ -n "$t_seen" ] && log_count a ".ev == \"context\" and .t > $t_call and .t < $t_seen" || echo "?")
ran=$([ -e "$CWD/should-not-run" ] && echo yes || echo no)
a4_ok=no
[ -n "$t_seen" ] && [ "$contexts_between" = 0 ] && [ "$ran" = no ] && a4_ok=yes
ev_a4="A4: blocked command ran=$ran; steer reached a request=$([ -n "$t_seen" ] && echo "+$(( t_seen - t_call )) ms after the blocked call" || echo never); requests in between=$contexts_between"

# --- A5 ---------------------------------------------------------------------------------
t1=$(now_ms)
ctl a '{"op":"send","api":"message","deliverAs":"steer","when":"turn_end","text":"FLOWRYN-MARK-V15 Flowryn steer [m2]: queued at turn end."}'
pane_prompt "$A" "$(scripted "Reply with the single word hello." "say hello ;; say {markers}")"
wait_settled_after a "$t1" || true
wait_quiet a 3 60 || true
t_settled=$(log_t_first a ".ev == \"agent_settled\" and .t > $t1")
t_v=$(log_t_first a ".ev == \"context\" and .t > $t1 and (.markers | index(\"FLOWRYN-MARK-V15\"))")
if [ -z "$t_v" ]; then a5="not delivered by agent_settled (re-ring needed)"
elif [ -n "$t_settled" ] && [ "$t_v" -lt "$t_settled" ]; then a5="delivered before agent_settled (Pi continued)"
else a5="delivered after agent_settled"
fi
ev_a5="A5: $a5"

# --- A6 ---------------------------------------------------------------------------------
t2=$(now_ms)
pane_prompt "$A" "$(scripted "Use the bash tool to run: sh -c 'sleep 29.3 & sleep 29.4; wait'" "bash sh -c 'sleep 29.3 & sleep 29.4; wait' ;; say done")"
log_wait a 60 ".ev == \"tool_execution_start\" and .t > $t2" || { pi_verdict partial "inconclusive: the A6 bash tool never started; $ev_a4; $ev_a5"; exit 0; }
both=no
wait_for 10 "pgrep -f 'sleep 29.3' >/dev/null && pgrep -f 'sleep 29.4' >/dev/null" && both=yes
ctl a '{"op":"abort"}'
log_wait a 15 ".ev == \"ctl_exec\" and .op == \"abort\" and .t > $t2" || true
sleep 3
bg_alive=$(pgrep -f 'sleep 29.3' >/dev/null && echo yes || echo no)
fg_alive=$(pgrep -f 'sleep 29.4' >/dev/null && echo yes || echo no)
pkill -f 'sleep 29.3' 2>/dev/null || true
a6_ok=no
[ "$both" = yes ] && [ "$bg_alive" = no ] && [ "$fg_alive" = no ] && a6_ok=yes
ev_a6="A6: both sleeps running before the abort=$both; after: backgrounded alive=$bg_alive, foreground alive=$fg_alive"

evidence="$ev_a4; $ev_a5; $ev_a6"
if [ "$a4_ok" = yes ] && [ "$a6_ok" = yes ]; then
  pi_verdict confirmed "$evidence"
elif [ "$a4_ok" = yes ] || [ "$a6_ok" = yes ]; then
  pi_verdict partial "$evidence"
else
  pi_verdict refuted "$evidence"
fi
