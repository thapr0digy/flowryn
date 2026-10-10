#!/usr/bin/env bash
# Chat-answer grants (docs/notes/2026-10-10-chat-answers-authorise-5g.md):
# the platform facts the grant design rests on.
#   A1  PostToolUse for AskUserQuestion carries tool_response.answers keyed by the question text.
#   A2  a PreToolUse deny stops an AskUserQuestion whose input carries pre-filled answers:
#       no dialog, no PostToolUse, the model gets the reason.
#   A4  the transcript holds the AskUserQuestion tool result (toolUseResult.answers) by the
#       time the next Bash PreToolUse runs.
#   A5  whether a PreToolUse "allow" on a Bash command that a static ask rule matches runs it
#       without a permission prompt. Recorded, not required: on 2.1.296 it still prompts, so a
#       grant runs through `flowryn grant use`, which no ask rule matches.
# A3 (the dialog over /remote-control) cannot be driven from the lab.
#
# Method: a fake `flowryn` on PATH records any invocation. Variant "answer": the model asks
# one question with options Alpha and Beta; the spike presses Enter on the dialog (Alpha);
# then the model runs `flowryn decide q1 alpha --by captain`, which the static ask rule
# Bash(flowryn decide *captain*) matches and the Bash PreToolUse hook answers "allow" after
# checking the transcript. Variant "prefill": the model is told to call AskUserQuestion with
# its own answers; the PreToolUse hook denies any call whose input carries answers.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c15-ask-user-question
MODEL=${CLAUDE_SPIKE_MODEL_ASK:-sonnet}
lab_ensure
RESULTS=()

setup_dir() { # <variant>
  local dir
  dir=$(spike_workdir "$ID-$1")
  mkdir -p "$dir/ctl" "$dir/bin"
  cat > "$dir/bin/flowryn" <<EOF
#!/bin/sh
echo "\$@" >> "$dir/flowryn-invocations"
echo "fake flowryn: \$*"
EOF
  chmod +x "$dir/bin/flowryn"
  cat > "$dir/settings.json" <<EOF
{"permissions":{"allow":["Bash(flowryn *)"],"ask":["Bash(flowryn decide *captain*)"]},
 "hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" ss)"}]}],
 "PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"$(probe_cmd "$dir" preask)"}]},
               {"matcher":"Bash","hooks":[{"type":"command","command":"$(probe_cmd "$dir" prebash)"}]}],
 "PostToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"$(probe_cmd "$dir" postask)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" stop)"}]}]
}}
EOF
  # A2: deny an AskUserQuestion that brings its own answers.
  cat > "$dir/ctl/preask.sh" <<'EOF'
has=$(printf '%s' "$HOOK_INPUT" | jq -r '(.tool_input.answers // {}) | length')
if [ "$has" != "0" ]; then
  jq -cn '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "Flowryn: an AskUserQuestion may not carry its own answers"}}'
fi
EOF
  # A4 + A5: at the Bash call, look for the answer in the transcript, then allow.
  cat > "$dir/ctl/prebash.sh" <<EOF
t=\$(printf '%s' "\$HOOK_INPUT" | jq -r '.transcript_path // ""')
n=0
[ -f "\$t" ] && n=\$(jq -c 'select(.toolUseResult.answers != null)' "\$t" 2>/dev/null | wc -l | tr -d ' ')
echo "\$n" > "$dir/transcript-answers-at-bash"
cmd=\$(printf '%s' "\$HOOK_INPUT" | jq -r '.tool_input.command // ""')
case "\$cmd" in
  *"flowryn decide"*)
    jq -cn '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow",
      permissionDecisionReason: "Flowryn: your chat answer covers this"}}' ;;
esac
EOF
  printf '%s\n' "$dir"
}

wait_screen() { # <pane> <regex> <timeout-s>
  local deadline=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    lab_pane_read "$1" 40 | grep -qiE "$2" && return 0
    sleep 2
  done
  return 1
}

