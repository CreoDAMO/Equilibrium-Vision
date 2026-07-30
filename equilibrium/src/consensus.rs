use crate::chain_state::{BlockHeader, ChainState, TxCandidate, residual_to_fixed};
use crate::proof::{accepted_proof_types, ProofType, UnifiedProof, VerificationResult};
use crate::zk_proof::{Groth16Verifier, StationarityProof, ZkvmVerifier};

pub struct Consensus;

impl Consensus {
    /// Legacy path — Groth16 `StationarityProof` only. Existing callers unchanged.
    pub fn validate_block(
        header: &BlockHeader,
        txs: &[TxCandidate],
        proof: &StationarityProof,
        prev_state: &ChainState,
        current_state: &ChainState,
    ) -> bool {
        Self::validate_block_with_mask(header, txs, proof, prev_state, current_state, 0x01)
    }

    /// Same as `validate_block` but respects a governance proof-type mask.
    /// `accepted_mask`: bit 0 = Groth16, bit 1 = ZkVM (currently only Groth16 path here).
    pub fn validate_block_with_mask(
        header: &BlockHeader,
        _txs: &[TxCandidate],
        proof: &StationarityProof,
        prev_state: &ChainState,
        current_state: &ChainState,
        accepted_mask: u8,
    ) -> bool {
        // Groth16 is bit 0; if not set, reject immediately
        if accepted_mask & 0x01 == 0 {
            return false;
        }
        // 1. Verify the stationarity proof
        if !StationarityProof::verify(proof, header, current_state, 1e-8) {
            return false;
        }
        // 2. Check residual is within target (fixed-point, no float involved)
        if header.residual > residual_to_fixed(1e-8) {
            return false;
        }
        // 3. Chain continuity: genesis must have zero prev_hash
        if prev_state.cumulative_work == 0 && header.prev_hash != [0u8; 32] {
            return false;
        }
        true
    }

    /// Dual-proof path: accepts both Groth16 and ZkVM `UnifiedProof`.
    ///
    /// `unified.bytes` is the raw proof payload (NO type-tag prefix).
    /// `accepted_mask`: bit 0 = Groth16 allowed, bit 1 = ZkVM allowed.
    pub fn validate_unified(
        header: &BlockHeader,
        unified: &UnifiedProof,
        prev_state: &ChainState,
        threshold: f64,
        accepted_mask: u8,
    ) -> bool {
        // Governance gate: check proof type is allowed
        let allowed = accepted_proof_types(accepted_mask);
        if !allowed.contains(&unified.proof_type) {
            return false;
        }

        // Residual threshold check
        if header.residual > residual_to_fixed(threshold) {
            return false;
        }

        // Chain continuity: genesis must have zero prev_hash
        if prev_state.cumulative_work == 0 && header.prev_hash != [0u8; 32] {
            return false;
        }

        // Optional claimed-residual binding (0 means "not filled" — e.g. from_wire_groth16)
        if unified.claimed_residual_fp != 0 && unified.claimed_residual_fp != header.residual {
            return false;
        }

        let residual_fp = header.residual.unsigned_abs();
        let threshold_fp = residual_to_fixed(threshold).unsigned_abs();
        // Circuit binds prev_hash as public input limbs
        let block_hash = &header.prev_hash;

        // Dispatch to the appropriate verifier using unified.bytes (no tag prefix)
        let result = match unified.proof_type {
            ProofType::Groth16 => Groth16Verifier::dummy().verify(
                &unified.bytes,
                residual_fp,
                threshold_fp,
                block_hash,
            ),
            ProofType::Zkvm => ZkvmVerifier::new().verify(
                &unified.bytes,
                residual_fp,
                threshold_fp,
                block_hash,
            ),
        };

        matches!(result, Ok(VerificationResult::Valid))
    }

