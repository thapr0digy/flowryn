#!/usr/bin/env bash
# live_index_lock_is_never_removed - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_live_index_lock_is_never_removed_and_teardown_refuses.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_lock old
