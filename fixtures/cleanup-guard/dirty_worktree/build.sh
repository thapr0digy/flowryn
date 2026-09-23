#!/usr/bin/env bash
# dirty_worktree - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_dirty_worktree_refuses (matrix row i).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "add feature"
fx_land_on_origin_main feature.txt hello
fx_ref pr_head HEAD "$FX_WT"
fx_publish_pull_head "$(git -C "$FX_WT" rev-parse HEAD)"
printf "%s\n" "uncommitted edit" > "$FX_WT/feature.txt"

fx_finish
