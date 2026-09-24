#!/usr/bin/env bash
# Build the single flowryn binary (it is also flowrynd) into dist/.
# Bun's compiled binary ships with an invalid ad-hoc signature on macOS, so the
# build re-signs it and verifies the result (design section 3).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT="${1:-$ROOT/dist/flowryn}"
mkdir -p "$(dirname "$OUT")"

bun build "$ROOT/src/main.ts" --compile --outfile "$OUT"

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --force --sign - "$OUT"
  codesign --verify --strict "$OUT"
fi

ln -sf "$(basename "$OUT")" "$(dirname "$OUT")/flowrynd"
"$OUT" version
