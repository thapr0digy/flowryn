#!/usr/bin/env bash
# transient_index_lock_clears_on_retry - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_transient_index_lock_clears_after_first_attempt_and_retry_succeeds.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish '{"lock_wait_ms": 300, "lock_retries": 5, "lock_age_ms": 3600000}'
oc_fake lsof-live-holder
