#!/usr/bin/env bash
# persistent_index_lock_refuses - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_persistent_index_lock_exhausts_retries_and_refuses_loudly.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_lock fresh
