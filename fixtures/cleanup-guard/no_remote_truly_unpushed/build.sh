#!/usr/bin/env bash
# no_remote_truly_unpushed - builds the git state and fake forge for this cleanup-guard case.
# Flowryn's own case (notes projects, docs/notes/2026-10-30-notes-projects-non-8d.md): a repository with no remote.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"
fx_drop_origin

fx_wt_commit_file notes.md "a draft nobody merged"

fx_finish
