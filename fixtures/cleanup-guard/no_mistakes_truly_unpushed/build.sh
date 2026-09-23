#!/usr/bin/env bash
# no_mistakes_truly_unpushed - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_no_mistakes_truly_unpushed_refuses (matrix row e).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "unpushed work"

fx_finish
