#!/usr/bin/env bash
# parked_run_advanced_head_locally_fetched_is_aborted - builds the git state and fake tools for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_parked_run_advanced_head_locally_fetched_is_still_aborted.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

oc_land_shippable_commit
fix=$(printf '%s\n' "pipeline fix round 1" | fx_git -C "$FX_WT" commit-tree "$(git -C "$FX_WT" rev-parse "HEAD^{tree}")" -p "$(git -C "$FX_WT" rev-parse HEAD)")
fx_ref pipeline_head "$fix"

oc_finish
