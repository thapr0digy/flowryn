#!/usr/bin/env bash
# content_in_default_fallback - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_content_in_default_fallback_allows (matrix row h).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "add feature"
fx_land_on_origin_main feature.txt hello

fx_finish
