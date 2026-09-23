#!/usr/bin/env bash
# content_fallback_refreshes_stale_origin_ref - builds the git state and fake forge for this cleanup-guard case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_content_fallback_refreshes_stale_origin_ref (matrix row l).
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"

fx_wt_commit_file feature.txt hello "add feature"
git -C "$FX_PRIMARY" config --unset-all remote.origin.fetch
git -C "$FX_PRIMARY" config --add remote.origin.fetch "+refs/heads/not-main:refs/remotes/origin/not-main"
fx_land_on_origin_main feature.txt hello

fx_finish
