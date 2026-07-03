use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockHeader {
    pub prev_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub timestamp: u64,
    pub nonce: u64,
    pub difficulty: u64,
    pub recursion_depth: u32,
    pub residual: f64,
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

pub fn compute_coinbase_reward(base: u64, residual: f64) -> u64 {
    let quality_factor = (1.0 / (residual + 1e-6)).min(1.0);
    (base as f64 * quality_factor) as u64
}
