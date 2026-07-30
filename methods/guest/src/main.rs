#![no_main]

use risc0_zkvm::guest::env;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Input / Output types ──────────────────────────────────────────────────────
//
// IMPORTANT: field order must match `ZkvmInput` in
// `equilibrium/src/zk_proof.rs` — risc0 uses bincode/postcard serialisation
// where field order determines the on-wire layout.

/// All header fields needed to re-evaluate residual at a fixed nonce.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StationarityInput {
    pub prev_hash:       [u8; 32],
    pub merkle_root:     [u8; 32],
    pub timestamp:       u64,
    pub nonce:           u64,
    pub difficulty:      u64,
    pub recursion_depth: u32,
    /// Claimed residual (fixed-point, same scale as the chain validator).
    pub residual_fp:     u64,
    pub threshold_fp:    u64,
    pub cumulative_work: u64,
    pub height:          u64,
}

/// Journal output committed to the receipt.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StationarityOutput {
    /// Recomputed residual (must equal `StationarityInput::residual_fp`).
    pub residual_fp:     u64,
    pub threshold_fp:    u64,
    /// First 8 bytes of block_hash as a little-endian u64.
    pub block_hash_lo:   u64,
    /// Bytes 8-15 of block_hash as a little-endian u64.
    pub block_hash_hi:   u64,
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

/// Compute block_hash = SHA-256(prev_hash || nonce_le || timestamp_le || difficulty_le).
///
/// Must match:
///   - mobile_validator.rs `block_hash()`
///   - MiningWorker.kt `computeBlockHash()`
fn block_hash(prev: &[u8; 32], nonce: u64, timestamp: u64, difficulty: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prev);
    h.update(nonce.to_le_bytes());
    h.update(timestamp.to_le_bytes());
    h.update(difficulty.to_le_bytes());
    h.finalize().into()
}

/// Integer-only residual proxy aligned with the fixed-point consensus path.
///
/// **v1 (hash-fold):** folds SHA-256(all header fields) into a u64. This is
/// stronger than the old `residual + difference == threshold` witness because
/// it actually binds the residual to the header's nonce/prev_hash/timestamp.
///
/// **v2 (target):** replace with the same pure-integer extraction of
/// `StationarySolver::joint_residual_and_gradient` once that path is factored
/// into a shared `residual_fp` crate module.  Bump STATIONARITY_GUEST_ID when
/// switching.
fn residual_at_nonce(inp: &StationarityInput) -> u64 {
    let mut h = Sha256::new();
    h.update(inp.prev_hash);
    h.update(inp.merkle_root);
    h.update(inp.timestamp.to_le_bytes());
    h.update(inp.nonce.to_le_bytes());
    h.update(inp.difficulty.to_le_bytes());
    h.update(inp.recursion_depth.to_le_bytes());
    h.update(inp.cumulative_work.to_le_bytes());
    h.update(inp.height.to_le_bytes());
    let digest = h.finalize();

    // Fold 32 bytes into a u64 via XOR of 8-byte chunks (deterministic).
    let mut acc = 0u64;
    for chunk in digest.chunks(8) {
        let mut buf = [0u8; 8];
        buf[..chunk.len()].copy_from_slice(chunk);
        acc ^= u64::from_le_bytes(buf);
    }
    acc
}

// ── Guest entry ───────────────────────────────────────────────────────────────

risc0_zkvm::guest::entry!(main);

fn main() {
    let input: StationarityInput = env::read();

    // 1. Recompute the residual from header fields.
    let recomputed = residual_at_nonce(&input);

    // 2. Assert that the claimed residual matches the recomputed value.
    //    If the prover supplied a wrong residual_fp the guest panics here,
    //    so no valid receipt can be produced for a false claim.
    assert_eq!(
        recomputed,
        input.residual_fp,
        "claimed residual_fp does not match recomputed residual"
    );

    // 3. Assert residual is strictly below threshold.
    assert!(
        input.residual_fp < input.threshold_fp,
        "residual_fp must be strictly below threshold_fp"
    );

    // 4. Commit the block_hash limbs alongside residual and threshold so the
    //    host verifier can bind the receipt to a specific block header.
    let bh = block_hash(
        &input.prev_hash,
        input.nonce,
        input.timestamp,
        input.difficulty,
    );
    let lo = u64::from_le_bytes(bh[0..8].try_into().unwrap());
    let hi = u64::from_le_bytes(bh[8..16].try_into().unwrap());

    env::commit(&StationarityOutput {
        residual_fp:   input.residual_fp,
        threshold_fp:  input.threshold_fp,
        block_hash_lo: lo,
        block_hash_hi: hi,
    });
}
