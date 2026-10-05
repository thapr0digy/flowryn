#!/usr/bin/env bash
# persistent_index_lock_refuses - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_persistent_index_lock_exhausts_retries_and_refuses_loudly.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish '{"lock_wait_ms": 50, "lock_retries": 2, "lock_age_ms": 3600000}'
oc_fake lsof-live-holder
