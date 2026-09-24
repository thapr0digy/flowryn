#!/usr/bin/env bash
# another_branchs_parked_run_is_never_touched - builds the git state and fake tools for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_another_branchs_parked_run_is_never_touched.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
