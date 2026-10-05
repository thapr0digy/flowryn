#!/usr/bin/env bash
# local_only_merged_to_local_main - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_local_only_merged_to_local_main_allows (matrix row c).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit "merged work"
git -C "$FX_PRIMARY" update-ref "refs/heads/$FX_DEFAULT_BRANCH" "$(git -C "$FX_WT" rev-parse HEAD)"

fx_finish