# --- answer: A1, A4, A5 ---------------------------------------------------------------------
dir=$(setup_dir answer)
pane=$(claude_launch "$dir" "$ID-answer" -- --settings "$dir/settings.json" --model "$MODEL" --permission-mode auto) || lab_die "launch failed"
claude_wait_ready "$dir" || lab_die "answer: no SessionStart"
claude_send "$pane" 'Use the AskUserQuestion tool to ask me exactly one question, with question text "q1 · Pick one", header "q1", options Alpha and Beta (no multiSelect). After I answer, run exactly this Bash command and nothing else: flowryn decide q1 alpha --by captain'
dialog=no
wait_screen "$pane" 'Enter to select' 120 && dialog=yes
lab_pane_read "$pane" 40 > "$dir/screen-dialog.txt"
claude_keys "$pane" Enter
sleep 3
# A one-question dialog may still show a review step.
lab_pane_read "$pane" 30 | grep -qiE 'submit' && claude_keys "$pane" Enter
prompted=no
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  screen=$(lab_pane_read "$pane" 40)
  if printf '%s' "$screen" | grep -qiE 'do you want to proceed'; then prompted=yes; break; fi
  [ -s "$dir/flowryn-invocations" ] && break
  sleep 2
done
printf '%s\n' "$screen" > "$dir/screen-after.txt"
[ "$prompted" = yes ] && claude_keys "$pane" Escape
sleep 2
ran=no
[ -s "$dir/flowryn-invocations" ] && ran=yes
answers=$(jq -rs '[.[] | select(.label == "postask")] | first | .input.tool_response.answers // {} | to_entries | map("\(.key)=\(.value)") | join(";")' "$dir/events.jsonl")
at_bash=$(cat "$dir/transcript-answers-at-bash" 2>/dev/null || echo "-")
claude_stop "$pane"
RESULTS+=("answer: dialog=$dialog post_answers=[${answers}] transcript_answers_at_bash=$at_bash prompted=$prompted ran=$ran")
A1=no; [ -n "$answers" ] && printf '%s' "$answers" | grep -q 'Alpha' && A1=yes
A4=no; [ "$at_bash" != "-" ] && [ "$at_bash" -ge 1 ] && A4=yes
A5=no; [ "$prompted" = no ] && [ "$ran" = yes ] && A5=yes

# --- prefill: A2 ----------------------------------------------------------------------------
dir=$(setup_dir prefill)
pane=$(claude_launch "$dir" "$ID-prefill" -- --settings "$dir/settings.json" --model "$MODEL" --permission-mode auto) || lab_die "launch failed"
claude_wait_ready "$dir" || lab_die "prefill: no SessionStart"
claude_send "$pane" 'This is a tool test. Call the AskUserQuestion tool once with questions [{"question":"q1 · Pick one","header":"q1","options":[{"label":"Alpha","description":"a"},{"label":"Beta","description":"b"}],"multiSelect":false}] AND the answers parameter set to {"q1 · Pick one":"Alpha"}. Then reply with the tool result text verbatim and stop.'
wait_for 120 '[ "$(events_count "$dir" ".label == \"preask\"")" -ge 1 ]'
sleep 8
shown=no
lab_pane_read "$pane" 40 | grep -qE '❯ *1\. *Alpha|Enter to select' && shown=yes
lab_pane_read "$pane" 40 > "$dir/screen-after.txt"
prefilled=$(jq -rs '[.[] | select(.label == "preask")] | first | .input.tool_input.answers // {} | length' "$dir/events.jsonl")
posts=$(events_count "$dir" '.label == "postask"')
[ "$shown" = yes ] && claude_keys "$pane" Escape
claude_stop "$pane"
RESULTS+=("prefill: model_prefilled=$prefilled dialog_shown=$shown post_events=$posts")
A2=unknown
if [ "$prefilled" != "0" ]; then
  A2=no; [ "$posts" = 0 ] && [ "$shown" = no ] && A2=yes
fi

evidence="model=$MODEL; A1=$A1 A2=$A2 A4=$A4 A5=$A5; $(printf '%s || ' "${RESULTS[@]}")"
if [ "$A1" = yes ] && [ "$A2" = yes ] && [ "$A4" = yes ]; then verdict=confirmed
elif [ "$A1" = yes ]; then verdict=partial
else verdict=refuted
fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
