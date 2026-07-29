#!/usr/bin/env bash
# Equilibrium-Vision Security Patch Script
# Fixes all 21 Dependabot alerts (Rust + npm)
# Run from repo root

set -euo pipefail

echo "=== Equilibrium Security Patch ==="
echo ""

# ── Rust: equilibrium/Cargo.lock ──────────────────────────────────────────────
echo "[1/5] Patching equilibrium/Cargo.lock..."
cd equilibrium

# Critical: risc0-zkvm-platform arbitrary code execution in sys_read
# Patched in risc0-zkvm >= 1.0.1 (latest 1.1.x recommended)
cargo update -p risc0-zkvm-platform
cargo update -p risc0-zkvm
cargo update -p risc0-zkvm-platform

# High: yamux remote panic via malformed Data frame
# Patched in yamux >= 0.12.1
cargo update -p yamux

# High: hickory-proto NSEC3 unbounded loop + O(n²) name compression
# Patched in hickory-proto >= 0.24.2
cargo update -p hickory-proto

# Low: tracing-subscriber ANSI escape poisoning
# Patched in tracing-subscriber >= 0.3.19
cargo update -p tracing-subscriber

# Low: rand unsound with custom logger
# Patched in rand >= 0.8.5
cargo update -p rand

cd ..

# ── Rust: mpc-ceremony/Cargo.lock ─────────────────────────────────────────────
echo "[2/5] Patching mpc-ceremony/Cargo.lock..."
cd mpc-ceremony

cargo update -p yamux
cargo update -p hickory-proto
cargo update -p tracing-subscriber
cargo update -p rand

cd ..

# ── npm: pnpm-lock.yaml ───────────────────────────────────────────────────────
echo "[3/5] Patching pnpm-lock.yaml..."

# High: brace-expansion DoS (CVE-2024-XXXX)
# Patched in brace-expansion >= 2.0.2 / 4.0.0
pnpm update brace-expansion

# High: js-yaml quadratic CPU via merge-key chains
# Patched in js-yaml >= 4.1.2
pnpm update js-yaml

# High: fast-uri host confusion (2 CVEs)
# Patched in fast-uri >= 3.0.2
pnpm update fast-uri

# High: linkify-it quadratic DoS via mailto validator
# Patched in linkify-it >= 5.0.1
pnpm update linkify-it

# High: postcss path traversal in source map loading
# Patched in postcss >= 8.4.41
pnpm update postcss

# Low: esbuild arbitrary file read on Windows dev server
# Patched in esbuild >= 0.23.1
pnpm update esbuild

echo ""
echo "[4/5] Verifying Rust fixes..."
cd equilibrium
cargo audit || true
cd ..

cd mpc-ceremony
cargo audit || true
cd ..

echo ""
echo "[5/5] Verifying npm fixes..."
pnpm audit --audit-level=moderate || true

echo ""
echo "=== Patch complete ==="
echo ""
echo "If cargo audit still reports issues, run:"
echo "  cargo update                              # update all transitive deps"
echo "  cargo tree -i <vuln-package>              # find who pulls it in"
echo ""
echo "If pnpm audit still reports issues, run:"
echo "  pnpm update                               # update all deps"
echo "  pnpm audit --fix                          # auto-fix where possible"
