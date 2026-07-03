use sha2::{Sha256, Digest};
use crate::chain_state::{BlockHeader, ChainState, TxCandidate};

pub struct StationarySolver {
    pub max_iter: u64,
    pub target_residual: f64,
    pub learning_rate: f64,
    pub recursion_depth: u32,
}

impl StationarySolver {
    pub fn new(max_iter: u64, target_residual: f64, learning_rate: f64, recursion_depth: u32) -> Self {
        Self { max_iter, target_residual, learning_rate, recursion_depth }
    }

    /// Full joint residual and gradient, with all cross-terms explicit.
    fn joint_residual_and_gradient(
        header: &BlockHeader,
        txs: &[TxCandidate],
        state: &ChainState,
        lambda: &[f64; 5],
    ) -> (f64, f64) {
        // 1. Hash constraint
        let mut hasher = Sha256::new();
        hasher.update(header.prev_hash);
        hasher.update(&header.merkle_root);
        hasher.update(header.timestamp.to_le_bytes());
        hasher.update(header.nonce.to_le_bytes());
        for tx in txs {
            hasher.update(&tx.hash);
        }
        let hash = hasher.finalize();
        let hash_val = u64::from_le_bytes(hash[0..8].try_into().unwrap());
        let difficulty = header.difficulty as f64;
        let hash_violation = (hash_val as f64 - difficulty).max(0.0);
        let hash_grad = if hash_val as f64 > difficulty { 1.0 } else { 0.0 };

        // 2. Structural symmetry: H ≈ difficulty / φ
        let phi = (1.0 + 5.0f64.sqrt()) / 2.0;
        let structural_violation = ((hash_val as f64) - difficulty / phi).abs();
        let structural_grad = 2.0 * ((hash_val as f64) - difficulty / phi);

        // 3. Chain continuity
        let chain_violation = if state.cumulative_work > 0 { 0.0 } else { 1.0 };
        let chain_grad = 0.0;

        // 4. Network pressure (mempool stress)
        let mempool_violation = state.mempool_pressure;
        let mempool_grad = 0.0;

        // 5. Transaction fee cross-term
        let total_fees: u64 = txs.iter().map(|tx| tx.fee).sum();
        let fee_deficit = (state.mempool_pressure * 1_000_000.0) as u64;
        let tx_violation = if total_fees >= fee_deficit { 0.0 } else { (fee_deficit - total_fees) as f64 / 1_000_000.0 };
        let tx_grad = if total_fees < fee_deficit { -1.0 } else { 0.0 };

        let residual = lambda[0] * hash_violation.powi(2)
                     + lambda[1] * structural_violation.powi(2)
                     + lambda[2] * chain_violation.powi(2)
                     + lambda[3] * mempool_violation.powi(2)
                     + lambda[4] * tx_violation.powi(2);

        let gradient = lambda[0] * hash_grad
                     + lambda[1] * structural_grad
                     + lambda[2] * chain_grad
                     + lambda[3] * mempool_grad
                     + lambda[4] * tx_grad;

        (residual, gradient)
    }

    fn update_multipliers(lambda: &mut [f64; 5], violations: &[f64; 5], step: f64) {
        for i in 0..5 {
            lambda[i] = (lambda[i] + step * violations[i]).max(0.0);
        }
    }

    /// Full structural optimizer: jointly optimizes nonce and transaction set.
    pub fn optimize_full(
        &self,
        mut header: BlockHeader,
        mut txs: Vec<TxCandidate>,
        state: &ChainState,
    ) -> Option<(BlockHeader, Vec<TxCandidate>)> {
        let mut lambda = [1.0; 5];
        let mut best_residual = f64::INFINITY;
        let mut best_solution = None;

        for _ in 0..self.recursion_depth {
            for _ in 0..self.max_iter {
                let (residual, grad) = Self::joint_residual_and_gradient(&header, &txs, state, &lambda);
                if residual < self.target_residual {
                    return Some((header, txs));
                }
                if residual < best_residual {
                    best_residual = residual;
                    best_solution = Some((header.clone(), txs.clone()));
                }

                let step = (self.learning_rate * grad * 1000.0) as u64;
                header.nonce = header.nonce.wrapping_sub(step);

                // Adjust transaction set: if lambda[4] > 0 and fee deficit, add a dummy high-fee tx
                if lambda[4] > 0.0 {
                    if txs.is_empty() {
                        txs.push(TxCandidate { hash: [0u8; 32], fee: 500_000 });
                    } else {
                        txs.pop();
                    }
                }
            }

            // Update multipliers based on current violations
            let hash_val = {
                let mut hasher = Sha256::new();
                hasher.update(header.prev_hash);
                hasher.update(&header.merkle_root);
                hasher.update(header.timestamp.to_le_bytes());
                hasher.update(header.nonce.to_le_bytes());
                for tx in &txs {
                    hasher.update(&tx.hash);
                }
                u64::from_le_bytes(hasher.finalize()[0..8].try_into().unwrap()) as f64
            };
            let difficulty = header.difficulty as f64;
            let phi = (1.0 + 5.0f64.sqrt()) / 2.0;
            let violations = [
                (hash_val - difficulty).max(0.0),
                (hash_val - difficulty / phi).abs(),
                if state.cumulative_work > 0 { 0.0 } else { 1.0 },
                state.mempool_pressure,
                if txs.iter().map(|tx| tx.fee).sum::<u64>() as f64 > state.mempool_pressure * 1_000_000.0 { 0.0 } else { 1.0 },
            ];
            Self::update_multipliers(&mut lambda, &violations, 0.1);
        }

        best_solution
    }
}
