#!/usr/bin/env bash
# parked_own_run_is_aborted_before_cleanup - builds the git state and fake tools for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_parked_own_run_is_aborted_before_teardown.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
