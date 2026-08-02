#!/usr/bin/env bash
# Install the rustup-managed Rust toolchain needed to rebuild WASM contracts.
#
# IDEMPOTENT — safe to run repeatedly. On a fresh Replit container the
# Nix-provided rustup binary is always present (declared in replit.nix) but
# no managed toolchains are installed. This script installs the pinned
# toolchain and the wasm32-unknown-unknown target so that any of
# contracts/*/build.sh can compile successfully.
#
# Pinned version: 1.97.0
#   Must match rust-toolchain.toml in each contract directory.
#   WASM codegen is NOT byte-for-byte stable across rustc/LLVM versions —
#   changing this value will produce a different .hex even for unchanged
#   source, causing the CI staleness check to fail.
#
# GLIBC_TUNABLES / RUST_MIN_STACK:
#   Rustup's prebuilt rustc_driver.so can crash with
#   "cannot allocate memory in static TLS block" when cargo spawns rustc
#   as a subprocess in this NixOS container. The env vars exported here
#   and in contracts/*/build.sh work around that glibc TLS reservation
#   issue. They are harmless on other platforms.
#   See .agents/memory/rust-wasm-toolchain.md for the full explanation.
#
# Usage (from repo root):
#   bash scripts/setup-wasm-toolchain.sh
#
# Called automatically by:
#   bash scripts/setup-replit.sh   (run once after import or container reset)

set -euo pipefail

TOOLCHAIN="1.97.0"
TARGET="wasm32-unknown-unknown"

# Export crash-workaround vars for the rustup/rustc subprocesses themselves.
export GLIBC_TUNABLES=glibc.rtld.optional_static_tls=4000000
export RUST_MIN_STACK=33554432

echo ""
echo "┌─ WASM toolchain setup ─────────────────────────────────────────────────"
echo "│  Toolchain : ${TOOLCHAIN}"
echo "│  Target    : ${TARGET}"
echo "└────────────────────────────────────────────────────────────────────────"

# ── 1. Toolchain install (fast-path if already present) ───────────────────────
if rustup toolchain list 2>/dev/null | grep -qF "${TOOLCHAIN}"; then
  echo "[wasm-toolchain] ✓ Toolchain ${TOOLCHAIN} already installed — skipping."
else
  echo "[wasm-toolchain] Installing Rust ${TOOLCHAIN} (minimal profile)…"
  rustup toolchain install "${TOOLCHAIN}" --profile minimal
  echo "[wasm-toolchain] ✓ Toolchain ${TOOLCHAIN} installed."
fi

# ── 2. wasm32 target install (fast-path if already present) ───────────────────
if rustup target list --toolchain "${TOOLCHAIN}" 2>/dev/null \
     | grep -qF "${TARGET} (installed)"; then
  echo "[wasm-toolchain] ✓ Target ${TARGET} already present — skipping."
else
  echo "[wasm-toolchain] Adding target ${TARGET} to toolchain ${TOOLCHAIN}…"
  rustup target add "${TARGET}" --toolchain "${TOOLCHAIN}"
  echo "[wasm-toolchain] ✓ Target ${TARGET} added."
fi

# ── 3. Verify and print binary location ───────────────────────────────────────
TOOLCHAIN_BIN_DIR=""
while IFS= read -r line; do
  if echo "$line" | grep -qF "${TOOLCHAIN}"; then
    TOOLCHAIN_BIN_DIR="$(echo "$line" | awk '{print $NF}')/bin"
    break
  fi
done < <(rustup toolchain list --verbose 2>/dev/null)

if [ -n "${TOOLCHAIN_BIN_DIR}" ] && [ -d "${TOOLCHAIN_BIN_DIR}" ]; then
  echo "[wasm-toolchain] Toolchain bin : ${TOOLCHAIN_BIN_DIR}"
  echo "[wasm-toolchain] cargo version : $("${TOOLCHAIN_BIN_DIR}/cargo" --version)"
else
  # Fallback: derive path from RUSTUP_HOME
  RUHOME="${RUSTUP_HOME:-$HOME/.rustup}"
  TOOLCHAIN_BIN_DIR="${RUHOME}/toolchains/${TOOLCHAIN}-x86_64-unknown-linux-gnu/bin"
  if [ -d "${TOOLCHAIN_BIN_DIR}" ]; then
    echo "[wasm-toolchain] Toolchain bin : ${TOOLCHAIN_BIN_DIR}"
  else
    echo "[wasm-toolchain] WARNING: could not locate toolchain bin dir; contracts/*/build.sh may fail." >&2
  fi
fi

echo ""
echo "[wasm-toolchain] ✓ Ready. To rebuild a contract:"
echo "   bash contracts/cross_chain_relay/build.sh"
echo "   bash contracts/model_registry/build.sh"
echo "   bash contracts/arbitrage/build.sh"
echo ""
