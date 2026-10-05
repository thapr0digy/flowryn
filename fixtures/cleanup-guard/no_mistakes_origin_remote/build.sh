#!/usr/bin/env bash
# no_mistakes_origin_remote - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_no_mistakes_origin_remote_allows (matrix row d).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit "shippable work"
git -C "$FX_WT" push -q origin "$FX_TASK_BRANCH"
git -C "$FX_PRIMARY" fetch -q origin

fx_finish
