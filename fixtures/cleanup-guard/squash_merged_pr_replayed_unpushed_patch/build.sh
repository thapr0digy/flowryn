#!/usr/bin/env bash
# squash_merged_pr_replayed_unpushed_patch - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_squash_merged_pr_allows_replayed_unpushed_patch (matrix row n).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file local-parent.txt parent "local parent"
parent_head=$(git -C "$FX_WT" rev-parse HEAD)
git -C "$FX_WT" push -q origin "$parent_head:refs/heads/$FX_TASK_BRANCH"
git -C "$FX_PRIMARY" fetch -q origin "$FX_TASK_BRANCH"
fx_wt_commit_file feature.txt hello "add feature"
pr_head=$(fx_land_equivalent_patch_on_origin_branch pr-head feature.txt hello "add feature")
fx_ref local_parent "$parent_head"
fx_ref pr_head "$pr_head"
fx_publish_pull_head "$pr_head"

fx_finish
