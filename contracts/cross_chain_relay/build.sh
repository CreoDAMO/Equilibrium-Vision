#!/usr/bin/env bash
# Build the cross_chain_relay WASM contract and hex-encode it for deployment.
#
# Requires a rustup-managed toolchain with the wasm32-unknown-unknown target.
# The exact compiler version is pinned via rust-toolchain.toml in this
# directory (currently 1.88.0) — WASM codegen is NOT byte-for-byte stable
# across rustc/LLVM versions, so building with a floating "stable" toolchain
# makes the checked-in .hex non-reproducible and will fail CI's staleness
# check even when the source hasn't changed. One-time setup (if not already
# done):
#   export RUSTUP_HOME="$HOME/workspace/.local/share/.rustup"
#   export CARGO_HOME="$HOME/workspace/.local/share/.cargo"
#   export PATH="$CARGO_HOME/bin:$PATH"
#   rustup toolchain install 1.88.0 --profile minimal
#   rustup target add wasm32-unknown-unknown --toolchain 1.88.0
#
# The GLIBC_TUNABLES env var works around a NixOS/glibc "cannot allocate
# memory in static TLS block" crash when rustup's prebuilt rustc_driver.so is
# loaded in this container — see .agents/memory/rust-wasm-toolchain.md.
set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Support both legacy path ($HOME/.rustup) and the path used when rustup is
# installed inside the workspace (.local/share/.rustup / .local/share/.cargo).
if [ -d "$HOME/.rustup" ]; then
  RUSTUP_HOME_CANDIDATE="$HOME/.rustup"
  CARGO_HOME_CANDIDATE="$HOME/.cargo"
elif [ -d "$HOME/workspace/.local/share/.rustup" ]; then
  RUSTUP_HOME_CANDIDATE="$HOME/workspace/.local/share/.rustup"
  CARGO_HOME_CANDIDATE="$HOME/workspace/.local/share/.cargo"
else
  echo "[cross_chain_relay] ERROR: rustup not found. Run: curl https://sh.rustup.rs | sh -s -- -y" >&2
  exit 1
fi

export RUSTUP_HOME="$RUSTUP_HOME_CANDIDATE"
export CARGO_HOME="$CARGO_HOME_CANDIDATE"
TOOLCHAIN_BIN="$RUSTUP_HOME/toolchains/1.88.0-x86_64-unknown-linux-gnu/bin"
export PATH="$TOOLCHAIN_BIN:$CARGO_HOME/bin:$PATH"
export GLIBC_TUNABLES=glibc.rtld.optional_static_tls=4000000
export RUST_MIN_STACK=33554432

echo "[cross_chain_relay] Building wasm32 contract..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release 2>&1

WASM="target/wasm32-unknown-unknown/release/cross_chain_relay.wasm"
if [ ! -f "$WASM" ]; then
  echo "[cross_chain_relay] ERROR: WASM binary not found at $WASM" >&2
  exit 1
fi

python3 -c "
with open('$WASM','rb') as f: data = f.read()
with open('cross_chain_relay.hex','w') as f: f.write(data.hex())
print(f'[cross_chain_relay] {len(data)} bytes -> cross_chain_relay.hex')
"
