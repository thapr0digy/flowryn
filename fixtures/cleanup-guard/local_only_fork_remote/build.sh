#!/usr/bin/env bash
# local_only_fork_remote - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_local_only_fork_remote_allows (matrix row a).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit "fix the thing"
fx_add_fork_with_pushed_branch
fx_ref fork_branch_head "refs/remotes/fork/$FX_TASK_BRANCH"

fx_finish
