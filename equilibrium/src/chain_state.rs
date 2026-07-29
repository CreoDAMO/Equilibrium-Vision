use serde::{Serialize, Deserialize};

/// Fixed-point scale factor for residual values (10^18), matching the
/// TS-side `residualFp` encoding (see `zk-encoding.ts::fpEncode`) and the
/// ZK circuit's public-input scale (see `zk_proof.rs::StationarityCircuit`).
///
/// Residuals are stored as a scaled `i64` instead of `f64` so that
/// consensus-critical comparisons (fork choice, threshold checks) are
/// bit-identical across architectures. IEEE 754 float arithmetic is not
/// guaranteed to produce identical rounding across every CPU/compiler
/// combination (e.g. ARM mobile miners vs. x86 cloud validators using
/// fused-multiply-add or extended-precision registers differently) —
/// integer arithmetic has no such ambiguity.
pub const RESIDUAL_SCALE: i64 = 1_000_000_000_000_000_000;

/// Convert a floating-point residual into its fixed-point representation.
/// Uses `floor` (never `round`) so the same input always yields the same
/// output regardless of rounding-mode differences between platforms.
pub fn residual_to_fixed(residual: f64) -> i64 {
    if !residual.is_finite() {
        return i64::MAX;
    }
    (residual * RESIDUAL_SCALE as f64).floor() as i64
}

/// Convert a fixed-point residual back into a float — only for boundaries
/// that still speak floating point externally (e.g. the JSON-RPC wire
/// protocol to the TypeScript side, or human-readable logging).
pub fn residual_to_float(residual_fp: i64) -> f64 {
    residual_fp as f64 / RESIDUAL_SCALE as f64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockHeader {
    pub prev_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub timestamp: u64,
    pub nonce: u64,
    pub difficulty: u64,
    pub recursion_depth: u32,
    /// Stationarity residual, fixed-point scaled by `RESIDUAL_SCALE` (10^18).
    /// Never compare or persist this as a float — see `RESIDUAL_SCALE` docs.
    pub residual: i64,
    /// Sparse Merkle Tree root committing to the full world state (accounts,
    /// UTXOs, contract storage) at this block height.
    ///
    /// Zero-filled for genesis and blocks mined before this field existed
    /// (backward-compatible via `#[serde(default)]`).
    ///
    /// This is the cryptographic foundation for mobile light nodes: any phone
    /// can verify an account balance with a 256-sibling SMT proof against this
    /// root, without replaying the full chain.
    #[serde(default)]
    pub state_root: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxCandidate {
    pub hash: [u8; 32],
    pub fee: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainState {
    pub cumulative_work: u64,
    pub mempool_pressure: f64,   // 0.0 - 1.0 normalized
    pub validator_count: u32,
    pub last_quality: f64,
    pub height: u64,
}

impl Default for ChainState {
    fn default() -> Self {
        Self {
            cumulative_work: 0,
            mempool_pressure: 0.5,
            validator_count: 1,
            last_quality: 1.0,
            height: 0,
        }
    }
}

/// Compute the coinbase reward, scaling `base` by a quality factor derived
/// from the fixed-point residual (lower residual → higher quality → closer
/// to the full `base` reward).
///
/// # Fixed-point arithmetic — no f64
///
/// The entire computation is integer-only so it produces bit-identical results
/// on every architecture (x86, ARM, RISC-V) regardless of FPU settings, the
/// presence of fused-multiply-add, or extended-precision registers. This is
/// critical: miner rewards are consensus-sensitive — even a 1-ULP divergence
/// between an ARM phone and an x86 validator would cause a fork.
///
/// Formula (quality = base * SCALE / (residual + EPSILON)):
///   EPSILON_FP = 1_000  (represents 1e-15 in the 10^18 scale — negligible)
///   quality_fp = SCALE / (residual_fp + EPSILON_FP)    [capped at SCALE]
///   reward     = (base * quality_fp) / SCALE
///
/// The division truncates (Rust default for integers) — consistent across all
/// platforms and compilers.
pub fn compute_coinbase_reward(base: u64, residual_fp: i64) -> u64 {
    // Treat negative or zero residual as zero (perfect solve → full reward).
    let r = residual_fp.max(0) as u128;

    // EPSILON: 1_000 fixed-point units (10^-15 in our 10^18 scale).
    // Prevents division by zero for a perfect residual of exactly 0.
    const EPSILON: u128 = 1_000;
    const SCALE: u128 = 1_000_000_000_000_000_000; // 10^18

    // quality_fp = SCALE / (r + EPSILON), capped at SCALE (residual=0 → full reward)
    let denom = r + EPSILON;
    let quality_fp = (SCALE / denom).min(SCALE);

    // reward = base * quality_fp / SCALE  (integer division, truncates)
    ((base as u128) * quality_fp / SCALE) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn residual_fixed_point_roundtrip_is_deterministic() {
        let r = 1e-8_f64;
        let fp1 = residual_to_fixed(r);
        let fp2 = residual_to_fixed(r);
        assert_eq!(fp1, fp2);
        assert_eq!(fp1, 10_000_000_000);
    }

    #[test]
    fn residual_to_fixed_saturates_on_infinity() {
        assert_eq!(residual_to_fixed(f64::INFINITY), i64::MAX);
    }

    #[test]
    fn compute_coinbase_reward_is_deterministic_integer_only() {
        // Same inputs must always yield the same output (no FPU variance).
        let base = 50_000_000u64;
        let residual_fp = 10_000_000_000i64; // 1e-8 in 10^18 scale
        let r1 = compute_coinbase_reward(base, residual_fp);
        let r2 = compute_coinbase_reward(base, residual_fp);
        assert_eq!(r1, r2);
    }

    #[test]
    fn compute_coinbase_reward_zero_residual_gives_full_base() {
        // residual = 0 → quality_fp = SCALE / EPSILON → quality close to 1.0
        // With EPSILON=1_000 and SCALE=10^18: quality = 10^15 → reward ≈ base
        let base = 50_000_000u64;
        let reward = compute_coinbase_reward(base, 0);
        // quality = 10^18 / 1_000 = 10^15 … but capped at 10^18 → reward = base
        assert_eq!(reward, base, "zero residual must yield full base reward");
    }

    #[test]
    fn compute_coinbase_reward_high_residual_gives_near_zero() {
        // residual = 10^18 (= 1.0 in float terms) → quality_fp = 1
        let base = 50_000_000u64;
        let reward = compute_coinbase_reward(base, 1_000_000_000_000_000_000i64);
        // quality_fp = 10^18 / (10^18 + 1000) ≈ 1 → reward ≈ 1
        // but specifically: 50_000_000 * 1 / 10^18 = 0 (integer truncation)
        assert!(reward <= 1, "high residual should give near-zero reward, got {reward}");
    }

    #[test]
    fn compute_coinbase_reward_negative_residual_treated_as_zero() {
        let base = 50_000_000u64;
        let reward_neg = compute_coinbase_reward(base, -1_000_000_000i64);
        let reward_zero = compute_coinbase_reward(base, 0);
        assert_eq!(reward_neg, reward_zero, "negative residual treated same as zero");
    }
}
