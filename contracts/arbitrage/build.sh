#!/usr/bin/env bash
# Build the arbitrage WASM contract and hex-encode it for deployment.
#
# Requires a rustup-managed toolchain with the wasm32-unknown-unknown target
# (the Nix-provided `rust-mixed` toolchain does not ship wasm32 std libs).
# The exact compiler version is pinned via rust-toolchain.toml in this
# directory (currently 1.88.0) — WASM codegen is NOT byte-for-byte stable
# across rustc/LLVM versions, so building with a floating "stable" toolchain
# makes the checked-in .hex non-reproducible and will fail CI's staleness
# check even when the source hasn't changed. One-time setup, if not already
# done:
#   rustup toolchain install 1.88.0 --profile minimal
#   rustup target add wasm32-unknown-unknown --toolchain 1.88.0
#
# The GLIBC_TUNABLES env var works around a NixOS/glibc "cannot allocate
# memory in static TLS block" crash when rustup's prebuilt rustc_driver.so is
# loaded in this container — see .agents/memory/rust-wasm-toolchain.md.
set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLCHAIN_BIN="$HOME/.rustup/toolchains/1.88.0-x86_64-unknown-linux-gnu/bin"
export RUSTUP_HOME="$HOME/.rustup"
export CARGO_HOME="$HOME/.cargo"
export PATH="$TOOLCHAIN_BIN:$PATH"
export GLIBC_TUNABLES=glibc.rtld.optional_static_tls=4000000
export RUST_MIN_STACK=33554432

echo "[arbitrage] Building wasm32 contract..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release 2>&1

WASM="target/wasm32-unknown-unknown/release/arbitrage.wasm"
if [ ! -f "$WASM" ]; then
  echo "[arbitrage] ERROR: WASM binary not found at $WASM" >&2
  exit 1
fi

python3 -c "
with open('$WASM','rb') as f: data = f.read()
with open('arbitrage.hex','w') as f: f.write(data.hex())
print(f'[arbitrage] {len(data)} bytes -> arbitrage.hex')
"
