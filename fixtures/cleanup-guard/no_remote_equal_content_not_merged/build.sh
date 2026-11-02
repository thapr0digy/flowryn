#!/usr/bin/env bash
# no_remote_equal_content_not_merged - builds the git state and fake forge for this cleanup-guard case.
# Flowryn's own case (notes projects, docs/notes/2026-10-30-notes-projects-non-8d.md): a repository with no remote.
# Usage: build.sh <out-dir>
# shellcheck source=../lib/build-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/build-common.sh"
fx_init "${1:-}" "$(dirname "${BASH_SOURCE[0]}")"
fx_drop_origin

fx_wt_commit_file notes.md "the same text"
printf '%s\n' "the same text" > "$FX_PRIMARY/notes.md"
git -C "$FX_PRIMARY" add -- notes.md
fx_git -C "$FX_PRIMARY" commit -q -m "the same note, written on main"

fx_finish
