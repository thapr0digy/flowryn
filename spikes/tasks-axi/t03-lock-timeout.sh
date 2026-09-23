#!/usr/bin/env bash
# M0 claim (design §8 journal protocol, §16 "tasks-axi fails or lock times
# out"): tasks-axi's single-supervisor lock has a 2.5 s advisory timeout, and a
# lock timeout surfaces as a failing exit the journal can retry.
#
# Method: scratch backlog. The spike holds <backlog>.lock itself (fresh mtime),
# runs a mutation, and records the elapsed time, exit code, error code, and
# whether the file changed. It repeats with a lock older than 30 s (the stale
# threshold) to see whether tasks-axi breaks a stale lock on its own.
set -u
. "$(dirname "$0")/lib.sh"
ID=t03-lock-timeout
taxi_init "$ID"
taxi seed add tc-lock "lock target"

nowms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
echo "spike-holder:$$" > "$BACKLOG.lock"
t0=$(nowms)
taxi fresh-lock update tc-lock --title "should not apply"
t1=$(nowms)
fresh="rc=$LAST_RC after $((t1 - t0))ms, changed=$LAST_CHANGED, $(printf '%s' "$LAST_OUT" | grep -E '^(error|code):' | tr '\n' ' ')"
rc_fresh=$LAST_RC; ch_fresh=$LAST_CHANGED

touch -t "$(date -v-2M +%Y%m%d%H%M.%S)" "$BACKLOG.lock"
t0=$(nowms)
taxi stale-lock update tc-lock --title "should not apply either"
t1=$(nowms)
stale="rc=$LAST_RC after $((t1 - t0))ms, changed=$LAST_CHANGED, $(printf '%s' "$LAST_OUT" | grep -E '^(error|code):' | tr '\n' ' ')"
[ -e "$BACKLOG.lock" ] && still=yes || still=no
rm -f "$BACKLOG.lock"
taxi after-release update tc-lock --title "applies after release"
after="rc=$LAST_RC changed=$LAST_CHANGED"

evidence="fresh lock: $fresh; lock older than 30s: $stale; stale lock still present afterwards=$still; after release: $after"
if [ "$rc_fresh" != 0 ] && [ "$ch_fresh" = no ]; then verdict=confirmed; else verdict=refuted; fi
spike_verdict "$ID" "$verdict" "$TAXI_VERSION" "$evidence"
