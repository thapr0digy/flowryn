#!/usr/bin/env bash
# p08-block-shell: the extension intercepts and blocks a shell (bash) tool
# call whose command matches `flowryn merge` / `flowryn approve`.
#
# Method: three bash calls requested from the model, each creating a file
# only if the command really runs:
#   control:  touch control-ran                              (must run)
#   merge:    touch merge-ran && echo flowryn merge T17      (must be blocked)
#   approve:  touch approve-ran && echo flowryn approve T17  (must be blocked)
# Evidence: the probe's tool_call line (blocked=true), the tool_result
# (isError with the block reason), and the files on disk.
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p08-block-shell
pi_setup

pi_launch a
A=$PANE

ask() { # <command>
  local t
  t=$(now_ms)
  pane_prompt "$A" "$(scripted "Run one bash command." "bash $1 ;; say done")"
  wait_settled_after a "$t" || true
  wait_quiet a 3 60 || true
}

ask "touch control-ran"
ask "touch merge-ran && echo flowryn merge T17"
ask "touch approve-ran && echo flowryn approve T17"

state() { [ -e "$CWD/$1" ] && echo present || echo absent; }
control_file=$(state control-ran)
merge_file=$(state merge-ran)
approve_file=$(state approve-ran)
blocked_calls=$(log_count a '.ev == "tool_call" and .blocked == true')
merge_seen=$(log_count a '.ev == "tool_call" and (.command | test("flowryn merge"))')
approve_seen=$(log_count a '.ev == "tool_call" and (.command | test("flowryn approve"))')
# A blocked call emits no tool_result event; the model sees the block reason in
# the toolResult message, and tool_execution_end reports isError.
blocked_results=$(log_count a '.ev == "message_end" and .role == "toolResult" and (.text | test("blocked"))')
blocked_ends=$(log_count a '.ev == "tool_execution_end" and .isError == true')

evidence="control file=$control_file; merge call seen=$merge_seen file=$merge_file; approve call seen=$approve_seen file=$approve_file; tool_call blocked=$blocked_calls; tool results carrying the block reason=$blocked_results, tool_execution_end isError=$blocked_ends"
if [ "$merge_seen" = 0 ] || [ "$approve_seen" = 0 ] || [ "$control_file" = absent ]; then
  pi_verdict partial "inconclusive: the model did not issue every requested command; $evidence"
elif [ "$merge_file" = absent ] && [ "$approve_file" = absent ] && [ "$blocked_calls" -ge 2 ]; then
  pi_verdict confirmed "$evidence"
else
  pi_verdict refuted "$evidence"
fi
