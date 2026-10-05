#!/usr/bin/env bash
# stale_index_lock_cleanup_rechecks_dirty_worktree - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_stale_index_lock_cleanup_rechecks_dirty_worktree.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt landed "landed work"
git -C "$FX_WT" push -q origin "$FX_TASK_BRANCH"
git -C "$FX_PRIMARY" fetch -q origin

oc_finish
oc_fake lsof-no-holder
oc_fake git-status-lock-failure
