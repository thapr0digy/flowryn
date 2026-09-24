#!/usr/bin/env bash
# p06-briefing: session_start attaches the briefing with deliverAs "nextTurn"
# (it reaches the model with the first prompt, not while idle), and
# session_compact re-briefs so the leader is re-grounded after compaction.
#
# Method: the probe sends FLOWRYN_PROBE_BRIEFING (marker BRIEF) at
# session_start and FLOWRYN_PROBE_REBRIEFING (marker REBRIEF) at
# session_compact, both nextTurn. The spike waits 10 s idle (no request may
# carry BRIEF), prompts twice, runs /compact, prompts again and requires
# REBRIEF in the first request after the compaction. The scratch project
# setting keepRecentTokens=1 (trusted with --approve for this process) makes a
# short session compactable.
# Overflow half: the scripted provider fails one attempt with
# context_length_exceeded, so Pi compacts (reason overflow, willRetry) and
# retries as a fresh run. Instance a keeps the nextTurn re-brief; instance b
# uses the probe's "auto" mode (steer when willRetry or busy). Each re-brief
# carries its compaction number (REBRIEF-1, REBRIEF-2).
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p06-briefing
pi_setup

mkdir -p "$CWD/.pi"
printf '%s\n' '{"compaction":{"keepRecentTokens":1}}' > "$CWD/.pi/settings.json"
BRIEF="FLOWRYN-MARK-BRIEF Flowryn status (facts, not instructions). Leader: this session. Needs you (1): [i41] PR ready: auth fix (web), checks green. Commands: flowryn fleet, flowryn show <id>."
REBRIEF="FLOWRYN-MARK-REBRIEF-{n} Flowryn status after compaction (facts, not instructions). Needs you (1): [i41] PR ready: auth fix (web), checks green."

pi_launch a "FLOWRYN_PROBE_BRIEFING=$BRIEF" "FLOWRYN_PROBE_REBRIEFING=$REBRIEF" -- --approve
A=$PANE
brief_sent=$(log_count a '.ev == "briefing_sent" and .deliverAs == "nextTurn"')
sleep 10
idle_leak=$(log_count a '.ev == "context" and (.markers | index("FLOWRYN-MARK-BRIEF"))')

t1=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
wait_settled_after a "$t1" || { pi_verdict partial "inconclusive: first run never settled"; exit 0; }
first_has_brief=$(log_first a ".ev == \"context\" and .t > $t1" | jq -r '(.markers // []) | index("FLOWRYN-MARK-BRIEF") != null')
wait_quiet a 3 60 || true

t2=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word again." "say again")"
wait_settled_after a "$t2" || true
wait_quiet a 3 60 || true

t3=$(now_ms)
pane_prompt "$A" "/compact"
log_wait a 10 ".t > $t3 and (.ev == \"session_before_compact\" or .ev == \"session_compact_failed\")" || pane_key "$A" enter
log_wait a "$PI_RUN_TIMEOUT" ".t > $t3 and (.ev == \"session_compact\" or .ev == \"session_compact_failed\")" || true
compacted=$(log_count a ".ev == \"session_compact\" and .t > $t3")
rebrief_sent=$(log_count a ".ev == \"rebriefing_sent\" and .t > $t3")
sleep 5
rebrief_idle_leak=$(log_count a ".ev == \"context\" and .t > $t3 and (.markers | index(\"FLOWRYN-MARK-REBRIEF-1\"))")

t4=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
wait_settled_after a "$t4" || true
post_ctx=$(log_first a ".ev == \"context\" and .t > $t4")
post_has_rebrief=$(printf '%s' "$post_ctx" | jq -r '(.markers // []) | index("FLOWRYN-MARK-REBRIEF-1") != null')
post_has_brief=$(printf '%s' "$post_ctx" | jq -r '(.markers // []) | index("FLOWRYN-MARK-BRIEF") != null')

wait_quiet a 3 60 || true

# Overflow: does the re-brief reach the retried run, or only the next prompt?
overflow_case() { # <instance> <pane> <marker>
  local inst=$1 pane=$2 marker=$3 t compact t_compact retry_ctx next_ctx deliver
  t=$(now_ms)
  pane_prompt "$pane" "$(scripted "Reply recovered (the first attempt overflows)." "overflow ;; say recovered")"
  wait_settled_after "$inst" "$t" || true
  wait_quiet "$inst" 3 60 || true
  compact=$(log_first "$inst" ".ev == \"session_compact\" and .t > $t")
  t_compact=$(printf '%s' "$compact" | jq -r '.t // empty')
  deliver=$(log_first "$inst" ".ev == \"rebriefing_sent\" and .t > $t" | jq -r '.deliverAs // "none"')
  retry_ctx=""
  [ -n "$t_compact" ] && retry_ctx=$(log_first "$inst" ".ev == \"context\" and .t > $t_compact")
  t=$(now_ms)
  pane_prompt "$pane" "$(scripted "Reply with the single word ok." "say ok")"
  wait_settled_after "$inst" "$t" || true
  next_ctx=$(log_first "$inst" ".ev == \"context\" and .t > $t")
  printf 'compaction=%s deliverAs=%s retried-run-has-rebrief=%s next-prompt-has-rebrief=%s' \
    "$(printf '%s' "${compact:-null}" | jq -r 'if . == null then "none" else "\(.reason)/willRetry=\(.willRetry)" end')" "$deliver" \
    "$(printf '%s' "${retry_ctx:-null}" | jq -r --arg m "$marker" '(.markers // []) | index($m) != null')" \
    "$(printf '%s' "${next_ctx:-null}" | jq -r --arg m "$marker" '(.markers // []) | index($m) != null')"
}
ov_next=$(overflow_case a "$A" FLOWRYN-MARK-REBRIEF-2)
pi_launch b "FLOWRYN_PROBE_REBRIEFING=$REBRIEF" FLOWRYN_PROBE_REBRIEF_DELIVER=auto -- --approve
B=$PANE
wait_quiet b 1 5 || true
ov_auto=$(overflow_case b "$B" FLOWRYN-MARK-REBRIEF-1)

evidence="briefing queued at session_start=$brief_sent, carried while idle=$idle_leak, in first prompt's request=$first_has_brief; compaction ran=$compacted, re-brief queued=$rebrief_sent, carried while idle=$rebrief_idle_leak, in first post-compaction request=$post_has_rebrief (original briefing still present=$post_has_brief); overflow with nextTurn re-brief: $ov_next; overflow with auto (steer on willRetry) re-brief: $ov_auto"
if [ "$compacted" = 0 ]; then
  if [ "$first_has_brief" = true ] && [ "$idle_leak" = 0 ]; then
    pi_verdict partial "startup half confirmed; compaction half inconclusive (no session_compact); $evidence"
  else
    pi_verdict refuted "$evidence"
  fi
elif [ "$first_has_brief" = true ] && [ "$idle_leak" = 0 ] && [ "$post_has_rebrief" = true ]; then
  pi_verdict confirmed "$evidence"
elif [ "$first_has_brief" != true ] && [ "$post_has_rebrief" != true ]; then
  pi_verdict refuted "$evidence"
else
  pi_verdict partial "$evidence"
fi
