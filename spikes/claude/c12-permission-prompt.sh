#!/usr/bin/env bash
# M0 claim (design §5 leader approval channel / §17 Claude bridge item 3, feeding
# the mid-run prompt-wedge backstop in docs/cutover-notes.md C2): the
# Notification hook with notification_type permission_prompt fires when a
# dialog appears (a PreToolUse hook's own "ask" decision, or Claude's native
# ask under default mode), and Herdr's agent_status is a reliable "a dialog is
# up" signal distinct from "working" during a genuinely long tool call.
#
# Method: each case gets its own workdir (its own events.jsonl), the same
# settings file shape (SessionStart/Stop/PreToolUse(Bash)/Notification probes,
# Notification matcher "permission_prompt|idle_prompt"), and the same
# PreToolUse ctl script, which only forces permissionDecision "ask" for a
# `git commit --amend` command — so case c's long `perl` tool is not itself
# wedged by the hook, isolating "agent_status during a dialog" (a, b) from
# "agent_status during a long but non-blocked tool" (c). Per-case workdirs
# matter: claude_wait_ready counts SessionStart events in that case's own
# events.jsonl, so sharing one file across launches makes it return before the
# next session is actually ready (found while running this spike).
#   a: PreToolUse hook ask, --permission-mode bypassPermissions
#   b: Claude's own permission dialog, default permission mode
#   c: perl -e 'sleep 180' (long foreground tool), bypassPermissions
# No dialog is ever answered with keys; each case is only observed, then the
# pane is closed.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c12-permission-prompt
# Case b hinges on Claude's own choice to run (or not run) the Bash tool under
# default mode, so this uses the ask-judgment model (c08's convention) rather
# than the usual spike default; Haiku sometimes substituted a read-only
# `git status`/`git diff` check instead of the requested command, found while
# running this spike.
MODEL=${CLAUDE_SPIKE_MODEL_ASK:-sonnet}
lab_ensure

write_settings() { # <dir>
  mkdir -p "$1/ctl"
  cat > "$1/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$1" ss)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$1" stop)"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$(probe_cmd "$1" pre)"}]}],
 "Notification":[{"matcher":"permission_prompt|idle_prompt","hooks":[{"type":"command","command":"$(probe_cmd "$1" notif)"}]}]
}}
EOF
  cat > "$1/ctl/pre.sh" <<'EOF'
cmd=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // ""')
case "$cmd" in
  *"git commit --amend"*)
    jq -cn '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: "spike"}}' ;;
esac
EOF
}

last_t() { jq -rs "[.[] | select($2)] | last | .t // 0" "$1/events.jsonl"; } # <dir> <jq-filter>

# Runs one case in its own workdir, polling pane text + agent_status every 5 s
# for 90 s, then closing the pane (Escape only, never an answer key).
run_case() { # <label> <mode> <prompt>
  local label=$1 mode=$2 prompt=$3 dir pane elapsed=0 screen status
  dir=$(spike_workdir "$ID-$label")
  write_settings "$dir"
  pane=$(claude_launch "$dir" "$ID-$label" -- --permission-mode "$mode" --settings "$dir/settings.json" --model "$MODEL") || lab_die "launch failed: $label"
  claude_wait_ready "$dir" || lab_die "no SessionStart: $label"
  claude_send "$pane" "Run exactly this Bash command and nothing else: $prompt"
  : > "$dir/statuses"
  : > "$dir/markers"
  while [ "$elapsed" -lt 90 ]; do
    screen=$(lab_pane_read "$pane" 40 2>/dev/null)
    status=$(lab_herdr agent get "$pane" 2>/dev/null | jq -r '.result.agent.agent_status // "?"')
    {
      printf '[%s] t=+%ss status=%s\n' "$label" "$elapsed" "$status"
      printf '%s\n' "$screen"
      printf -- '---\n'
    } >> "$dir/status.log"
    echo "$status" >> "$dir/statuses"
    printf '%s' "$screen" | grep -qiE 'do you want to proceed' && echo dialog >> "$dir/markers"
    sleep 5
    elapsed=$((elapsed + 5))
  done
  claude_keys "$pane" Escape
  sleep 1
  claude_stop "$pane"
  eval "DIR_${label}=$dir"
}

run_case a bypassPermissions "git commit --amend --no-edit"
run_case b default "git commit --amend --no-edit"
run_case c bypassPermissions "perl -e 'sleep 180'"

# Computes whether permission_prompt fired for a case's dir. Run directly
# (not through a $(...) command substitution) so FIRED_<label> is visible in
# this shell, not lost in a subshell — a real bug found while running this
# spike the first time.
compute_fired() { # <label> <dir>
  local label=$1 dir=$2 fired=no
  [ "$(events_count "$dir" '.event == "Notification" and .input.notification_type == "permission_prompt"')" -ge 1 ] && fired=yes
  eval "FIRED_${label}=$fired"
}
compute_fired a "$DIR_a"
compute_fired b "$DIR_b"
compute_fired c "$DIR_c"

report_case() { # <label> <dir> <fired>
  local label=$1 dir=$2 fired=$3 delay=n/a dialog_seen statuses t_pretool t_prompt
  if [ "$fired" = yes ]; then
    t_pretool=$(last_t "$dir" '.event == "PreToolUse"')
    t_prompt=$(last_t "$dir" '.event == "Notification" and .input.notification_type == "permission_prompt"')
    delay="$(( (t_prompt - t_pretool) / 1000 ))s"
  fi
  dialog_seen=$([ -s "$dir/markers" ] && echo yes || echo no)
  statuses=$(sort -u "$dir/statuses" | tr '\n' ',' | sed 's/,$//')
  printf '%s' "fired=$fired delay_from_last_PreToolUse=$delay dialog_marker_seen=$dialog_seen agent_status_values=[$statuses]"
}

ev_a=$(report_case a "$DIR_a" "$FIRED_a")
ev_b=$(report_case b "$DIR_b" "$FIRED_b")
ev_c=$(report_case c "$DIR_c" "$FIRED_c")

evidence="model=$MODEL; a (hook-ask, bypass): $ev_a || b (native ask, default): $ev_b || c (perl sleep 180, bypass, no dialog): $ev_c"

if [ "$FIRED_a" = yes ] && [ "$FIRED_b" = yes ]; then
  verdict=confirmed
elif [ "$FIRED_a" = yes ] || [ "$FIRED_b" = yes ]; then
  verdict="partial: permission_prompt fired for only one of (a) hook-forced ask under bypass / (b) Claude's native ask under default mode"
else
  verdict=refuted
fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
