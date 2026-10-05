#!/usr/bin/env bash
# gh_error_and_content_absent - builds the git state and fake forge for this cleanup-guard case.
# Ported from the reference's tests/fm-teardown.test.sh:test_gh_error_and_content_absent_refuses (matrix row j).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "add feature"

fx_finish
