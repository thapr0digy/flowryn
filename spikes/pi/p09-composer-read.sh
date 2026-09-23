#!/usr/bin/env bash
# p09-composer-read: the extension can read the composer, so a Pi P0 may start
# a turn only when the leader is idle, the composer is empty and there has been
# no terminal input for 60 s (design sections 5 and 9).
#
# APIs (0.87.1 types.d.ts ExtensionUIContext): getEditorText(),
# onTerminalInput(handler). No model call is needed.
# Method:
#   1. type a draft (no Enter); probe read_editor must return it
#   2. clear with Ctrl+U; read_editor must return ""
#   3. wait 62 s untouched; probe "activity" must report inactive=true
#   4. type one character; "activity" must report inactive=false
set -u
. "$(dirname "$0")/lib/pi-spike.sh"
pi_require p09-composer-read
pi_setup

pi_launch a
A=$PANE
sleep 2

DRAFT="draft FLOWRYN-DRAFT-9 not sent"
pane_type "$A" "$DRAFT"
sleep 1.5
read1=$(ctl_now a '{"op":"read_editor"}')
text1=$(printf '%s' "$read1" | jq -r '.editorText // "<null>"')
api_missing=$(log_count a '.ev == "editor_api_missing"')

pane_key "$A" ctrl+u
sleep 1
text2=$(ctl_now a '{"op":"read_editor"}' | jq -r '.editorText // "<null>"')
if [ -n "$text2" ] && [ "$text2" != "<null>" ]; then
  ctl_now a '{"op":"set_editor","text":""}' >/dev/null   # fallback clear if ctrl+u is not Pi's clear key
  text2="cleared-by-probe"
fi

sleep 62
act1=$(ctl_now a '{"op":"activity","thresholdMs":60000}')
pane_type "$A" "x"
sleep 1
act2=$(ctl_now a '{"op":"activity","thresholdMs":60000}')
ctl_now a '{"op":"set_editor","text":""}' >/dev/null || true

inactive1=$(printf '%s' "$act1" | jq -r '.inactive')
inactive2=$(printf '%s' "$act2" | jq -r '.inactive')
evidence="read typed draft='$text1' (expected '$DRAFT'); after Ctrl+U='$text2'; after 62 s untouched: $(printf '%s' "$act1" | jq -c '{inactive, editorEmpty, msSinceTerminalInput, isIdle, inputListener}'); after one keystroke: $(printf '%s' "$act2" | jq -c '{inactive, editorEmpty, msSinceTerminalInput}')"
if [ "$api_missing" -gt 0 ] || [ "$text1" = "<null>" ]; then
  pi_verdict refuted "getEditorText unavailable; $evidence"
elif [ "$text1" = "$DRAFT" ] && [ "$inactive1" = true ] && [ "$inactive2" = false ]; then
  pi_verdict confirmed "$evidence"
else
  pi_verdict partial "$evidence"
fi
