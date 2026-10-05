#!/usr/bin/env bash
# pr_check_records_remote_head_when_local_lags - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_pr_check_records_remote_head_when_local_lags (matrix row p).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "add feature"
local_head=$(git -C "$FX_WT" rev-parse HEAD)
pr_head=$(fx_commit_tree_from_wt_head "$local_head" "no-mistakes follow-up")
fx_ref pr_head "$pr_head"
fx_publish_pull_head "$pr_head"

fx_finish
