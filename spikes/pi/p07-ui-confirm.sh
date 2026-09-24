#!/usr/bin/env bash
# p07-ui-confirm: ctx.ui.confirm() inside the extension's registered
# flowryn_merge tool shows a human prompt in the Pi TUI and returns the answer
# to the tool (design section 7, channel pi-confirm).
#
# Method: ask the model to call flowryn_merge. When the probe logs
# ui_prompt_start (kind confirm), the spike plays the human through the pane:
#   round 1: Enter      (0.87.1 renders confirm as a Yes/No selector, Yes first)
#   round 2: Escape     (cancel; expected answer false)
# The probe logs merge_confirm_answer from inside the tool.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p07-ui-confirm
pi_setup

pi_launch a
A=$PANE

round() { # <task> <key> -> prints "prompt=<yes|no> answer=<value>"
  local task=$1 key=$2 t
  t=$(now_ms)
  pane_prompt "$A" "$(scripted "Call flowryn_merge for $task." "tool flowryn_merge {\"task\":\"$task\"} ;; say merge round finished")"
  if ! log_wait a 120 ".ev == \"ui_prompt_start\" and .kind == \"confirm\" and .t > $t"; then
    echo "prompt=no answer=none tool-called=$(log_count a ".ev == \"merge_confirm_request\" and .t > $t")"
    return
  fi
  sleep 1
  pane_snapshot "$A" "$WORK/a.confirm-$task.txt"
  pane_key "$A" "$key"
  log_wait a 30 ".ev == \"merge_confirm_answer\" and .task == \"$task\"" || true
  wait_settled_after a "$t" 120 || true
  echo "prompt=yes answer=$(log_first a ".ev == \"merge_confirm_answer\" and .task == \"$task\"" | jq -r '.answer')"
}

r1=$(round T17 enter)
wait_quiet a 3 60 || true
r2=$(round T18 escape)

evidence="round1 (Enter/Yes): $r1; round2 (Escape): $r2; hasUI at request=$(log_first a '.ev == "merge_confirm_request"' | jq -r '.hasUI')"
case "$r1|$r2" in
  "prompt=yes answer=true|prompt=yes answer=false") pi_verdict confirmed "$evidence" ;;
  prompt=no*) pi_verdict partial "inconclusive: no confirm prompt appeared (model may not have called the tool); $evidence" ;;
  *) pi_verdict partial "$evidence" ;;
esac
