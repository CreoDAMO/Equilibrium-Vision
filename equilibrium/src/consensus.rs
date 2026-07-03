use crate::chain_state::{BlockHeader, ChainState, TxCandidate};
use crate::zk_proof::StationarityProof;

pub struct Consensus;

impl Consensus {
    pub fn validate_block(
        header: &BlockHeader,
        txs: &[TxCandidate],
        proof: &StationarityProof,
        prev_state: &ChainState,
        current_state: &ChainState,
    ) -> bool {
        // 1. Verify the stationarity proof
        if !StationarityProof::verify(proof, header, current_state, 1e-8) {
            return false;
        }
        // 2. Check residual is within target (simplified; actual check would recompute residual)
        if header.residual > 1e-8 {
            return false;
        }
        // 3. Chain continuity: previous hash must match current tip
        // (In production, compare with actual chain tip)
        if prev_state.cumulative_work == 0 && header.prev_hash != [0u8; 32] {
            return false;
        }
        true
    }

    pub fn choose_fork(blocks: &[(BlockHeader, f64)]) -> &BlockHeader {
        blocks
            .iter()
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap()
            .0
    }
}
