#!/usr/bin/env bash
# Site protocol runs. Not the Render process and not a deployment identity.
# equilibrium/ is consulted only when a script asks that crate to read
# site/src/protocol/native-contract.json. That read is not G.
#
# tsx is the lockfile pin (catalog tsx, depended on by @workspace/coinomics).
# npx is refused: a floating fetch is not the constitution runner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -n "${TSX:-}" ]]; then
  run_tsx() { "$TSX" "$@"; }
else
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required so tsx comes from the lockfile. Refusing npx." >&2
    exit 1
  fi
  run_tsx() { pnpm --filter @workspace/coinomics exec tsx "$@"; }
fi

for f in site/src/protocol/*.run.ts; do
  echo "== $f =="
  # pnpm --filter exec runs inside that package. The path has to be absolute.
  NODE_ENV=production run_tsx "$ROOT/$f"
done
