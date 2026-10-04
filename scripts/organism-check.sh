#!/usr/bin/env bash
# Canonical gate. site/ is the organism. equilibrium/ is not this script.
# The native crate is checked only because runtime.run.ts asks it to read
# site/src/protocol/native-contract.json. That read is not G.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -n "${TSX:-}" ]]; then
  runner=("$TSX")
elif command -v tsx >/dev/null 2>&1; then
  runner=(tsx)
else
  runner=(npx --yes tsx)
fi
for f in site/src/protocol/*.run.ts; do
  echo "== $f =="
  NODE_ENV=production "${runner[@]}" "$f"
done
