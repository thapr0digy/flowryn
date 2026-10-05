#!/usr/bin/env bash
# The Claude side of urgent steers (steer latency Tier 2, design assumptions
# A1-A3 in the steer-urgent-tier design):
#   A1: under --permission-mode bypassPermissions, a PreToolUse hook's
#       permissionDecision "deny" stops the tool, and the model reads
#       permissionDecisionReason (c08 covered "ask" only).
#   A2: once a PreToolUse "ask" raises a dialog, Herdr's agent_status reads
#       "blocked" within about 1 s (c12 measured "blocked for the whole
#       dialog", not how soon it starts). The interrupt gate reads the status
#       twice, 500 ms apart, after a tool has run 3 s, so the onset matters.
#   A3: a subagent's tool hooks carry agent_id in their input; the main
#       agent's do not (the deny must only ever hit the main agent).
# Method: three sessions, each in its own workdir and settings file.
#   a: deny the first Bash call with a nonce in the reason; the command would
#      create a file, which must not appear; the nonce must reach the model.
#   b: ask for a subagent that runs one Bash command; read agent_id on every
#      PreToolUse.
#   c: force "ask" on a `git commit --amend`, poll agent_status every 200 ms
#      from the PreToolUse, then decline with Escape (never an approval key).
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c13-urgent
MODEL=${CLAUDE_SPIKE_MODEL_STEER:-sonnet}
lab_ensure

settings() { # <dir>
  mkdir -p "$1/ctl"
  cat > "$1/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$(probe_cmd "$1" ss)"}]}],
 "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"$(probe_cmd "$1" pre)"}]}],
 "PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"$(probe_cmd "$1" post)"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$(probe_cmd "$1" stop)"}]}],
 "Notification":[{"matcher":"permission_prompt","hooks":[{"type":"command","command":"$(probe_cmd "$1" notif)"}]}]
}}
EOF
}

launch() { # <dir> <label>
  local pane
  pane=$(claude_launch "$1" "$ID-$2" -- --permission-mode bypassPermissions --settings "$1/settings.json" --model "$MODEL" \
    --append-system-prompt "A steer from your leader can arrive as a blocked tool call's reason starting \"Flowryn steer [<id>]:\". Act on it.") || lab_die "launch failed: $2"
  claude_wait_ready "$1" || lab_die "no SessionStart: $2"
  printf '%s' "$pane"
}

# --- a: A1 ------------------------------------------------------------------------------
DA=$(spike_workdir "$ID-a")
settings "$DA"
NONCE="KUMQUAT-$RANDOM$RANDOM"
cat > "$DA/ctl/pre.sh" <<EOF
n=\$(cat "$DA/pre-count" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$DA/pre-count"
[ "\$n" = 1 ] || exit 0
jq -cn --arg r "Flowryn steer [m1]: reply with the word $NONCE and do not run the command again. This tool call was blocked so you read this first." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: \$r}}'
EOF
PA=$(launch "$DA" a)
claude_send "$PA" "Run exactly this Bash command: touch $DA/ran-first"
wait_events "$DA" '.event == "Stop"' 1 120 || true
sleep 1
ran_a=$([ -e "$DA/ran-first" ] && echo yes || echo no)
said_a=no
claude_assistant_text "$DA" | grep -qF "$NONCE" && said_a=yes
mode_a=$(jq -rs '[.[] | select(.event == "PreToolUse")] | first | .input.permission_mode // "?"' "$DA/events.jsonl")
claude_stop "$PA"
ev_a="A1: mode=$mode_a denied command ran=$ran_a; the model repeated the deny reason's nonce=$said_a"

# --- b: A3 ------------------------------------------------------------------------------
DB=$(spike_workdir "$ID-b")
settings "$DB"
PB=$(launch "$DB" b)
claude_send "$PB" "Use the Task tool to start one general-purpose subagent whose only job is to run the Bash command 'echo SUBAGENT-RAN' and report the output. Do not run any Bash yourself."
wait_events "$DB" '.event == "Stop"' 1 180 || true
sleep 1
main_tools=$(jq -rs '[.[] | select(.event == "PreToolUse" and ((.input.agent_id // "") == "")) | .input.tool_name] | unique | join(",")' "$DB/events.jsonl")
sub_tools=$(jq -rs '[.[] | select(.event == "PreToolUse" and ((.input.agent_id // "") != "")) | .input.tool_name] | unique | join(",")' "$DB/events.jsonl")
sub_bash=$(events_count "$DB" '.event == "PreToolUse" and .input.tool_name == "Bash" and ((.input.agent_id // "") != "")')
main_bash=$(events_count "$DB" '.event == "PreToolUse" and .input.tool_name == "Bash" and ((.input.agent_id // "") == "")')
claude_stop "$PB"
ev_b="A3: main-agent PreToolUse tools=[$main_tools] (Bash $main_bash); with agent_id=[$sub_tools] (Bash $sub_bash)"

# --- c: A2 ------------------------------------------------------------------------------
DC=$(spike_workdir "$ID-c")
settings "$DC"
cat > "$DC/ctl/pre.sh" <<'EOF'
cmd=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // ""')
case "$cmd" in
  *"git commit --amend"*)
    jq -cn '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "spike"}}' ;;
esac
EOF
PC=$(launch "$DC" c)
claude_send "$PC" "Run exactly this Bash command and nothing else: git commit --amend --no-edit"
wait_events "$DC" '.event == "PreToolUse" and (.input.tool_input.command // "" | test("amend"))' 1 120 || true
t_pre=$(jq -rs '[.[] | select(.event == "PreToolUse" and (.input.tool_input.command // "" | test("amend")))] | first | .t // 0' "$DC/events.jsonl")
t_blocked=""
reads=0
statuses=""
while [ "$reads" -lt 100 ]; do
  s=$(lab_herdr agent get "$PC" 2>/dev/null | jq -r '.result.agent.agent_status // "?"')
  statuses="$statuses $s"
  if [ "$s" = blocked ]; then t_blocked=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000'); break; fi
  sleep 0.2
  reads=$((reads + 1))
done
claude_keys "$PC" Escape
sleep 1
claude_stop "$PC"
onset=$([ -n "$t_blocked" ] && [ "$t_pre" != 0 ] && echo "$(( t_blocked - t_pre )) ms" || echo never)
ev_c="A2: PreToolUse to Herdr blocked=$onset; statuses read:$(printf '%s' "$statuses" | tr ' ' '\n' | uniq | tr '\n' ' ')"

a1=$([ "$ran_a" = no ] && [ "$said_a" = yes ] && echo yes || echo no)
a2=no
[ -n "$t_blocked" ] && [ "$t_pre" != 0 ] && [ $(( t_blocked - t_pre )) -le 1500 ] && a2=yes
a3=$([ "$sub_bash" -ge 1 ] && [ "$main_bash" = 0 ] && echo yes || echo no)
evidence="model=$MODEL; $ev_a || $ev_b || $ev_c; held: A1=$a1 A2=$a2 A3=$a3"
if [ "$a1$a2$a3" = yesyesyes ]; then verdict=confirmed
elif [ "$a1" = no ] && [ "$a2" = no ] && [ "$a3" = no ]; then verdict=refuted
else verdict=partial
fi
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
