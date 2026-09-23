#!/usr/bin/env bash
# squash_merged_stale_local_when_forge_unreachable - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_squash_merged_stale_local_refuses_when_forge_unreachable (matrix row q5).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_setup_squash_rebased_history stale

fx_finish
