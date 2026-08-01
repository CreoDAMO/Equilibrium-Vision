#!/usr/bin/env bash
# ceremony-smoke.sh — End-to-end snarkjs ceremony → ark prove/verify smoke test
#
# Requirements: snarkjs (npm install -g snarkjs), cargo (Rust)
# Usage:
#   ./scripts/ceremony-smoke.sh
#   ./scripts/ceremony-smoke.sh --skip-ptau

set -euo pipefail

SCRIPT_DIR="\( (dirname " \){BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$SCRIPT_DIR" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/ceremony-smoke-out"
SKIP_PTAU=${1:-""}

mkdir -p "$OUT_DIR"
cd "$ROOT"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }
ok()  { echo -e "\033[1;32m[OK] $*\033[0m"; }
warn() { echo -e "\033[1;33m[WARN] $*\033[0m"; }
fail(){ echo -e "\033[1;31m[FAIL] $*\033[0m" >&2; exit 1; }

log "Checking dependencies"
command -v snarkjs >/dev/null 2>&1 || fail "snarkjs not found — run: npm install -g snarkjs"
command -v cargo   >/dev/null 2>&1 || fail "cargo not found"
ok "dependencies OK"

log "Building mpc-ceremony binaries (release)"
cargo build --release \
    --manifest-path mpc-ceremony/Cargo.toml \
    --bin export-r1cs \
    --bin smoke-prove-verify \
    --bin mpc-ceremony
ok "binaries built"

log "Exporting StationarityCircuit R1CS"
./mpc-ceremony/target/release/export-r1cs --output "$OUT_DIR/stationarity.r1cs"
ok "R1CS exported → $OUT_DIR/stationarity.r1cs"

if [[ "$SKIP_PTAU" == "--skip-ptau" && -f "$OUT_DIR/pot_final.ptau" ]]; then
    log "Skipping PTAU generation (--skip-ptau)"
else
    log "Generating Powers of Tau (power=10)"
    snarkjs powersoftau new bn128 10 "$OUT_DIR/pot_0000.ptau" -v
    snarkjs powersoftau contribute "$OUT_DIR/pot_0000.ptau" "$OUT_DIR/pot_0001.ptau" \
        --name="ceremony-smoke-contributor" -v \
        -e="equilibrium ceremony smoke test entropy $(date +%s)"
    snarkjs powersoftau prepare phase2 "$OUT_DIR/pot_0001.ptau" "$OUT_DIR/pot_final.ptau" -v
    ok "PTAU ready → $OUT_DIR/pot_final.ptau"
fi

log "Groth16 setup (R1CS + PTAU → zkey)"
snarkjs groth16 setup \
    "$OUT_DIR/stationarity.r1cs" \
    "$OUT_DIR/pot_final.ptau" \
    "$OUT_DIR/circuit_0000.zkey"
ok "initial zkey → $OUT_DIR/circuit_0000.zkey"

log "Phase-2 contribution"
snarkjs zkey contribute \
    "$OUT_DIR/circuit_0000.zkey" \
    "$OUT_DIR/circuit_0001.zkey" \
    --name="smoke-p2-contrib" -v \
    -e="equilibrium smoke ceremony phase2 entropy $(date +%s)"
ok "contribution → $OUT_DIR/circuit_0001.zkey"

log "Applying random beacon"
BEACON_HEX="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
snarkjs zkey beacon \
    "$OUT_DIR/circuit_0001.zkey" \
    "$OUT_DIR/circuit_final.zkey" \
    "$BEACON_HEX" 10 \
    -n="Equilibrium Smoke Final Beacon"
ok "final zkey → $OUT_DIR/circuit_final.zkey"

log "Exporting verification_key.json"
snarkjs zkey export verificationkey \
    "$OUT_DIR/circuit_final.zkey" \
    "$OUT_DIR/verification_key.json"
ok "VK JSON → $OUT_DIR/verification_key.json"

log "Importing zkey into ark (import-zkey)"
./mpc-ceremony/target/release/mpc-ceremony import-zkey \
    --zkey   "$OUT_DIR/circuit_final.zkey" \
    --vk-out "$OUT_DIR/verification_key.bin" \
    --pk-out "$OUT_DIR/proving_key.bin"
ok "ark keys → $OUT_DIR/proving_key.bin + verification_key.bin"

log "Cross-check: import-vk from JSON"
./mpc-ceremony/target/release/mpc-ceremony import-vk \
    --json   "$OUT_DIR/verification_key.json" \
    --vk-out "$OUT_DIR/verification_key_json.bin"
ok "JSON VK → $OUT_DIR/verification_key_json.bin"

log "VK binary parity (zkey import vs JSON import)"
if cmp -s "$OUT_DIR/verification_key.bin" "$OUT_DIR/verification_key_json.bin"; then
    ok "VK bins identical — zkey and JSON import produce the same bytes"
else
    warn "VK bins differ — check 2 in smoke-prove-verify will detail field mismatch"
fi

log "Proving and verifying with imported keys (ark Groth16 + diagnostics)"
./mpc-ceremony/target/release/smoke-prove-verify \
    --pk-bin "$OUT_DIR/proving_key.bin" \
    --vk-bin "$OUT_DIR/verification_key.bin" \
    --vk-json-bin "$OUT_DIR/verification_key_json.bin"

echo ""
echo "CEREMONY SMOKE TEST PASSED"
echo "Artifacts in: $OUT_DIR"
echo "PROVING_KEY_DIR=$OUT_DIR"
