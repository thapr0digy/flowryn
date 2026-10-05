#!/usr/bin/env bash
# squash_merged_rebased_branch - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_squash_merged_rebased_branch_allows (matrix row q2).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_setup_squash_rebased_history rebased

fx_finish
