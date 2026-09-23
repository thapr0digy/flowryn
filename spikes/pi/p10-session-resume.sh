#!/usr/bin/env bash
# p10-session-resume: the extension captures the session id (and file) at
# session_start, and Pi's resume flag reopens that session in a new process.
#
# Flags (docs/cli.md, 0.87.1): --session <path|id> opens an existing session;
# --session-id <id> opens that exact id or creates it; --session-dir scopes
# storage and lookup (used by every spike).
# Method:
#   1. instance a: capture id/file, teach a codeword, quit
#   2. instance b: pi --session <file of a>; require same id/file, prior
#      entries present, and the codeword recalled
#   3. instance c/d (design option): pi --session-id <preassigned id>, quit,
#      relaunch with the same --session-id; require the id to match and the
#      second process to see the first one's entries
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p10-session-resume
pi_setup

pi_launch a
A=$PANE
start_a=$(log_first a '.ev == "session_start"')
id_a=$(printf '%s' "$start_a" | jq -r '.sessionId // empty')
file_a=$(printf '%s' "$start_a" | jq -r '.sessionFile // empty')
t=$(now_ms)
pane_prompt "$A" "Remember this codeword for later: FLOWRYN-MARK-R10. Reply with the single word ok."
wait_settled_after a "$t" || { pi_verdict partial "inconclusive: first run never settled"; exit 0; }
pi_stop a "$A"
[ -n "$file_a" ] && [ -e "$file_a" ] || { pi_verdict refuted "session file not captured or not on disk: id='$id_a' file='$file_a'"; exit 0; }

pi_launch b -- --session "$file_a"
B=$PANE
start_b=$(log_first b '.ev == "session_start"')
id_b=$(printf '%s' "$start_b" | jq -r '.sessionId // empty')
file_b=$(printf '%s' "$start_b" | jq -r '.sessionFile // empty')
reason_b=$(printf '%s' "$start_b" | jq -r '.reason // empty')
entries_b=$(printf '%s' "$start_b" | jq -r '.entryCount // 0')
t=$(now_ms)
pane_prompt "$B" "What codeword did I ask you to remember? Reply with only the codeword."
recalled=no
if wait_settled_after b "$t"; then
  log_has b ".ev == \"message_end\" and .role == \"assistant\" and .t > $t and (.markers | index(\"FLOWRYN-MARK-R10\"))" && recalled=yes
fi
pi_stop b "$B"

FIXED="flowryn-p10-$(date +%s)"
pi_launch c -- --session-id "$FIXED"
C=$PANE
id_c=$(log_first c '.ev == "session_start"' | jq -r '.sessionId // empty')
t=$(now_ms)
pane_prompt "$C" "Reply with the single word ok."
wait_settled_after c "$t" || true
pi_stop c "$C"
pi_launch d -- --session-id "$FIXED"
start_d=$(log_first d '.ev == "session_start"')
id_d=$(printf '%s' "$start_d" | jq -r '.sessionId // empty')
entries_d=$(printf '%s' "$start_d" | jq -r '.entryCount // 0')

evidence="captured id=$id_a file=$file_a; resumed with --session <file>: id=$id_b same-file=$([ "$file_b" = "$file_a" ] && echo yes || echo no) reason=$reason_b entries=$entries_b codeword recalled=$recalled; preassigned --session-id $FIXED: first id=$id_c, relaunch id=$id_d entries=$entries_d"
if [ -n "$id_a" ] && [ "$id_b" = "$id_a" ] && [ "$entries_b" -gt 0 ] && [ "$recalled" = yes ]; then
  pi_verdict confirmed "$evidence"
elif [ -n "$id_a" ] && [ "$id_b" = "$id_a" ]; then
  pi_verdict partial "$evidence"
else
  pi_verdict refuted "$evidence"
fi
