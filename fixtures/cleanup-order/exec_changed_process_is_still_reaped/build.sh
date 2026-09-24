#!/usr/bin/env bash
# exec_changed_process_is_still_reaped - builds the git state and fake tools for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_exec_changed_process_is_still_reaped.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
