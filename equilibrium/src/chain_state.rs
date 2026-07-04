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
pub fn compute_coinbase_reward(base: u64, residual_fp: i64) -> u64 {
    let residual = residual_to_float(residual_fp);
    let quality_factor = (1.0 / (residual + 1e-6)).min(1.0);
    (base as f64 * quality_factor) as u64
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
}
