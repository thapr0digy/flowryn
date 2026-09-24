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
#   S5 error with automatic retry: the scripted provider fails every attempt
#      with a retryable 503, so Pi retries and then gives up with an error
#   S6 threshold compaction inside a run: the scripted provider reports usage
#      near its 32k context window on a tool call, so Pi compacts between turns
#   S7 overflow recovery: the scripted provider fails once with
#      context_length_exceeded, so Pi compacts and retries as a fresh run
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
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
if wait_settled_after a "$t"; then
  wait_quiet a 5 60 || true
  results+=("S1 normal: settled=$(settled_since a "$t") starts=$(starts_since a "$t") outcome=$(outcome_since a "$t")")
  s1=$(settled_since a "$t")
else
  inconclusive+=("inconclusive: S1 never settled"); s1=x
fi

# S2 abort
t=$(now_ms)
ctl a '{"op":"abort","when":"tool_execution_start"}'
pane_prompt "$A" "$(scripted "Use the bash tool to run: sleep 20. Then reply with the single word done." "bash sleep 20 ;; say done")"
if wait_settled_after a "$t" 90; then
  wait_quiet a 5 60 || true
  s2=$(settled_since a "$t")
  results+=("S2 abort: settled=$s2 starts=$(starts_since a "$t") outcome=$(outcome_since a "$t") abort-executed=$(log_count a ".ev == \"ctl_exec\" and .op == \"abort\" and .t > $t")")
else
  inconclusive+=("inconclusive: S2 never settled"); s2=x
fi

# S3 compaction during a run
t=$(now_ms)
ctl a '{"op":"compact","when":"tool_execution_start"}'
pane_prompt "$A" "$(scripted "Use the bash tool to run: sleep 8. Then reply with the single word done." "bash sleep 8 ;; say done")"
log_wait a "$PI_RUN_TIMEOUT" ".t > $t and (.ev == \"session_compact\" or .ev == \"session_compact_failed\" or .ev == \"compact_error\")" || true
wait_quiet a 10 "$PI_RUN_TIMEOUT" || true
s3=$(settled_since a "$t")
s3_compacted=$(log_count a ".ev == \"session_compact\" and .t > $t")
results+=("S3 compact-in-run: settled=$s3 starts=$(starts_since a "$t") compacted=$s3_compacted compact-error=$(log_last a ".ev == \"compact_error\" and .t > $t" | jq -r '.error // "none"')")

# S4 manual /compact while idle (informational). One short turn first, so
# there is something new to compact after S3.
t=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
wait_settled_after a "$t" || true
wait_quiet a 3 60 || true
t=$(now_ms)
pane_prompt "$A" "/compact"
if ! log_wait a 10 ".t > $t and (.ev == \"session_before_compact\" or .ev == \"session_compact_failed\")"; then
  pane_key "$A" enter   # a slash-command completion popup can swallow the first Enter
fi
log_wait a "$PI_RUN_TIMEOUT" ".t > $t and (.ev == \"session_compact\" or .ev == \"session_compact_failed\")" || true
sleep 10
results+=("S4 idle /compact (informational): settled=$(settled_since a "$t") compacted=$(log_count a ".ev == \"session_compact\" and .t > $t")")

if [ -n "${FLOWRYN_PI_MODEL:-}" ]; then
  # S5-S7 need failures only the scripted provider can produce on demand.
  s5=skip; s6=skip; s7=skip; s6_compacted=skip; s7_compacted=skip
  results+=("S5-S7 skipped: real-model pass (they need scripted provider failures)")
else
  # S5 error with automatic retry (a plain cwd: no project settings, so no trust gate)
  mkdir -p "$WORK/cwd-error"
  pi_launch --cwd "$WORK/cwd-error" e
  E=$PANE
  t=$(now_ms)
  pane_prompt "$E" "$(scripted "Reply ok (the provider fails every attempt)." "error 503 Service Unavailable: overloaded")"
  if wait_settled_after e "$t" 300; then
    wait_quiet e 10 120 || true
    s5=$(settled_since e "$t")
    results+=("S5 error+retry: settled=$s5 starts=$(starts_since e "$t") provider attempts=$(jq -s "[.[] | select(.t > $t)] | length" "$(provlog e)") outcome=$(outcome_since e "$t") last-error=$(log_last e '.ev == "message_end" and .role == "assistant"' | jq -r '.errorMessage // "none"' | cut -c1-80)")
  else
    inconclusive+=("inconclusive: S5 never settled"); s5=x
  fi

  # S6 threshold compaction inside a run
  TDIR="$WORK/cwd-threshold"
  mkdir -p "$TDIR/.pi"
  printf '%s\n' '{"compaction":{"keepRecentTokens":1}}' > "$TDIR/.pi/settings.json"
  pi_launch --cwd "$TDIR" t -- --approve
  T=$PANE
  t=$(now_ms)
  pane_prompt "$T" "$(scripted "Run echo fill, then reply done (the first reply reports a near-full context)." "!bash echo fill ;; say done")"
  if wait_settled_after t "$t"; then
    wait_quiet t 10 120 || true
    s6=$(settled_since t "$t")
    s6_compacted=$(log_count t ".ev == \"session_compact\" and .t > $t")
    results+=("S6 threshold: settled=$s6 starts=$(starts_since t "$t") compactions=$s6_compacted reasons=$(log_last t ".ev == \"session_compact\" and .t > $t" | jq -r '"\(.reason)/willRetry=\(.willRetry)"') final reply=$(log_last t '.ev == "message_end" and .role == "assistant"' | jq -r '.text')")
  else
    inconclusive+=("inconclusive: S6 never settled"); s6=x; s6_compacted=0
  fi

  # S7 overflow recovery (compact, then retry as a fresh run)
  t=$(now_ms)
  pane_prompt "$T" "$(scripted "Reply recovered (the first attempt overflows)." "overflow ;; say recovered")"
  if wait_settled_after t "$t"; then
    wait_quiet t 10 120 || true
    s7=$(settled_since t "$t")
    s7_compacted=$(log_count t ".ev == \"session_compact\" and .t > $t")
    results+=("S7 overflow: settled=$s7 starts=$(starts_since t "$t") compactions=$s7_compacted reasons=$(log_last t ".ev == \"session_compact\" and .t > $t" | jq -r '"\(.reason)/willRetry=\(.willRetry)"') outcome=$(outcome_since t "$t") final reply=$(log_last t '.ev == "message_end" and .role == "assistant"' | jq -r '.text')")
  else
    inconclusive+=("inconclusive: S7 never settled"); s7=x; s7_compacted=0
  fi
fi

evidence=$(printf '%s; ' "${results[@]}" ${inconclusive[@]+"${inconclusive[@]}"})
bad=0
for n in "$s1" "$s2" "$s3" "$s5" "$s6" "$s7"; do
  case "$n" in
    1) ;;
    x|skip) ;;
    *) bad=1 ;;
  esac
done
if [ "$bad" = 1 ]; then
  pi_verdict refuted "$evidence"
elif [ "${#inconclusive[@]}" -gt 0 ] || [ "$s3_compacted" = 0 ] || [ "$s6_compacted" = 0 ] || [ "$s7_compacted" = 0 ]; then
  pi_verdict partial "$evidence"
else
  pi_verdict confirmed "$evidence"
fi
