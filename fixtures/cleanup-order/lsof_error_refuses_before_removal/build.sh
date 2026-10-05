#!/usr/bin/env bash
# lsof_error_refuses_before_removal - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_lsof_error_refuses_before_removal.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
oc_fake lsof-exit1
