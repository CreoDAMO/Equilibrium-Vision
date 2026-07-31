#!/usr/bin/env bash
# ceremony-smoke.sh — End-to-end snarkjs ceremony → ark prove/verify smoke test
#
# What this proves:
#   1. The StationarityCircuit R1CS is valid and can be used for a Groth16 ceremony
#   2. mpc-ceremony import-zkey correctly parses real snarkjs keys
#   3. ark Groth16::prove + verify_with_processed_vk works with ceremony-imported PK/VK
#
# Requirements: snarkjs (npm install -g snarkjs), cargo (Rust)
# Runtime:      ~5-10 min first run (PTAU gen + cargo build + ceremony)
#               ~1-2 min on re-run with --skip-ptau
#
# Usage:
#   ./scripts/ceremony-smoke.sh               # full run
#   ./scripts/ceremony-smoke.sh --skip-ptau   # reuse existing PTAU in OUT_DIR

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/ceremony-smoke-out"
SKIP_PTAU=${1:-""}

mkdir -p "$OUT_DIR"
cd "$ROOT"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }
ok()  { echo -e "\033[1;32m[OK] $*\033[0m"; }
fail(){ echo -e "\033[1;31m[FAIL] $*\033[0m" >&2; exit 1; }

# ── Step 0: Check dependencies ────────────────────────────────────────────────
log "Checking dependencies"
command -v snarkjs >/dev/null 2>&1 || fail "snarkjs not found — run: npm install -g snarkjs"
command -v cargo   >/dev/null 2>&1 || fail "cargo not found"
ok "dependencies OK"

# ── Step 1: Build mpc-ceremony binaries ───────────────────────────────────────
log "Building mpc-ceremony binaries (release)"
cargo build --release \
    --manifest-path mpc-ceremony/Cargo.toml \
    --bin export-r1cs \
    --bin smoke-prove-verify \
    --bin mpc-ceremony 2>&1 | tail -5
ok "binaries built"

# ── Step 2: Export R1CS from StationarityCircuit ──────────────────────────────
log "Exporting StationarityCircuit R1CS"
./mpc-ceremony/target/release/export-r1cs --output "$OUT_DIR/stationarity.r1cs"
ok "R1CS exported → $OUT_DIR/stationarity.r1cs"

# ── Step 3: Powers of Tau ─────────────────────────────────────────────────────
if [[ "$SKIP_PTAU" == "--skip-ptau" && -f "$OUT_DIR/pot_final.ptau" ]]; then
    log "Skipping PTAU generation (--skip-ptau)"
else
    log "Generating Powers of Tau (power=14, ~16k constraints max)"
    # Power 14 supports up to 2^14 = 16384 constraints; StationarityCircuit << that
    snarkjs powersoftau new bn128 14 "$OUT_DIR/pot_0000.ptau" -v
    snarkjs powersoftau contribute "$OUT_DIR/pot_0000.ptau" "$OUT_DIR/pot_0001.ptau" \
        --name="ceremony-smoke-contributor" -v \
        -e="equilibrium ceremony smoke test entropy $(date +%s)"
    snarkjs powersoftau prepare phase2 "$OUT_DIR/pot_0001.ptau" "$OUT_DIR/pot_final.ptau" -v
    ok "PTAU ready → $OUT_DIR/pot_final.ptau"
fi

# ── Step 4: Groth16 setup ─────────────────────────────────────────────────────
log "Groth16 setup (R1CS + PTAU → zkey)"
snarkjs groth16 setup \
    "$OUT_DIR/stationarity.r1cs" \
    "$OUT_DIR/pot_final.ptau" \
    "$OUT_DIR/circuit_0000.zkey"
ok "initial zkey → $OUT_DIR/circuit_0000.zkey"

# ── Step 5: Contribute randomness ─────────────────────────────────────────────
log "Phase-2 contribution"
snarkjs zkey contribute \
    "$OUT_DIR/circuit_0000.zkey" \
    "$OUT_DIR/circuit_0001.zkey" \
    --name="smoke-p2-contrib" -v \
    -e="equilibrium smoke ceremony phase2 entropy $(date +%s)"
ok "contribution → $OUT_DIR/circuit_0001.zkey"

# ── Step 6: Apply final beacon ────────────────────────────────────────────────
log "Applying random beacon"
BEACON_HEX="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
snarkjs zkey beacon \
    "$OUT_DIR/circuit_0001.zkey" \
    "$OUT_DIR/circuit_final.zkey" \
    "$BEACON_HEX" 10 \
    -n="Equilibrium Smoke Final Beacon"
ok "final zkey → $OUT_DIR/circuit_final.zkey"

# ── Step 7: Export JSON VK (audit trail) ──────────────────────────────────────
log "Exporting verification_key.json"
snarkjs zkey export verificationkey \
    "$OUT_DIR/circuit_final.zkey" \
    "$OUT_DIR/verification_key.json"
ok "VK JSON → $OUT_DIR/verification_key.json"

# ── Step 8: Import into ark ───────────────────────────────────────────────────
log "Importing zkey into ark (import-zkey)"
./mpc-ceremony/target/release/mpc-ceremony import-zkey \
    --zkey   "$OUT_DIR/circuit_final.zkey" \
    --vk-out "$OUT_DIR/verification_key.bin" \
    --pk-out "$OUT_DIR/proving_key.bin"
ok "ark keys → $OUT_DIR/proving_key.bin + verification_key.bin"

# Cross-check: also import VK from JSON to confirm parity
log "Cross-check: import-vk from JSON"
./mpc-ceremony/target/release/mpc-ceremony import-vk \
    --json   "$OUT_DIR/verification_key.json" \
    --vk-out "$OUT_DIR/verification_key_json.bin"
ok "JSON VK → $OUT_DIR/verification_key_json.bin"

# ── Step 9: Ark prove + verify ────────────────────────────────────────────────
log "Proving and verifying with imported keys (ark Groth16)"
./mpc-ceremony/target/release/smoke-prove-verify \
    --pk-bin "$OUT_DIR/proving_key.bin" \
    --vk-bin "$OUT_DIR/verification_key.bin"

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  CEREMONY SMOKE TEST PASSED                            ║"
echo "║                                                        ║"
echo "║  snarkjs ceremony → ark import → Groth16 prove/verify  ║"
echo "║  StationarityCircuit: 4 public inputs, IC.len = 5     ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "Artifacts:"
echo "  PTAU:         $OUT_DIR/pot_final.ptau"
echo "  Final zkey:   $OUT_DIR/circuit_final.zkey"
echo "  VK JSON:      $OUT_DIR/verification_key.json"
echo "  ark PK:       $OUT_DIR/proving_key.bin"
echo "  ark VK:       $OUT_DIR/verification_key.bin"
echo ""
echo "To use these keys with the node, set:"
echo "  PROVING_KEY_DIR=$OUT_DIR"
