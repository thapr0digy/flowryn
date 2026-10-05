#!/usr/bin/env bash
# live_index_lock_is_never_removed - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_live_index_lock_is_never_removed_and_teardown_refuses.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
oc_fake lsof-live-holder
