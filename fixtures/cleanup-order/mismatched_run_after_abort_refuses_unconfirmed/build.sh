#!/usr/bin/env bash
# mismatched_run_after_abort_refuses_unconfirmed - builds the git state and fake tools for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_mismatched_run_after_abort_refuses_unconfirmed.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
