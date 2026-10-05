#!/usr/bin/env bash
# not_found_status_after_abort_confirms_completion - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_not_found_status_after_abort_confirms_completion.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
