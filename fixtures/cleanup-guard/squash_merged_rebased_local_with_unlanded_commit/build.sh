#!/usr/bin/env bash
# squash_merged_rebased_local_with_unlanded_commit - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_squash_merged_rebased_local_with_unlanded_commit_refuses (matrix row q4).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_setup_squash_rebased_history rebased-plus-unlanded

fx_finish
