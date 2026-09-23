#!/usr/bin/env bash
# p04-agent-settled: agent_settled fires exactly once per run, including
# abort, retry, error and compaction.
#
# Scenarios (each counts agent_settled lines from its start until the
# instance is quiet for 5-10 s):
#   S1 normal run
#   S2 abort: probe ctx.abort() during a bash sleep
#   S3 compaction during a run: probe ctx.compact() during a bash sleep
#      (0.87.1 AgentSession.compact() aborts the run first, then compacts)
#   S4 manual /compact while idle (informational: not a run, expected 0)
#   S5 error with automatic retry: a second instance whose provider baseUrl the
#      probe points at a closed port, so every attempt fails to connect
#   S6 threshold compaction inside a run (opt-in: FLOWRYN_P04_THRESHOLD=1);
#      a scratch project setting lowers the compaction threshold to ~3k tokens
# Instance "a" runs in a scratch cwd whose .pi/settings.json sets
# compaction.keepRecentTokens=1 so a short session has something to compact;
# --approve trusts that scratch project setting for this process only.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p04-agent-settled
pi_setup

mkdir -p "$CWD/.pi"
printf '%s\n' '{"compaction":{"keepRecentTokens":1}}' > "$CWD/.pi/settings.json"

settled_since() { log_count "$1" ".ev == \"agent_settled\" and .t > $2"; }
starts_since() { log_count "$1" ".ev == \"agent_start\" and .t > $2"; }
outcome_since() { log_last "$1" ".ev == \"agent_before_settle\" and .t > $2" | jq -r '.outcome // "none"'; }

pi_launch a -- --approve
A=$PANE
results=()
inconclusive=()

# S1 normal
t=$(now_ms)
pane_prompt "$A" "Reply with the single word ok."
if wait_settled_after a "$t"; then
  wait_quiet a 5 60 || true
  results+=("S1 normal: settled=$(settled_since a "$t") starts=$(starts_since a "$t") outcome=$(outcome_since a "$t")")
  s1=$(settled_since a "$t")
else
  inconclusive+=("S1 never settled"); s1=x
fi

# S2 abort
t=$(now_ms)
ctl a '{"op":"abort","when":"tool_execution_start"}'
pane_prompt "$A" "Use the bash tool to run exactly: sleep 20 . Then reply with the single word done."
if wait_settled_after a "$t" 90; then
  wait_quiet a 5 60 || true
  s2=$(settled_since a "$t")
  results+=("S2 abort: settled=$s2 starts=$(starts_since a "$t") outcome=$(outcome_since a "$t") abort-executed=$(log_count a ".ev == \"ctl_exec\" and .op == \"abort\" and .t > $t")")
else
  inconclusive+=("S2 never settled"); s2=x
fi

# S3 compaction during a run
t=$(now_ms)
ctl a '{"op":"compact","when":"tool_execution_start"}'
pane_prompt "$A" "Use the bash tool to run exactly: sleep 8 . Then reply with the single word done."
log_wait a "$PI_RUN_TIMEOUT" ".t > $t and (.ev == \"session_compact\" or .ev == \"session_compact_failed\" or .ev == \"compact_error\")" || true
wait_quiet a 10 "$PI_RUN_TIMEOUT" || true
s3=$(settled_since a "$t")
s3_compacted=$(log_count a ".ev == \"session_compact\" and .t > $t")
results+=("S3 compact-in-run: settled=$s3 starts=$(starts_since a "$t") compacted=$s3_compacted compact-error=$(log_last a ".ev == \"compact_error\" and .t > $t" | jq -r '.error // "none"')")

# S4 manual /compact while idle (informational)
t=$(now_ms)
pane_prompt "$A" "/compact"
if ! log_wait a 10 ".t > $t and (.ev == \"session_before_compact\" or .ev == \"session_compact_failed\")"; then
  pane_key "$A" enter   # a slash-command completion popup can swallow the first Enter
fi
log_wait a "$PI_RUN_TIMEOUT" ".t > $t and (.ev == \"session_compact\" or .ev == \"session_compact_failed\")" || true
sleep 10
results+=("S4 idle /compact (informational): settled=$(settled_since a "$t") compacted=$(log_count a ".ev == \"session_compact\" and .t > $t")")

# S5 error with automatic retry
pi_launch e FLOWRYN_PROBE_PROVIDER_BASEURL=http://127.0.0.1:9
E=$PANE
t=$(now_ms)
pane_prompt "$E" "Reply with the single word ok."
if wait_settled_after e "$t" 300; then
  wait_quiet e 10 120 || true
  s5=$(settled_since e "$t")
  results+=("S5 error+retry: settled=$s5 starts=$(starts_since e "$t") outcome=$(outcome_since e "$t") last-error=$(log_last e '.ev == "message_end" and .role == "assistant"' | jq -r '.errorMessage // "none"' | cut -c1-80)")
else
  inconclusive+=("S5 never settled"); s5=x
fi

# S6 threshold compaction inside a run (opt-in)
s6=skip
if [ "${FLOWRYN_P04_THRESHOLD:-0}" = 1 ]; then
  window=$(log_first a '.ev == "session_start"' | jq -r '.model.contextWindow // empty')
  if [ -n "$window" ]; then
    TDIR="$WORK/cwd-threshold"
    mkdir -p "$TDIR/.pi"
    jq -n --argjson r "$((window - 3000))" '{compaction: {keepRecentTokens: 1, reserveTokens: $r}}' > "$TDIR/.pi/settings.json"
    pi_launch --cwd "$TDIR" t -- --approve
    T=$PANE
    t=$(now_ms)
    pane_prompt "$T" "Reply with the word ok, then one sentence about the sea."
    wait_settled_after t "$t" "$PI_RUN_TIMEOUT" || ctl_now t '{"op":"abort"}' >/dev/null
    wait_quiet t 10 120 || ctl_now t '{"op":"abort"}' >/dev/null
    s6=$(settled_since t "$t")
    results+=("S6 threshold: settled=$s6 compactions=$(log_count t ".ev == \"session_compact\" and .t > $t") reasons=$(log_count t ".ev == \"session_compact\" and .reason == \"threshold\"")")
  else
    results+=("S6 threshold: skipped, context window unknown")
  fi
fi

evidence=$(printf '%s; ' "${results[@]}" ${inconclusive[@]+"${inconclusive[@]}"})
bad=0
for n in "$s1" "$s2" "$s3" "$s5" ${s6/skip/}; do
  case "$n" in
    1) ;;
    x) ;;
    *) bad=1 ;;
  esac
done
if [ "$bad" = 1 ]; then
  pi_verdict refuted "$evidence"
elif [ "${#inconclusive[@]}" -gt 0 ] || [ "$s3_compacted" = 0 ]; then
  pi_verdict partial "$evidence"
else
  pi_verdict confirmed "$evidence"
fi
