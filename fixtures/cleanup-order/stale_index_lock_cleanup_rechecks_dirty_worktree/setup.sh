#!/usr/bin/env bash
# stale_index_lock_cleanup_rechecks_dirty_worktree - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_stale_index_lock_cleanup_rechecks_dirty_worktree.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_lock old
printf '%s\n' dirty > "$OC_WT/feature.txt"
