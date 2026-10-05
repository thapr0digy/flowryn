#!/usr/bin/env bash
# process_exit_during_identity_lookup_does_not_refuse - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_process_exit_during_identity_lookup_does_not_refuse.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
oc_fake lsof-scripted
