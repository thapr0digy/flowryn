#!/usr/bin/env bash
# squash_merged_branch_deleted - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_squash_merged_branch_deleted_allows (matrix row g).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "add feature"
fx_ref pr_head HEAD "$FX_WT"
fx_publish_pull_head "$(git -C "$FX_WT" rev-parse HEAD)"

fx_finish
