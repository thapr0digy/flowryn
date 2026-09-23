#!/usr/bin/env bash
# M0 claims (design §5 "P0 while idle", §17 Claude bridge item 1):
#   a. an asyncRewake Stop hook that exits 2 wakes an idle session, and its
#      stderr reaches the model;
#   b. what happens when the waiter fires while the session is busy;
#   c. older waiters that exit 0 cause no wake (and Claude does not
#      deduplicate async hooks, so several waiters can be alive at once);
#   d. whether arming the waiter from SessionStart also works;
#   e. the timeout field bounds a waiter (8 h in the design; a 6 s timeout is
#      used here to observe expiry) and every Stop re-arms a new waiter.
#
# Method: one Claude session in a lab pane. Waiters are probe hooks whose ctl
# script records "armed", then polls for a fire file: "wake <line>" prints the
# line to stderr and exits 2; "exit0" exits 0. A second Stop hook with a 6 s
# timeout never fires and records whether it was killed.
set -u
. "$(dirname "$0")/../lib/lab.sh"
. "$(dirname "$0")/../lib/claude.sh"
ID=c01-async-rewake
lab_ensure
DIR=$(spike_workdir "$ID")
mkdir -p "$DIR/ctl" "$DIR/waiters"

cat > "$DIR/settings.json" <<EOF
{"permissions":{"allow":["Bash(perl *)"]},
 "hooks":{
 "SessionStart":[{"hooks":[
   {"type":"command","command":"$(probe_cmd "$DIR" ss)"},
   {"type":"command","command":"$(probe_cmd "$DIR" sswaiter)","asyncRewake":true,"timeout":28800}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" ups)"}]}],
 "PreToolUse":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" pre)"}]}],
 "PostToolUse":[{"hooks":[{"type":"command","command":"$(probe_cmd "$DIR" post)"}]}],
 "Stop":[{"hooks":[
   {"type":"command","command":"$(probe_cmd "$DIR" stop)"},
   {"type":"command","command":"$(probe_cmd "$DIR" waiter)","asyncRewake":true,"timeout":28800},
   {"type":"command","command":"$(probe_cmd "$DIR" shortwaiter)","asyncRewake":true,"timeout":6}]}]
}}
EOF

# Shared waiter body: numbered instance, armed mark, then wait for a fire file.
cat > "$DIR/ctl/waiter-body.sh" <<'EOF'
kind=$1
n=$(cd "$WDIR" && ls "$kind".*.pid 2>/dev/null | wc -l | tr -d ' '); n=$((n+1))
echo $$ > "$WDIR/$kind.$n.pid"
probe_mark "armed-$kind-$n"
trap 'probe_mark "killed-$kind-$n"; exit 143' TERM
trap 'probe_mark "hup-$kind-$n"; exit 129' HUP
i=0
while [ $i -lt 3000 ]; do
  if [ -f "$WDIR/$kind.$n.fire" ]; then
    cmd=$(cat "$WDIR/$kind.$n.fire")
    case "$cmd" in
      wake\ *) probe_mark "fired-$kind-$n"; echo "${cmd#wake }" >&2; exit 2 ;;
      exit0) probe_mark "released-$kind-$n"; exit 0 ;;
    esac
  fi
  sleep 0.2
  i=$((i+1))
done
probe_mark "gaveup-$kind-$n"
EOF
for kind in waiter sswaiter shortwaiter; do
  printf 'WDIR=%q\n. %q %s\n' "$DIR/waiters" "$DIR/ctl/waiter-body.sh" "$kind" > "$DIR/ctl/$kind.sh"
done

marks() { jq -rs '[.[] | select(.phase != "start") | .phase] | join(",")' "$DIR/events.jsonl"; }
stops() { events_count "$DIR" '.event == "Stop" and .label == "stop"'; }
has_mark() { [ "$(events_count "$DIR" ".phase == \"$1\"")" -ge 1 ]; }
fire() { printf '%s' "$2" > "$DIR/waiters/$1.fire"; }
text_has() { claude_assistant_text "$DIR" | grep -qF -- "$1"; }
nowms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }

PANE=$(claude_launch "$DIR" "$ID" -- --settings "$DIR/settings.json" --model "$CLAUDE_SPIKE_MODEL") || lab_die "launch failed"
claude_wait_ready "$DIR" || lab_die "no SessionStart"

