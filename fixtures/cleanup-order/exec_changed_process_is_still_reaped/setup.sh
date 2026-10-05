#!/usr/bin/env bash
# exec_changed_process_is_still_reaped - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_exec_changed_process_is_still_reaped.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

pid=$(oc_start_in "$OC_WT" 'my ($m) = @ARGV; until (-e $m) { select undef, undef, undef, 0.01; } exec "perl", "-e", q{$SIG{TERM} = "IGNORE"; sleep 300};' "$OC_DIR/runtime/exec-now")
echo "$pid" > "$OC_DIR/runtime/watch-pids"
oc_fake_ps_mark "$pid" "$OC_DIR/runtime/exec-now"
sleep 0.2
