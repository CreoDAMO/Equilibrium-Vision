#!/usr/bin/env bash
# Build the model_registry WASM contract and hex-encode it for deployment.
set -euo pipefail

RUST_BIN="/nix/store/brzjqpcbk04hzmhsqlmp7vng4jdis2yc-rust-mixed/bin"
export PATH="$RUST_BIN:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[model_registry] Building wasm32 contract..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release 2>&1

WASM="target/wasm32-unknown-unknown/release/model_registry.wasm"
if [ ! -f "$WASM" ]; then
  echo "[model_registry] ERROR: WASM binary not found at $WASM" >&2
  exit 1
fi

# Hex-encode for deployment via POST /api/contracts/deploy
xxd -p "$WASM" | tr -d '\n' > model_registry.hex
echo "[model_registry] ✓ Built: $WASM"
echo "[model_registry] ✓ Hex:   $CONTRACT_DIR/model_registry.hex"
echo "[model_registry] Size:  $(wc -c < model_registry.hex) hex chars = $(( $(wc -c < model_registry.hex) / 2 )) bytes"
