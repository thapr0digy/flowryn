#!/usr/bin/env bash
# local_only_force_overrides_unpushed - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_local_only_force_overrides_unpushed (matrix row f).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit "unpushed work"

fx_finish
