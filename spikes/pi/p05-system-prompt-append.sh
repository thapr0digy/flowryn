#!/usr/bin/env bash
# p05-system-prompt-append: Pi's equivalent of Claude's --append-system-prompt
# carries the Flowryn style block into the system prompt of one process.
#
# Flag (docs/cli.md, 0.87.1): --append-system-prompt <text|path>, repeatable.
# Method: instance a gets the flag twice (literal text with marker STYLE-TEXT,
# and a file path whose content has marker STYLE-FILE). The probe checks
# ctx.getSystemPrompt() at session_start and event.systemPrompt at
# before_agent_start for both markers. Instance b (no flag) is the control.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p05-system-prompt-append
pi_setup

STYLE_TEXT="FLOWRYN-MARK-STYLE-TEXT Reply in the fewest words that carry the outcome. No preamble, no recap of tool output, no restating the request."
STYLE_FILE="$WORK/style.md"
printf '%s\n' "FLOWRYN-MARK-STYLE-FILE At most 5 lines unless asked for detail; offer \"flowryn show <id>\" instead of pasting." > "$STYLE_FILE"
MARKERS=FLOWRYN-MARK-STYLE-TEXT,FLOWRYN-MARK-STYLE-FILE

pi_launch a FLOWRYN_PROBE_SYSPROMPT_MARKERS=$MARKERS -- --append-system-prompt "$STYLE_TEXT" --append-system-prompt "$STYLE_FILE"
A=$PANE
pi_launch b FLOWRYN_PROBE_SYSPROMPT_MARKERS=$MARKERS

start_a=$(log_first a '.ev == "session_start"' | jq -r '.systemPromptMarkersFound | join(",")')
start_b=$(log_first b '.ev == "session_start"' | jq -r '.systemPromptMarkersFound | join(",")')

t=$(now_ms)
pane_prompt "$A" "$(scripted "Reply with the single word ok." "say ok")"
run_a=none
if wait_settled_after a "$t"; then
  run_a=$(log_first a ".ev == \"before_agent_start\" and .t > $t" | jq -r '.systemPromptMarkersFound | join(",")')
fi

evidence="with flag: session_start markers=[$start_a], per-run system prompt markers=[$run_a]; control without flag: [$start_b]"
if [ "$start_a" = "$MARKERS" ] && [ -z "$start_b" ] && { [ "$run_a" = "$MARKERS" ] || [ "$run_a" = none ]; }; then
  if [ "$run_a" = none ]; then
    pi_verdict partial "per-run check inconclusive (run never settled); $evidence"
  else
    pi_verdict confirmed "$evidence"
  fi
elif [ -z "$start_a" ]; then
  pi_verdict refuted "$evidence"
else
  pi_verdict partial "$evidence"
fi
