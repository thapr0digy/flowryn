#!/usr/bin/env bash
# Chat answers survive background notices (docs/notes/2026-10-17-chat-answers-survive-es.md):
# the platform facts the hold rests on.
#   N1  a background notice queued while an AskUserQuestion dialog is open is taken into the
#       turn after the answer, and UserPromptSubmit runs for it.
#   N2  that hook's prompt is a notification prompt by src/policy/notifications.ts (queued
#       text or Claude's rendered reminder), so the leader's hook holds the grant.
#   N3  by the next Bash PreToolUse, the transcript holds the notice as a queued_command (or a
#       user entry) with origin task-notification, after the answer's tool_result line.
#
# Method: the model starts a background Bash command (sleep 15), then asks one question at
# once. The spike leaves the dialog open until the command has finished (its notice queues),
# presses Enter, and the model then runs one Bash command. Probes log every hook input; the
# Bash PreToolUse probe copies the transcript as it is at that moment.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c16-notice-mid-answer
MODEL=${CLAUDE_SPIKE_MODEL_ASK:-sonnet}
ROOT=$(git -C "$SPIKES_ROOT" rev-parse --show-toplevel)
lab_ensure

dir=$(spike_workdir "$ID")
mkdir -p "$dir/ctl"
cat > "$dir/settings.json" <<EOF
{"permissions":{"allow":["Bash(sleep *)","Bash(echo *)"]},
 "hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" prompt)"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$(probe_cmd "$dir" prebash)"}]}],
 "PostToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"$(probe_cmd "$dir" postask)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" stop)"}]}]
}}
EOF
cat > "$dir/ctl/prebash.sh" <<EOF
t=\$(printf '%s' "\$HOOK_INPUT" | jq -r '.transcript_path // ""')
cmd=\$(printf '%s' "\$HOOK_INPUT" | jq -r '.tool_input.command // ""')
case "\$cmd" in *after-answer*) [ -f "\$t" ] && cp "\$t" "$dir/transcript-at-bash.jsonl" ;; esac
EOF

wait_screen() { # <pane> <regex> <timeout-s>
  local deadline=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    lab_pane_read "$1" 40 | grep -qiE "$2" && return 0
    sleep 2
  done
  return 1
}

pane=$(claude_launch "$dir" "$ID" -- --settings "$dir/settings.json" --model "$MODEL" --permission-mode auto) || lab_die "launch failed"
claude_wait_ready "$dir" || lab_die "no SessionStart"
claude_send "$pane" 'Do exactly this, in order, with nothing else: 1) run the Bash command `sleep 15` with run_in_background true; 2) right away, without waiting for it, use the AskUserQuestion tool to ask one question with question text "q1 · Pick one", header "q1", options Alpha and Beta; 3) after I answer, run the Bash command `echo after-answer` and stop.'
dialog=no
wait_screen "$pane" 'Enter to select' 120 && dialog=yes
# Let the background command finish while the dialog is open, so its notice queues.
sleep 25
lab_pane_read "$pane" 40 > "$dir/screen-dialog.txt"
claude_keys "$pane" Enter
sleep 3
lab_pane_read "$pane" 30 | grep -qiE 'submit' && claude_keys "$pane" Enter
wait_for 90 '[ -s "$dir/transcript-at-bash.jsonl" ]'
sleep 3
claude_stop "$pane"

answered_at=$(jq -rs '[.[] | select(.label == "postask")] | first | .t // 0' "$dir/events.jsonl")
jq -c --argjson after "$answered_at" 'select(.label == "prompt" and .t >= $after) | .input.prompt' "$dir/events.jsonl" > "$dir/prompts-after-answer.jsonl"
prompts=$(wc -l < "$dir/prompts-after-answer.jsonl" | tr -d ' ')
classified=$(cd "$ROOT" && bun -e '
import { readFileSync } from "node:fs";
import { isNotificationPrompt } from "./src/policy/notifications.ts";
const lines = readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.length > 0);
console.log(lines.map((l) => (isNotificationPrompt(JSON.parse(l)) ? "notice" : "you")).join(","));
' "$dir/prompts-after-answer.jsonl")
senders="-"
if [ -s "$dir/transcript-at-bash.jsonl" ]; then
  senders=$(cd "$ROOT" && bun -e '
import { readFileSync } from "node:fs";
import { countSenders } from "./src/policy/notifications.ts";
const lines = readFileSync(process.argv[1], "utf8").split("\n");
const answer = lines.findIndex((l) => l.includes("toolUseResult") && l.includes("answers"));
const c = countSenders(answer < 0 ? [] : lines.slice(answer + 1));
console.log(`answer_line=${answer} you=${c.you} notices=${c.notices}`);
' "$dir/transcript-at-bash.jsonl")
fi

N1=no; [ "$prompts" -ge 1 ] && N1=yes
N2=no; [ -n "$classified" ] && ! printf '%s' "$classified" | grep -q you && N2=yes
N3=no; printf '%s' "$senders" | grep -qE 'you=0 notices=[1-9]' && N3=yes
evidence="model=$MODEL; dialog=$dialog N1=$N1 N2=$N2 N3=$N3; prompts_after_answer=$prompts classified=[$classified] at_bash: $senders"
if [ "$N1" = yes ] && [ "$N2" = yes ] && [ "$N3" = yes ]; then verdict=confirmed
elif [ "$N1" = no ]; then verdict=refuted
else verdict=partial
fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
