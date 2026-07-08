#!/usr/bin/env bash
# Build the model_registry WASM contract and hex-encode it for deployment.
#
# Requires a rustup-managed toolchain with the wasm32-unknown-unknown target
# (the Nix-provided `rust-mixed` toolchain does not ship wasm32 std libs).
# One-time setup, if not already done:
#   rustup toolchain install stable --profile minimal
#   rustup target add wasm32-unknown-unknown --toolchain stable
#
# The GLIBC_TUNABLES env var works around a NixOS/glibc "cannot allocate
# memory in static TLS block" crash when rustup's prebuilt rustc_driver.so is
# loaded in this container — see .agents/memory/rust-wasm-toolchain.md.
set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLCHAIN_BIN="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin"
export RUSTUP_HOME="$HOME/.rustup"
export CARGO_HOME="$HOME/.cargo"
export PATH="$TOOLCHAIN_BIN:$PATH"
export GLIBC_TUNABLES=glibc.rtld.optional_static_tls=4000000
export RUST_MIN_STACK=33554432

echo "[model_registry] Building wasm32 contract..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release 2>&1

WASM="target/wasm32-unknown-unknown/release/model_registry.wasm"
if [ ! -f "$WASM" ]; then
  echo "[model_registry] ERROR: WASM binary not found at $WASM" >&2
  exit 1
fi

python3 -c "
with open('$WASM','rb') as f: data = f.read()
with open('model_registry.hex','w') as f: f.write(data.hex())
print(f'[model_registry] {len(data)} bytes -> model_registry.hex')
"
