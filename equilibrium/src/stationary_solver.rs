use sha2::{Sha256, Digest};
use crate::chain_state::{BlockHeader, ChainState, TxCandidate, residual_to_fixed};

pub struct StationarySolver {
    pub max_iter: u64,
    /// Fixed-point target (scaled by `RESIDUAL_SCALE`). Stored pre-converted
    /// so the hot loop below never touches a float when deciding whether a
    /// candidate residual is good enough.
    pub target_residual: i64,
    pub learning_rate: f64,
    pub recursion_depth: u32,
}

impl StationarySolver {
    /// `target_residual` is accepted as a float for ergonomic call sites
    /// (callers usually reason in real residual units), but is converted to
    /// fixed-point once, here, at construction — never again.
    pub fn new(max_iter: u64, target_residual: f64, learning_rate: f64, recursion_depth: u32) -> Self {
        Self {
            max_iter,
            target_residual: residual_to_fixed(target_residual),
            learning_rate,
            recursion_depth,
        }
    }

    /// Full joint residual and gradient, with all cross-terms explicit.
    ///
    /// The residual is returned as a fixed-point `i64` (scaled by
    /// `RESIDUAL_SCALE`) directly from this function — callers never cast a
    /// float residual themselves. The gradient remains `f64`: it only steers
    /// the local nonce search direction and never appears in a consensus
    /// comparison, so it carries no cross-architecture determinism risk.
    pub(crate) fn joint_residual_and_gradient(
        header: &BlockHeader,
        txs: &[TxCandidate],
        state: &ChainState,
        lambda: &[f64; 5],
    ) -> (i64, f64) {
        // 1. Hash constraint
        let mut hasher = Sha256::new();
        hasher.update(header.prev_hash);
        hasher.update(header.merkle_root);
        hasher.update(header.timestamp.to_le_bytes());
        hasher.update(header.nonce.to_le_bytes());
        for tx in txs {
            hasher.update(tx.hash);
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
        let chain_violation: f64 = if state.cumulative_work > 0 { 0.0 } else { 1.0 };
        let chain_grad: f64 = 0.0;

        // 4. Network pressure (mempool stress)
        let mempool_violation: f64 = state.mempool_pressure;
        let mempool_grad: f64 = 0.0;

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

        (residual_to_fixed(residual), gradient)
    }

    pub(crate) fn update_multipliers(lambda: &mut [f64; 5], violations: &[f64; 5], step: f64) {
        for i in 0..5 {
            lambda[i] = (lambda[i] + step * violations[i]).max(0.0);
        }
    }

    /// Full structural optimizer: jointly optimizes nonce and transaction set.
    ///
    /// The returned `BlockHeader.residual` always carries the fixed-point
    /// value actually achieved by the winning nonce/tx combination — no
    /// float ever crosses this boundary.
    pub fn optimize_full(
        &self,
        mut header: BlockHeader,
        mut txs: Vec<TxCandidate>,
        state: &ChainState,
    ) -> Option<(BlockHeader, Vec<TxCandidate>)> {
        let mut lambda = [1.0; 5];
        // `None` means "no candidate seen yet". This must be a distinct state
        // from "seen a candidate whose fixed-point residual saturated to
        // `i64::MAX`" — collapsing the two (e.g. by using `i64::MAX` as both
        // the sentinel and the saturation value) means the very first
        // saturated residual can never be recorded, since `MAX < MAX` is
        // false. The old `f64::INFINITY` sentinel didn't have this problem
        // because no finite float could ever equal it.
        let mut best_residual: Option<i64> = None;
        let mut best_solution = None;

        for _ in 0..self.recursion_depth {
            for _ in 0..self.max_iter {
                let (residual, grad) = Self::joint_residual_and_gradient(&header, &txs, state, &lambda);
                if residual < self.target_residual {
                    header.residual = residual;
                    return Some((header, txs));
                }
                if best_residual.map_or(true, |best| residual < best) {
                    best_residual = Some(residual);
                    let mut candidate = header.clone();
                    candidate.residual = residual;
                    best_solution = Some((candidate, txs.clone()));
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
                hasher.update(header.merkle_root);
                hasher.update(header.timestamp.to_le_bytes());
                hasher.update(header.nonce.to_le_bytes());
                for tx in &txs {
                    hasher.update(tx.hash);
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

/// Dimensionless residual at the default coupling λ = (1,1,1,1,1).
/// That vector is Ω's coupling only when no passed proposal has opened another.
/// A changed λ is [`canonical_residual_lambda`], not this wrapper.
/// Same function as `evaluateResidual` in `site/src/protocol/solver.ts`.
/// The territory residual in `joint_residual_and_gradient` is not this number.
#[allow(clippy::too_many_arguments)]
pub fn canonical_residual(
    prev_hash: &[u8; 32],
    merkle_root: &[u8; 32],
    timestamp: u64,
    nonce: u64,
    difficulty: u64,
    txs: &[TxCandidate],
    cumulative_work: u64,
    mempool_pressure: f64,
) -> f64 {
    canonical_residual_lambda(
        prev_hash,
        merkle_root,
        timestamp,
        nonce,
        difficulty,
        txs,
        cumulative_work,
        mempool_pressure,
        &[1.0; 5],
    )
}

/// Canonical residual at an explicit coupling.
/// Order is hash, structural, continuity, mempool, fees. Same weights as site.
/// `joint_residual_and_gradient` is the territory residual and is not admission.
#[allow(clippy::too_many_arguments)]
pub fn canonical_residual_lambda(
    prev_hash: &[u8; 32],
    merkle_root: &[u8; 32],
    timestamp: u64,
    nonce: u64,
    difficulty: u64,
    txs: &[TxCandidate],
    cumulative_work: u64,
    mempool_pressure: f64,
    lambda: &[f64; 5],
) -> f64 {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash);
    hasher.update(merkle_root);
    hasher.update(timestamp.to_le_bytes());
    hasher.update(nonce.to_le_bytes());
    for tx in txs {
        hasher.update(tx.hash);
    }
    let hash = hasher.finalize();
    let hash_val = u64::from_le_bytes(hash[0..8].try_into().unwrap());
    let h_frac = (hash_val as f64) / 2f64.powi(64);
    let phi = (1.0 + 5.0f64.sqrt()) / 2.0;
    let tau = (1_000_000.0 / (difficulty as f64 + 1_000_000.0) + 0.35).clamp(0.05, 0.95);
    let v_hash = (h_frac - tau).max(0.0);
    let v_struct = (h_frac - 1.0 / phi).abs();
    let v_chain: f64 = if cumulative_work > 0 { 0.0 } else { 1.0 };
    let v_mem = mempool_pressure.clamp(0.0, 1.0);
    let total_fees: u64 = txs.iter().map(|tx| tx.fee).sum();
    let v_fee = (v_mem - (total_fees as f64 / 1_000_000.0).min(1.0)).max(0.0);
    let v = [v_hash, v_struct, v_chain, v_mem, v_fee];
    let mut residual = 0.0;
    for i in 0..5 {
        residual += lambda[i] * v[i] * v[i];
    }
    residual
}

/// Search at the default coupling. The phone JNI entry uses this.
/// It does not read Ω. A coupling other than (1,1,1,1,1) is [`search_canonical_lambda`].
pub fn search_canonical(
    header: &BlockHeader,
    txs: &[TxCandidate],
    state: &ChainState,
    max_iter: u64,
    target: f64,
) -> (u64, f64) {
    search_canonical_lambda(header, txs, state, max_iter, target, &[1.0; 5])
}

/// Search nonces at the coupling Ω opened. The optimizer's local λ is not an argument.
pub fn search_canonical_lambda(
    header: &BlockHeader,
    txs: &[TxCandidate],
    state: &ChainState,
    max_iter: u64,
    target: f64,
    lambda: &[f64; 5],
) -> (u64, f64) {
    let mut best_nonce = header.nonce;
    let mut best = f64::INFINITY;
    let steps = max_iter.max(1);
    for i in 0..steps {
        let nonce = header.nonce.wrapping_add(i);
        let residual = canonical_residual_lambda(
            &header.prev_hash,
            &header.merkle_root,
            header.timestamp,
            nonce,
            header.difficulty,
            txs,
            state.cumulative_work,
            state.mempool_pressure,
            lambda,
        );
        if residual < best {
            best = residual;
            best_nonce = nonce;
        }
        if residual < target {
            return (nonce, residual);
        }
    }
    (best_nonce, best)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_state::{BlockHeader, ChainState};

    fn default_state() -> ChainState {
        ChainState {
            cumulative_work: 1,
            mempool_pressure: 0.0,
            ..Default::default()
        }
    }

    fn default_header() -> BlockHeader {
        BlockHeader {
            prev_hash: [0u8; 32],
            merkle_root: [0u8; 32],
            timestamp: 1_700_000_000,
            nonce: 12345,
            difficulty: 1_000_000,
            recursion_depth: 1,
            residual: 0,
            state_root: [0u8; 32],
        }
    }

    #[test]
    fn solver_returns_some_for_permissive_target() {
        // With a very large target residual, the solver should find a solution quickly.
        // NOTE: 1e12 is chosen instead of an even larger value because
        // `RESIDUAL_SCALE` (1e18) means any real residual above ~9.22 turns
        // into a fixed-point value that saturates to `i64::MAX`. If the
        // achieved residual *also* saturates, `residual < target_residual`
        // is `MAX < MAX` (false) even though the real target is "permissive" —
        // so this test intentionally probes a target just below saturation.
        let solver = StationarySolver::new(100, 1e12, 0.01, 2);
        let state = default_state();
        let result = solver.optimize_full(default_header(), vec![], &state);
        assert!(result.is_some(), "solver should find a solution for a permissive threshold");
    }

    #[test]
    fn solver_best_effort_result_when_target_unreachable() {
        // Even when the target is far below what's achievable in the given
        // iteration budget, `optimize_full` must still return the best
        // candidate found rather than `None` — callers rely on always
        // getting a usable header back.
        let solver = StationarySolver::new(50, 1e-8, 0.01, 1);
        let state = default_state();
        let result = solver.optimize_full(default_header(), vec![], &state);
        assert!(result.is_some(), "solver should return a best-effort solution even if target is unreachable");
        let (solved, _) = result.unwrap();
        assert!(solved.residual >= 0, "best-effort residual must still be a valid non-negative fixed-point value");
    }

    #[test]
    fn solver_output_header_residual_is_fixed_point_and_matches_achieved_value() {
        // Regression guard: optimize_full must actually write the achieved
        // residual into the returned header (previously it silently returned
        // the header's original placeholder residual, 0).
        //
        // Note: target 1e-8 (not a huge "permissive" value) is used
        // deliberately here so the early-exit path is exercised and the
        // assertion `residual < target` is meaningful — with a target large
        // enough to saturate the fixed-point range, both the target and any
        // achieved residual collapse to `i64::MAX` and the comparison is
        // never informative (see `solver_returns_some_for_permissive_target`).
        let solver = StationarySolver::new(1_000_000, 1e-8, 0.01, 1);
        let state = default_state();
        let (solved, txs) = solver.optimize_full(default_header(), vec![], &state).unwrap();
        assert!(solved.residual >= 0, "achieved residual must be a valid non-negative fixed-point value");
        assert_ne!(solved.residual, 0, "residual must not be the stale placeholder value from the input header");

        let lambda = [1.0; 5];
        let (recomputed, _) = StationarySolver::joint_residual_and_gradient(&solved, &txs, &state, &lambda);
        assert_eq!(solved.residual, recomputed, "header.residual must equal the residual actually achieved by its own nonce/tx combination");
    }

    #[test]
    fn canonical_residual_matches_the_public_kernel_vector() {
        let contract = crate::site_contract::site_contract();
        let prev = [0u8; 32];
        let merkle = [0u8; 32];
        let rows = contract["residual"]["rows"].as_array().expect("rows");
        let nonce0 = rows.iter().find(|row| row["name"] == "nonce0").expect("nonce0");
        let nonce6 = rows.iter().find(|row| row["name"] == "nonce6").expect("nonce6");
        let zero = canonical_residual(
            &prev,
            &merkle,
            nonce0["timestamp"].as_u64().unwrap(),
            nonce0["nonce"].as_u64().unwrap(),
            nonce0["difficulty"].as_u64().unwrap(),
            &[],
            nonce0["work"].as_u64().unwrap(),
            crate::site_contract::f64_of(&nonce0["pressure"]),
        );
        let admitted = canonical_residual(
            &prev,
            &merkle,
            nonce6["timestamp"].as_u64().unwrap(),
            nonce6["nonce"].as_u64().unwrap(),
            nonce6["difficulty"].as_u64().unwrap(),
            &[],
            nonce6["work"].as_u64().unwrap(),
            crate::site_contract::f64_of(&nonce6["pressure"]),
        );
        let expect0 = crate::site_contract::f64_of(&nonce0["canonical"]);
        let expect6 = crate::site_contract::f64_of(&nonce6["canonical"]);
        assert!((zero - expect0).abs() < 1e-12, "nonce 0 residual {zero}");
        assert!((admitted - expect6).abs() < 1e-12, "nonce 6 residual {admitted}");
        assert!(admitted < 2e-3);
        assert_eq!(
            residual_to_fixed(admitted),
            contract["nonce6Fp"].as_i64().unwrap(),
            "residualFp is the binary64 floor the site contract publishes"
        );
    }

    #[test]
    fn canonical_residual_grid_matches_the_public_kernel() {
        let contract = crate::site_contract::site_contract();
        let prev = [0u8; 32];
        let merkle = [0u8; 32];
        let rows = contract["residual"]["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 10, "the site contract publishes ten residual rows");
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let txs: Vec<TxCandidate> = row["txs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tx| {
                    let bytes = hex::decode(tx["hash"].as_str().unwrap()).unwrap();
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(&bytes);
                    TxCandidate { hash, fee: tx["fee"].as_u64().unwrap() }
                })
                .collect();
            let got = canonical_residual(
                &prev,
                &merkle,
                row["timestamp"].as_u64().unwrap(),
                row["nonce"].as_u64().unwrap(),
                row["difficulty"].as_u64().unwrap(),
                &txs,
                row["work"].as_u64().unwrap(),
                crate::site_contract::f64_of(&row["pressure"]),
            );
            let expected = crate::site_contract::f64_of(&row["canonical"]);
            assert!((got - expected).abs() < 1e-12, "{name}: rust {got} site {expected}");
        }
    }

    fn spec_violations(
        prev: &[u8; 32],
        merkle: &[u8; 32],
        timestamp: u64,
        nonce: u64,
        difficulty: u64,
        work: u64,
        pressure: f64,
    ) -> [f64; 5] {
        let mut hasher = Sha256::new();
        hasher.update(prev);
        hasher.update(merkle);
        hasher.update(timestamp.to_le_bytes());
        hasher.update(nonce.to_le_bytes());
        let hash_val = u64::from_le_bytes(hasher.finalize()[0..8].try_into().unwrap());
        let h_frac = (hash_val as f64) / 2f64.powi(64);
        let phi = (1.0 + 5.0f64.sqrt()) / 2.0;
        let tau = (1_000_000.0 / (difficulty as f64 + 1_000_000.0) + 0.35).clamp(0.05, 0.95);
        let v_hash = (h_frac - tau).max(0.0);
        let v_struct = (h_frac - 1.0 / phi).abs();
        let v_chain = if work > 0 { 0.0 } else { 1.0 };
        let v_mem = pressure.clamp(0.0, 1.0);
        let v_fee = v_mem;
        [v_hash, v_struct, v_chain, v_mem, v_fee]
    }

    #[test]
    fn canonical_lambda_weights_are_the_dropped_violation() {
        let prev = [0u8; 32];
        let merkle = [0u8; 32];
        let timestamp = 1_700_000_000u64;
        let difficulty = 1_000_000u64;
        let mut hash_nonce = None;
        for nonce in 0..20_000u64 {
            let v = spec_violations(&prev, &merkle, timestamp, nonce, difficulty, 1, 0.0);
            if v[0] > 0.0 && v[1] > 0.0 {
                hash_nonce = Some(nonce);
                break;
            }
        }
        let nonce = hash_nonce.expect("a nonce with a live hash violation");
        let full = [1.0; 5];
        let base = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &[], 1, 0.0, &full);
        let wrapped = canonical_residual(&prev, &merkle, timestamp, nonce, difficulty, &[], 1, 0.0);
        assert_eq!(base.to_bits(), wrapped.to_bits(), "omitted λ is the default coupling, not a second formula");
        let v = spec_violations(&prev, &merkle, timestamp, nonce, difficulty, 1, 0.0);
        for i in 0..5 {
            let mut dropped = full;
            dropped[i] = 0.0;
            let got = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &[], 1, 0.0, &dropped);
            let delta = base - got;
            assert!((delta - v[i] * v[i]).abs() < 1e-12, "axis {i}: delta {delta} v^2 {}", v[i] * v[i]);
        }
        let quiet = canonical_residual_lambda(&prev, &merkle, timestamp, 6, difficulty, &[], 1, 0.0, &[0.0; 5]);
        assert_eq!(quiet, 0.0, "λ = 0 is not the nonce-6 default residual");
        assert!(canonical_residual(&prev, &merkle, timestamp, 6, difficulty, &[], 1, 0.0) > 0.0);
        let heavy = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &[], 1, 0.0, &[0.7, 1.0, 1.0, 1.0, 1.0]);
        let wrong = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &[], 1, 0.0, &[0.8, 1.0, 1.0, 1.0, 1.0]);
        assert_ne!(heavy.to_bits(), wrong.to_bits(), "a substituted λ must not agree");
        let continuity = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &[], 0, 0.0, &full)
            - canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &[], 0, 0.0, &[1.0, 1.0, 0.0, 1.0, 1.0]);
        assert!((continuity - 1.0).abs() < 1e-12, "work 0 drops by v_c^2 = 1, got {continuity}");
        let tx = [TxCandidate { hash: [0xab; 32], fee: 0 }];
        let mem = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &tx, 1, 0.5, &full)
            - canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &tx, 1, 0.5, &[1.0, 1.0, 1.0, 0.0, 1.0]);
        assert!((mem - 0.25).abs() < 1e-12, "pressure 0.5 drops by v_m^2, got {mem}");
        let fee = canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &tx, 1, 0.5, &full)
            - canonical_residual_lambda(&prev, &merkle, timestamp, nonce, difficulty, &tx, 1, 0.5, &[1.0, 1.0, 1.0, 1.0, 0.0]);
        assert!((fee - 0.25).abs() < 1e-12, "uncovered fee drops by v_f^2, got {fee}");
    }

    #[test]
    fn canonical_residual_matches_the_site_lambda_oracle() {
        let Ok(path) = std::env::var("EQ_LAMBDA_ORACLE") else {
            println!("lambda-oracle: not supplied");
            return;
        };
        let text = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("oracle {path}: {err}"));
        let value: serde_json::Value = serde_json::from_str(&text).expect("oracle json");
        let rows = value["rows"].as_array().expect("rows");
        assert!(rows.len() >= 5, "site did not emit the five coupling attacks");
        let prev = [0u8; 32];
        let merkle = [0u8; 32];
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let lambda_vals = row["lambda"].as_array().unwrap();
            assert_eq!(lambda_vals.len(), 5, "{name}");
            let mut lambda = [0.0; 5];
            for (i, item) in lambda_vals.iter().enumerate() {
                lambda[i] = crate::site_contract::f64_of(item);
            }
            let fee = row["fee"].as_u64().unwrap_or(0);
            let txs: Vec<TxCandidate> = if fee == 0 && row["txs"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
                Vec::new()
            } else {
                row["txs"].as_array().unwrap().iter().map(|tx| {
                    let bytes = hex::decode(tx["hash"].as_str().unwrap()).unwrap();
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(&bytes);
                    TxCandidate { hash, fee: tx["fee"].as_u64().unwrap() }
                }).collect()
            };
            let got = canonical_residual_lambda(
                &prev,
                &merkle,
                row["timestamp"].as_u64().unwrap(),
                row["nonce"].as_u64().unwrap(),
                row["difficulty"].as_u64().unwrap(),
                &txs,
                row["work"].as_u64().unwrap(),
                crate::site_contract::f64_of(&row["pressure"]),
                &lambda,
            );
            let expected = crate::site_contract::f64_of(&row["canonical"]);
            assert!((got - expected).abs() < 1e-12, "{name}: rust {got} site {expected}");
            if name == "default" {
                let wrapped = canonical_residual(
                    &prev,
                    &merkle,
                    row["timestamp"].as_u64().unwrap(),
                    row["nonce"].as_u64().unwrap(),
                    row["difficulty"].as_u64().unwrap(),
                    &txs,
                    row["work"].as_u64().unwrap(),
                    crate::site_contract::f64_of(&row["pressure"]),
                );
                assert_eq!(wrapped.to_bits(), got.to_bits());
            }
        }
        println!("lambda-oracle: rows {}", rows.len());
    }

    #[test]
    fn optimizer_lambda_is_not_canonical_admission() {
        let prev = [0u8; 32];
        let solver = StationarySolver::new(20, 1e-8, 0.01, 1);
        let state = default_state();
        let (solved, solved_txs) = solver.optimize_full(default_header(), vec![], &state).expect("best effort");
        let canonical = canonical_residual_lambda(
            &prev,
            &prev,
            solved.timestamp,
            solved.nonce,
            solved.difficulty,
            &solved_txs,
            state.cumulative_work,
            state.mempool_pressure,
            &[0.0; 5],
        );
        assert_eq!(canonical, 0.0);
        assert_ne!(solved.residual, residual_to_fixed(canonical), "the optimizer's λ must not be admitted as Ω's coupling");
        let (territory, _) = StationarySolver::joint_residual_and_gradient(&solved, &solved_txs, &state, &[1.0; 5]);
        assert_eq!(solved.residual, territory, "optimize_full still stores the territory residual, not the canonical one");
    }

    #[test]
    fn search_canonical_finds_the_nonce_the_public_kernel_admits() {
        let header = BlockHeader {
            prev_hash: [0u8; 32],
            merkle_root: [0u8; 32],
            timestamp: 1_700_000_000,
            nonce: 0,
            difficulty: 1_000_000,
            recursion_depth: 1,
            residual: 0,
            state_root: [0u8; 32],
        };
        let state = ChainState {
            cumulative_work: 1,
            mempool_pressure: 0.0,
            ..ChainState::default()
        };
        let (nonce, residual) = search_canonical(&header, &[], &state, 64, 2e-3);
        assert_eq!(nonce, 6, "the scan must admit nonce 6, got {nonce} residual {residual}");
        let again = canonical_residual(&header.prev_hash, &header.merkle_root, header.timestamp, nonce, header.difficulty, &[], 1, 0.0);
        assert_eq!(again.to_bits(), residual.to_bits());
    }

    #[test]
    fn residual_is_non_negative() {
        // The Lagrangian is a sum of squared violations — it must never be negative.
        let state = default_state();
        let header = default_header();
        let lambda = [1.0; 5];
        let (residual, _) = StationarySolver::joint_residual_and_gradient(&header, &[], &state, &lambda);
        assert!(residual >= 0, "residual must be non-negative, got {residual}");
    }

    #[test]
    fn zero_lambda_gives_zero_residual() {
        let state = default_state();
        let header = default_header();
        let lambda = [0.0; 5];
        let (residual, _) = StationarySolver::joint_residual_and_gradient(&header, &[], &state, &lambda);
        assert_eq!(residual, 0, "all-zero lambda should give zero residual");
    }

    #[test]
    fn update_multipliers_clamps_to_zero() {
        let mut lambda = [0.5; 5];
        // Very negative step drives all λᵢ towards negative; must clamp at 0
        StationarySolver::update_multipliers(&mut lambda, &[1.0; 5], -10.0);
        for l in lambda {
            assert_eq!(l, 0.0, "multipliers must not go below 0.0");
        }
    }

    #[test]
    fn update_multipliers_increases_for_positive_violation() {
        let mut lambda = [1.0; 5];
        let before = lambda[0];
        StationarySolver::update_multipliers(&mut lambda, &[1.0; 5], 0.1);
        assert!(lambda[0] > before, "positive violation should increase λ");
    }

    #[test]
    fn fixed_point_encoding_is_deterministic() {
        // Verify that encoding 1e-8 as fixed-point (scale 1e18, matching
        // RESIDUAL_SCALE) gives the same integer on every call — a
        // regression guard for floating-point ordering.
        let residual = 1e-8_f64;
        assert_eq!(residual_to_fixed(residual), residual_to_fixed(residual));
        assert_eq!(residual_to_fixed(residual), 10_000_000_000);
    }

    #[test]
    fn new_converts_target_residual_to_fixed_point_once() {
        let solver = StationarySolver::new(10, 1e-8, 0.01, 1);
        assert_eq!(solver.target_residual, 10_000_000_000);
    }
}
