#!/usr/bin/env bash
# M0 claim (design §7): the hook input carries permission_mode, so the
# PreToolUse approval-attempt record can refuse the harness channel under
# bypassPermissions.
#
# Method: headless `claude -p` runs, one per permission mode, each with a
# per-run --settings file whose hooks log every event. The model runs
# `echo hi` (pre-allowed). The spike reads permission_mode from each event's
# input. No Herdr pane is needed: hook input does not depend on the terminal.
# Auto mode runs on Sonnet: on Haiku a requested auto mode silently falls back
# to default (observed on 2.1.281), which is itself worth knowing.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c09-permission-mode-input
MODEL=${CLAUDE_SPIKE_MODEL:-haiku}
ROWS=()
ok=yes

for mode in default acceptEdits auto bypassPermissions plan; do
  dir=$(spike_workdir "$ID-$mode")
  cat > "$dir/settings.json" <<EOF
{"permissions":{"allow":["Bash(echo *)"]},
 "hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" ss)"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" ups)"}]}],
 "PreToolUse":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" pre)"}]}],
 "PostToolUse":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" post)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" stop)"}]}]
}}
EOF
  model=$MODEL
  [ "$mode" = auto ] && model=${CLAUDE_SPIKE_MODEL_AUTO:-sonnet}
  (cd "$dir" && lab_scrub_env && timeout 120 claude -p --settings "$dir/settings.json" --model "$model" \
    --permission-mode "$mode" "Run the Bash command: echo hi. Then say done." > "$dir/out.txt" 2>&1)
  row=$(jq -rs '[.[] | {e: .event, m: (.input.permission_mode // "absent")}] | group_by(.e) | map("\(.[0].e)=\(map(.m) | unique | join("/"))") | join(" ")' "$dir/events.jsonl" 2>/dev/null)
  ROWS+=("$mode ($model): ${row:-no events}")
  pre=$(jq -rs '[.[] | select(.event == "PreToolUse") | .input.permission_mode] | first // "absent"' "$dir/events.jsonl" 2>/dev/null)
  [ "$mode" = plan ] && continue
  [ "$pre" = "$mode" ] || ok=no
done

verdict=refuted
[ "$ok" = yes ] && verdict=confirmed
spike_verdict "$ID" "$verdict" "$(claude_version)" "$(printf '%s || ' "${ROWS[@]}")"
