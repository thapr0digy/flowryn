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
  pane_prompt "$A" "Use the bash tool to run exactly this command, unchanged, and nothing else: $1"
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
blocked_results=$(log_count a '.ev == "tool_result" and .isError == true and (.text | test("blocked"))')

evidence="control file=$control_file; merge call seen=$merge_seen file=$merge_file; approve call seen=$approve_seen file=$approve_file; tool_call blocked=$blocked_calls; error results with block reason=$blocked_results"
if [ "$merge_seen" = 0 ] || [ "$approve_seen" = 0 ] || [ "$control_file" = absent ]; then
  pi_verdict partial "inconclusive: the model did not issue every requested command; $evidence"
elif [ "$merge_file" = absent ] && [ "$approve_file" = absent ] && [ "$blocked_calls" -ge 2 ]; then
  pi_verdict confirmed "$evidence"
else
  pi_verdict refuted "$evidence"
fi
