#!/usr/bin/env bash
# process_spawned_during_grace_is_reaped_on_later_pass - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_process_spawned_during_grace_is_reaped_on_later_pass.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_start_in "$OC_WT" 'my $f = shift; $SIG{TERM} = sub { my $c = fork(); die "fork" unless defined $c; if (!$c) { exec "sleep", "300"; } open my $fh, ">", $f or die; print {$fh} "$c\n"; close $fh; exit 0; }; sleep 300;' "$OC_DIR/runtime/child-pid" > "$OC_DIR/runtime/watch-pids"
sleep 0.3
