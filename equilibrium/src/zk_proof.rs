use sha2::{Sha256, Digest};
use rand::Rng;
use crate::chain_state::{BlockHeader, TxCandidate, ChainState};

pub struct StationarityProof {
    pub challenge: [u8; 32],
    pub response: u64,
    pub revealed_txs: Vec<TxCandidate>,
}

impl StationarityProof {
    pub fn prove(
        header: &BlockHeader,
        txs: &[TxCandidate],
        _state: &ChainState,
        _target_residual: f64,
    ) -> Self {
        let mut rng = rand::thread_rng();
        let nonce_blinding: u64 = rng.gen();
        let mut hasher = Sha256::new();
        hasher.update(header.prev_hash);
        hasher.update(&header.merkle_root);
        hasher.update(header.timestamp.to_le_bytes());
        hasher.update(nonce_blinding.to_le_bytes());
        for tx in txs {
            hasher.update(&tx.hash);
        }
        let challenge = hasher.finalize().into();
        let response = header.nonce ^ nonce_blinding;

        Self {
            challenge,
            response,
            revealed_txs: txs.to_vec(),
        }
    }

    pub fn verify(
        &self,
        header: &BlockHeader,
        _state: &ChainState,
        _target_residual: f64,
    ) -> bool {
        let mut hasher = Sha256::new();
        hasher.update(header.prev_hash);
        hasher.update(&header.merkle_root);
        hasher.update(header.timestamp.to_le_bytes());
        hasher.update(self.response.to_le_bytes());
        for tx in &self.revealed_txs {
            hasher.update(&tx.hash);
        }
        let recomputed: [u8; 32] = hasher.finalize().into();
        recomputed == self.challenge
    }
}
