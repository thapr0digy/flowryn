#!/usr/bin/env bash
# Build the single flowryn binary (it is also flowrynd) into dist/.
# Bun's compiled binary ships with an invalid ad-hoc signature on macOS, so the
# build re-signs it and verifies the result (design section 3).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT="${1:-$ROOT/dist/flowryn}"
mkdir -p "$(dirname "$OUT")"

# The build stamp (src/build-stamp.ts): the commit, whether the tree was clean,
# and this checkout. The daemon applies a new build by itself only when it is a
# clean build of a merged commit. FLOWRYN_BUILD_COMMIT, FLOWRYN_BUILD_DIRTY and
# FLOWRYN_BUILD_SOURCE override them, for tests that need a build of a commit
# in a scratch repository.
COMMIT="${FLOWRYN_BUILD_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
if [ -n "${FLOWRYN_BUILD_DIRTY:-}" ]; then
  DIRTY="$FLOWRYN_BUILD_DIRTY"
elif [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null || echo unknown)" ]; then
  DIRTY=true
else
  DIRTY=false
fi
STAMP=()
if [ -n "$COMMIT" ]; then
  STAMP=(--define "FLOWRYN_BUILD_COMMIT=\"$COMMIT\"" --define "FLOWRYN_BUILD_DIRTY=\"$DIRTY\"" --define "FLOWRYN_BUILD_SOURCE=\"${FLOWRYN_BUILD_SOURCE:-$ROOT}\"")
fi

bun build "$ROOT/src/main.ts" --compile ${STAMP[@]+"${STAMP[@]}"} --outfile "$OUT"

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --force --sign - "$OUT"
  codesign --verify --strict "$OUT"
fi

ln -sf "$(basename "$OUT")" "$(dirname "$OUT")/flowrynd"
"$OUT" version
