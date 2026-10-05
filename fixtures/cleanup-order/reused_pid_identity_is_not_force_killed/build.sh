#!/usr/bin/env bash
# reused_pid_identity_is_not_force_killed - builds the git state and fake tools for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_reused_pid_identity_is_not_force_killed.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit

oc_finish
oc_fake lsof-scripted
