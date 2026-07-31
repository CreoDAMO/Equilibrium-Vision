pragma circom 2.0.0;

// stationarity_smoke.circom — Reference circom equivalent of StationarityCircuit
//
// This file documents the public-input layout that any external snarkjs ceremony
// must match to produce keys compatible with equilibrium's Groth16 verifier.
//
// IMPORTANT: Do NOT use this circom file for the ceremony-smoke.sh test.
// That script uses `export-r1cs` to generate the R1CS directly from the ark
// StationarityCircuit, which guarantees exact R1CS compatibility.
//
// This circom is provided for:
//   - Auditors who want to understand the circuit
//   - Future circom-native ceremony workflow (once stationarity_v2 is ready)
//   - Matching the 4-public-input IC layout: IC.len == 5 (nPublic=4)
//
// Public inputs (in order — must match ark new_input() call order):
//   1. residual_fp   — miner's residual in fixed-point (FIXED_SCALE = 1e12)
//   2. threshold_fp  — block difficulty threshold in same scale
//   3. block_hash_lo — lower 64 bits of block hash (for binding)
//   4. block_hash_hi — upper 64 bits of block hash
//
// Private inputs:
//   difference — threshold_fp - residual_fp (proves miner is within threshold)
//
// Constraint: residual_fp + difference === threshold_fp
//
// NOTE: The full StationarityCircuit also enforces:
//   - difference != 0  (via inverse: difference * diff_inv === 1)
//   - difference < 2^64 (64-bit range check via bit decomposition)
// These additional constraints make the ark R1CS larger than what this circom
// produces. For exact compatibility, use export-r1cs instead of compiling this.

template Stationarity() {
    // Public signals (declared in same order as ark new_input() calls)
    signal input residual_fp;
    signal input threshold_fp;
    signal input block_hash_lo;
    signal input block_hash_hi;

    // Private signals
    signal input difference;
    signal input diff_inv;

    // Core constraint: residual + difference == threshold
    residual_fp + difference === threshold_fp;

    // Non-zero check: difference * diff_inv == 1
    // (ensures difference != 0; valid block has positive gap to threshold)
    signal diff_check;
    diff_check <== difference * diff_inv;
    diff_check === 1;

    // NOTE: The ark circuit additionally range-checks difference < 2^64
    // via bit decomposition. To match exactly, extend this with a 64-bit
    // range check using circomlib's Num2Bits or similar.
}

component main {public [residual_fp, threshold_fp, block_hash_lo, block_hash_hi]} = Stationarity();