# d. SessionStart-armed waiter wakes a fresh idle session?
N0="i$RANDOM$RANDOM"
wait_until 15 has_mark armed-sswaiter-1 && ss_armed=yes || ss_armed=no
fire sswaiter.1 "wake Flowryn P0 [$N0]: a worker is blocked on a question for you. Mention $N0 in one short line."
wait_until 45 text_has "$N0" && d_woke=yes || d_woke=no
wait_for 30 '[ "$(stops)" -ge 1 ]' || true
R_D="sessionstart waiter armed=$ss_armed woke=$d_woke"

# a. Stop-armed waiter wakes an idle session and stderr reaches the model.
base=$(stops)
[ "$d_woke" = yes ] || { claude_send "$PANE" "Say one word."; wait_for 60 '[ "$(stops)" -gt "$base" ]'; }
wait_for 20 'has_mark "armed-waiter-$(stops)"' || true
sleep 3
W=$(stops)
N1="i$RANDOM$RANDOM"
t_fire=$(nowms)
fire "waiter.$W" "wake Flowryn P0 [$N1]: worker for \"migrate billing\" is blocked on a question for you. Mention $N1 in one short line."
wait_until 45 text_has "$N1" && a_woke=yes || a_woke=no
t_woke=$(nowms)
wait_for 30 '[ "$(stops)" -gt "$W" ]' || true
R_A="idle wake=$a_woke (fire to text $((t_woke - t_fire))ms); stderr-only nonce reached the model=$a_woke"

# e. re-arm on every Stop, and the short timeout.
sleep 8
armed=$(events_count "$DIR" '.phase | startswith("armed-waiter-")')
short_killed=$(events_count "$DIR" '.phase | startswith("killed-shortwaiter-")')
short_armed=$(events_count "$DIR" '.phase | startswith("armed-shortwaiter-")')
R_E="stops=$(stops) waiters armed=$armed; 6s-timeout waiters armed=$short_armed killed-at-timeout=$short_killed"

# b. fire while busy: a long tool call, then fire the newest waiter mid-tool.
W=$(stops)
N2="i$RANDOM$RANDOM"
claude_send "$PANE" "Run exactly this Bash command in the foreground, not in the background: perl -e 'sleep 25'. Then reply with the single word finished."
wait_events "$DIR" '.event == "PreToolUse"' 1 60 || true
sleep 3
t_busy_fire=$(nowms)
fire "waiter.$W" "wake Flowryn P0 [$N2]: second blocked worker. Mention $N2 in one short line."
wait_until 90 text_has "$N2" && b_seen=yes || b_seen=no
wait_for 60 '[ "$(stops)" -ge $((W + 2)) ]' || true
t_post=$(jq -rs '[.[] | select(.event == "PostToolUse")] | last | .t' "$DIR/events.jsonl")
# Where did N2 land relative to the tool result and the "finished" reply?
order=$(jq -r --arg n "$N2" 'select(.type == "assistant" or .type == "user" or .type == "attachment")
  | (if .type == "assistant" then ([.message.content[]? | select(.type == "text") | .text] | join(" "))
     elif .type == "user" then (.message.content | tostring) else (.attachment | tostring) end) as $c
  | if ($c | contains($n)) then "N2:" + .type elif ($c | test("finished"; "i")) and .type == "assistant" then "finished" elif ($c | contains("tool_result")) then "tool_result" else empty end' \
  "$(claude_transcript "$DIR")" | tr '\n' ' ')
R_B="busy fire at +$((t_busy_fire - ${t_post:-t_busy_fire}))ms vs last PostToolUse; seen=$b_seen; transcript order after fire: $order"

# c. older waiters exit 0. One more plain turn arms another waiter while the
# previous one is still alive (Claude does not deduplicate async hooks), then
# every live waiter is released with exit 0 and the session must stay quiet.
W=$(stops)
claude_send "$PANE" "Say ok."
wait_for 60 '[ "$(stops)" -gt "$W" ]' || true
sleep 2
live=0
for pidf in "$DIR"/waiters/waiter.*.pid; do
  k=$(basename "$pidf" .pid)
  if kill -0 "$(cat "$pidf")" 2>/dev/null; then live=$((live+1)); fire "$k" exit0; fi
done
before=$(stops)
sleep 25
after=$(stops)
R_C="live waiters at once=$live (no dedup if >1); released with exit 0; stops before=$before after=$after"
claude_stop "$PANE"

evidence="a: $R_A | b: $R_B | c: $R_C | d: $R_D | e: $R_E | marks: $(marks | cut -c1-300)"
if [ "$a_woke" = yes ] && [ "$before" = "$after" ]; then verdict=confirmed; else verdict=refuted; fi
[ "$verdict" = confirmed ] && [ "$d_woke" != yes ] && verdict=partial
spike_verdict "$ID" "$verdict" "$(claude_version)" "$evidence"
