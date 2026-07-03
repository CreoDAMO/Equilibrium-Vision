#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-jni.sh — Cross-compile the Equilibrium Rust core for Android via
# cargo-ndk.  Run this once before opening the project in Android Studio or
# invoking `./gradlew assembleRelease`.
#
# Prerequisites
# ─────────────
#  1. Rust toolchain with Android targets:
#       rustup target add aarch64-linux-android   # arm64-v8a  (modern devices)
#       rustup target add armv7-linux-androideabi # armeabi-v7a (32-bit ARMv7)
#       rustup target add x86_64-linux-android    # x86_64 emulator
#
#  2. cargo-ndk:
#       cargo install cargo-ndk
#
#  3. Android NDK r25 or later.  Set one of:
#       export ANDROID_NDK_HOME=/path/to/ndk
#     or ensure `ndk-bundle` lives under $ANDROID_HOME/ndk-bundle.
#
# Usage
# ─────
#   ./build-jni.sh           # release build (default)
#   ./build-jni.sh debug     # debug build
#
# Output
# ──────
#   app/src/main/jniLibs/
#     armeabi-v7a/libequilibrium_core.so
#     arm64-v8a/libequilibrium_core.so
#     x86_64/libequilibrium_core.so
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROFILE="${1:-release}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The Rust crate lives three directories above this script:
#   equilibrium/mobile/android/build-jni.sh  →  equilibrium/
RUST_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/app/src/main/jniLibs"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Equilibrium Android JNI build (${PROFILE})$(printf '%*s' $((30 - ${#PROFILE})) '')║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "  Rust root : ${RUST_ROOT}"
echo "  NDK output: ${OUT_DIR}"
echo ""

if ! command -v cargo-ndk &>/dev/null; then
  echo "ERROR: cargo-ndk not found. Install with:"
  echo "  cargo install cargo-ndk"
  exit 1
fi

cd "${RUST_ROOT}"

cargo ndk \
  -t armeabi-v7a \
  -t arm64-v8a \
  -t x86_64 \
  -o "${OUT_DIR}" \
  build --${PROFILE} --lib

echo ""
echo "✓  JNI libraries written:"
echo "   ${OUT_DIR}/armeabi-v7a/libequilibrium_core.so"
echo "   ${OUT_DIR}/arm64-v8a/libequilibrium_core.so"
echo "   ${OUT_DIR}/x86_64/libequilibrium_core.so"
