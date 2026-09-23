#!/usr/bin/env bash
# M0 claim (design §7, Claude leader approval channel): in --permission-mode
# auto inside a Herdr pane, both the ask rule Bash(flowryn merge *) and a
# PreToolUse hook returning permissionDecision "ask" put a confirmation prompt
# in front of you; the hook input carries permission_mode. Also probes the
# open question in §7: whether an ask rule still prompts under bypassPermissions.
#
# Method: a fake `flowryn` on PATH records any invocation. For each variant a
# fresh session is asked to run exactly `flowryn merge T17`. The spike polls
# the pane for a permission prompt, then presses Escape to decline, and checks
# whether the fake flowryn ran.
#   rule-auto    ask rule only, auto mode
#   hook-auto    PreToolUse ask only, auto mode
#   rule-bypass  ask rule only, bypassPermissions
#   hook-bypass  PreToolUse ask only, bypassPermissions
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c08-ask-in-auto
MODEL=${CLAUDE_SPIKE_MODEL_ASK:-sonnet}
lab_ensure
RESULTS=()

run_variant() { # <variant> <mode> <use-rule> <use-hook>
  local variant=$1 mode=$2 rule=$3 hook=$4 dir pane prompted=no ran=no screen pm
  dir=$(spike_workdir "$ID-$variant")
  mkdir -p "$dir/ctl" "$dir/bin"
  cat > "$dir/bin/flowryn" <<EOF
#!/bin/sh
echo "\$@" >> "$dir/flowryn-invocations"
echo "fake flowryn: \$*"
EOF
  chmod +x "$dir/bin/flowryn"
  local ask='[]'
  [ "$rule" = yes ] && ask='["Bash(flowryn merge *)"]'
  local pre=''
  [ "$hook" = yes ] && pre=",\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"$(probe_cmd "$dir" pre)\"}]}]"
  [ "$hook" = no ] && pre=",\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"$(probe_cmd "$dir" prelog)\"}]}]"
  cat > "$dir/settings.json" <<EOF
{"permissions":{"ask":$ask},
 "hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" ss)"}]}]$pre,
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$dir" stop)"}]}]
}}
EOF
  cat > "$dir/ctl/pre.sh" <<'EOF'
cmd=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // ""')
case "$cmd" in
  *"flowryn merge"*)
    jq -cn '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: "Flowryn: merging needs your confirmation"}}' ;;
esac
EOF
  pane=$(claude_launch "$dir" "$ID-$variant" -- --settings "$dir/settings.json" --model "$MODEL" --permission-mode "$mode") || lab_die "launch failed"
  claude_wait_ready "$dir" || { RESULTS+=("$variant: no SessionStart"); return; }
  claude_send "$pane" "Run exactly this Bash command and nothing else: flowryn merge T17"
  local deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    screen=$(lab_pane_read "$pane" 40)
    if printf '%s' "$screen" | grep -qiE 'do you want to proceed'; then
      prompted=yes
      break
    fi
    [ -s "$dir/flowryn-invocations" ] && break
    [ "$(events_count "$dir" '.event == "Stop"')" -ge 1 ] && break
    sleep 2
  done
  local snippet
  printf '%s\n' "$screen" > "$dir/screen-at-prompt.txt"
  snippet=$(printf '%s' "$screen" | grep -iE 'proceed|1\. yes|confirm|mode on' | head -n 4 | tr '\n' ' ' | tr -s ' ' | cut -c1-200)
  claude_keys "$pane" Escape
  sleep 2
  [ -s "$dir/flowryn-invocations" ] && ran=yes
  pm=$(jq -rs '[.[] | select(.event == "PreToolUse")] | first | .input.permission_mode // "?"' "$dir/events.jsonl")
  claude_stop "$pane"
  RESULTS+=("$variant: prompted=$prompted ran=$ran hook_permission_mode=$pm screen: ${snippet:-<none>}")
  eval "PROMPTED_${variant//-/_}=$prompted; RAN_${variant//-/_}=$ran"
}

run_variant rule-auto auto yes no
run_variant hook-auto auto no yes
run_variant rule-bypass bypassPermissions yes no
run_variant hook-bypass bypassPermissions no yes

evidence="model=$MODEL; $(printf '%s || ' "${RESULTS[@]}")"
if [ "${PROMPTED_rule_auto:-no}" = yes ] && [ "${PROMPTED_hook_auto:-no}" = yes ] \
  && [ "${RAN_rule_auto:-yes}" = no ] && [ "${RAN_hook_auto:-yes}" = no ]; then
  verdict=confirmed
elif [ "${PROMPTED_rule_auto:-no}" = yes ] || [ "${PROMPTED_hook_auto:-no}" = yes ]; then
  verdict=partial
else
  verdict=refuted
fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
