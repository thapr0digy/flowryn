#!/usr/bin/env bash
# transient_index_lock_clears_on_retry - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_transient_index_lock_clears_after_first_attempt_and_retry_succeeds.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_lock fresh
lock=$(cat "$OC_DIR/runtime/lock-path")
( sleep 0.4; rm -f "$lock" ) </dev/null >/dev/null 2>&1 &
oc_track $!