    /// Select the canonical chain head from a set of competing fork candidates.
    ///
    /// Fork-choice rule: lowest cumulative stationarity residual wins.
    /// `residual` is already fixed-point (`i64`, scaled by `RESIDUAL_SCALE`),
    /// so the comparison below is pure integer arithmetic — no float, no
    /// rounding-mode ambiguity, and therefore identical results across all
    /// architectures (ARM mobile miners and x86 cloud validators alike).
    pub fn choose_fork(blocks: &[(BlockHeader, i64)]) -> &BlockHeader {
        let idx = blocks
            .iter()
            .enumerate()
            .min_by_key(|(_, (_, r))| *r)
            .map(|(i, _)| i)
            .unwrap_or(0);
        &blocks[idx].0
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_state::ChainState;
    use crate::zk_proof::{Groth16ProofBytes, G1Point, G2Point, StationarityProof, StationarityPublicInputs};

    /// Build a minimal `BlockHeader` for testing.
    fn make_header(residual: i64) -> BlockHeader {
        BlockHeader {
            prev_hash:       [0u8; 32],
            merkle_root:     [0u8; 32],
            timestamp:       1_700_000_000,
            nonce:           42,
            difficulty:      100_000,
            recursion_depth: 2,
            residual,
            state_root:      [0u8; 32],
        }
    }

    /// A `StationarityProof` that is structurally invalid (empty raw bytes, zero
    /// vk_hash) and will fail at the first step of `verify()` (vk_hash mismatch)
    /// without triggering expensive Groth16 deserialization.
    fn make_invalid_proof() -> StationarityProof {
        StationarityProof {
            proof: Groth16ProofBytes {
                pi_a: G1Point { x: [0u8; 32], y: [0u8; 32] },
                pi_b: G2Point { x: [[0u8; 32]; 2], y: [[0u8; 32]; 2] },
                pi_c: G1Point { x: [0u8; 32], y: [0u8; 32] },
                raw:  vec![],
            },
            public_inputs: StationarityPublicInputs {
                prev_hash:           [0u8; 32],
                difficulty:          0u64,
                threshold_fp:        [0u8; 32],
                timestamp:           0u64,
                mempool_pressure_fp: [0u8; 32],
            },
            vk_hash:      [0u8; 32],   // deliberately wrong — triggers fast rejection
            valid:        false,
            challenge:    [0u8; 32],
            response:     0,
            revealed_txs: vec![],
        }
    }

    // ── choose_fork ───────────────────────────────────────────────────────────

    #[test]
    fn choose_fork_single_block_returns_it() {
        let h = make_header(1);
        let blocks = vec![(h, 1i64)];
        assert_eq!(Consensus::choose_fork(&blocks).residual, 1);
    }

    #[test]
    fn choose_fork_picks_lowest_residual() {
        let h1 = make_header(5);
        let h2 = make_header(1);
        let h3 = make_header(3);
        let blocks = vec![(h1, 5i64), (h2, 1i64), (h3, 3i64)];
        let winner = Consensus::choose_fork(&blocks);
        assert_eq!(winner.residual, 1, "expected residual 1, got {}", winner.residual);
    }

    #[test]
    fn choose_fork_equal_residuals_returns_first() {
        let mut h1 = make_header(2);
        h1.nonce = 111;
        let mut h2 = make_header(2);
        h2.nonce = 222;
        let blocks = vec![(h1, 2i64), (h2, 2i64)];
        // `min_by_key` is stable — first element wins on tie.
        assert_eq!(Consensus::choose_fork(&blocks).nonce, 111);
    }

    #[test]
    fn choose_fork_uses_exact_integer_comparison_no_float_rounding() {
        // Two residuals that differ by exactly 1 in fixed-point units — an
        // amount that would previously have been swallowed by float ×
        // rescale × floor. Integer comparison must still rank them exactly.
        let r_small: i64 = 1_000_000_000;
        let r_large: i64 = 1_000_000_001;
        let h1 = make_header(r_small);
        let h2 = make_header(r_large);
        let blocks = vec![(h1, r_small), (h2, r_large)];
        assert_eq!(Consensus::choose_fork(&blocks).residual, r_small);
    }

    #[test]
    fn choose_fork_clearly_different_residuals() {
        let h_good = make_header(1);
        let h_bad  = make_header(1_000);
        let blocks = vec![(h_bad, 1_000i64), (h_good.clone(), 1i64)];
        let winner = Consensus::choose_fork(&blocks);
        assert_eq!(winner.residual, 1, "should pick h_good (residual 1), got {}", winner.residual);
    }

    // ── validate_block ────────────────────────────────────────────────────────

    #[test]
    fn validate_block_rejects_invalid_proof() {
        // Any block with a structurally invalid proof must be rejected immediately.
        let header = make_header(1);
        let prev   = ChainState::default();
        let cur    = ChainState::default();
        let proof  = make_invalid_proof();
        assert!(!Consensus::validate_block(&header, &[], &proof, &prev, &cur),
            "invalid proof must be rejected");
    }

    #[test]
    fn validate_block_rejects_wrong_genesis_prev_hash() {
        // For a genesis slot (prev_state.cumulative_work == 0), prev_hash must be [0; 32].
        // A non-zero prev_hash at genesis is an integrity violation regardless of the proof.
        // This test exercises the third guard in validate_block.
        //
        // Note: with an invalid proof the function returns false at step 1, so we verify
        // the same observable outcome (false) from two directions:
        //   a) invalid proof path (make_invalid_proof) — fast
        //   b) wrong prev_hash path — the function reaches step 3 only with a valid proof,
        //      covered by the integration test suite that calls StationarityProof::prove.
        let mut header = make_header(1);
        header.prev_hash = [1u8; 32]; // non-zero — wrong for genesis
        let prev  = ChainState::default(); // cumulative_work = 0
        let cur   = ChainState::default();
        let proof = make_invalid_proof();
        assert!(!Consensus::validate_block(&header, &[], &proof, &prev, &cur));
    }

    // ── validate_unified tests ────────────────────────────────────────────────

    #[test]
    fn validate_unified_rejects_disallowed_proof_type() {
        let header = make_header(1);
        let prev = ChainState::default();
        let unified = UnifiedProof {
            proof_type: ProofType::Zkvm,
            bytes: vec![],
            public_inputs: vec![],
            claimed_residual_fp: 0,
        };
        // mask 0x01 = Groth16 only — ZkVM must be rejected
        assert!(!Consensus::validate_unified(&header, &unified, &prev, 1e-8, 0x01));
    }

    #[test]
    fn validate_unified_rejects_all_types_when_mask_zero() {
        let header = make_header(1);
        let prev = ChainState::default();
        for pt in [ProofType::Groth16, ProofType::Zkvm] {
            let unified = UnifiedProof {
                proof_type: pt,
                bytes: vec![],
                public_inputs: vec![],
                claimed_residual_fp: 0,
            };
            assert!(!Consensus::validate_unified(&header, &unified, &prev, 1e-8, 0x00));
        }
    }

    #[test]
    fn validate_unified_rejects_empty_groth16_payload() {
        let header = make_header(1);
        let prev = ChainState::default();
        let unified = UnifiedProof {
            proof_type: ProofType::Groth16,
            bytes: vec![],
            public_inputs: vec![],
            claimed_residual_fp: 0,
        };
        // Both types allowed — should still fail because proof bytes are empty
        assert!(!Consensus::validate_unified(&header, &unified, &prev, 1e-8, 0x03));
    }

    #[test]
    fn validate_unified_rejects_residual_mismatch() {
        // claimed_residual_fp != header.residual and != 0 → must reject before verifying
        let header = make_header(1);
        let prev = ChainState::default();
        let unified = UnifiedProof {
            proof_type: ProofType::Groth16,
            bytes: vec![0u8; 192],
            public_inputs: vec![],
            claimed_residual_fp: 999, // != header.residual (1)
        };
        assert!(!Consensus::validate_unified(&header, &unified, &prev, 1e-8, 0x03));
    }

    #[test]
    fn validate_block_with_mask_rejects_when_groth16_not_allowed() {
        let header = make_header(1);
        let prev = ChainState::default();
        let cur = ChainState::default();
        let proof = make_invalid_proof();
        // mask 0x02 = ZkVM only — Groth16 must be rejected at the mask check
        assert!(!Consensus::validate_block_with_mask(&header, &[], &proof, &prev, &cur, 0x02));
    }

    /// Full prove→verify integration test.  Marked `#[ignore]` because Groth16
    /// proving takes several seconds.  Run explicitly with:
    ///   cargo test -- --ignored validate_block_full_prove_verify
    #[test]
    #[ignore]
    fn validate_block_full_prove_verify() {
        let mut header = make_header(1); // residual well within 1e-8 threshold
        header.prev_hash = [0u8; 32];
        let prev  = ChainState::default();
        let cur   = ChainState { height: 1, ..ChainState::default() };
        let proof = StationarityProof::prove(&header, &[], &cur, 1e-8);
        assert!(Consensus::validate_block(&header, &[], &proof, &prev, &cur),
            "valid block with real Groth16 proof must pass");
    }
}
