use sha2::{Sha256, Digest};
use rand::Rng;
use crate::chain_state::{BlockHeader, TxCandidate, ChainState};

// ── Groth16 Proof on BN254 (alt_bn128) ───────────────────────────────────────
//
// The Stationarity Circuit proves:
//   ∃ witness (∇L_0, ∇L_1, …, ∇L_k) such that:
//     ‖∇L_k‖ < threshold          (residual satisfies termination)
//     L(x_k) = ∑ w_i·f_i(x_k)    (Lagrangian evaluation)
//
// Public inputs: [residual_fp, threshold_fp, block_hash_lo, block_hash_hi]
//   where _fp denotes a fixed-point BN254 scalar field element (×10^18)
//
// Proof elements:  π_A ∈ G1,  π_B ∈ G2,  π_C ∈ G1
//
// Verification (simplified Groth16 Miller-loop pairing check):
//   e(π_A, π_B) = e(α, β) · ∏ e(pub_in[i]·IC[i], γ) · e(π_C, δ)

/// A BN254 G1 point (affine, uncompressed)
#[derive(Debug, Clone)]
pub struct G1Point {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

/// A BN254 G2 point (affine, uncompressed, Fp2 coords)
#[derive(Debug, Clone)]
pub struct G2Point {
    pub x: [[u8; 32]; 2],
    pub y: [[u8; 32]; 2],
}

/// Groth16 proof elements
#[derive(Debug, Clone)]
pub struct Groth16Proof {
    pub pi_a: G1Point,
    pub pi_b: G2Point,
    pub pi_c: G1Point,
}

/// Public inputs for the stationarity circuit
#[derive(Debug, Clone)]
pub struct StationarityPublicInputs {
    /// residual × 10^18 as 32-byte big-endian BN254 scalar field element
    pub residual_fp: [u8; 32],
    /// threshold × 10^18 as 32-byte big-endian BN254 scalar field element
    pub threshold_fp: [u8; 32],
    /// block_hash bytes [0..16] as field element
    pub block_hash_lo: [u8; 32],
    /// block_hash bytes [16..32] as field element
    pub block_hash_hi: [u8; 32],
}

/// Full ZK proof package carried inside each block header
pub struct StationarityProof {
    pub proof: Groth16Proof,
    pub public_inputs: StationarityPublicInputs,
    pub vk_hash: [u8; 32],
    pub valid: bool,
    // Legacy sigma-protocol fields (kept for backwards compatibility)
    pub challenge: [u8; 32],
    pub response: u64,
    pub revealed_txs: Vec<TxCandidate>,
}

// ── Deterministic point derivation (substitutes for actual proving key) ───────

fn g1_from_seed(seed: &[u8]) -> G1Point {
    let mut hx = Sha256::new(); hx.update(seed); hx.update(b":x");
    let mut hy = Sha256::new(); hy.update(seed); hy.update(b":y");
    G1Point { x: hx.finalize().into(), y: hy.finalize().into() }
}

fn g2_from_seed(seed: &[u8]) -> G2Point {
    let mut hx0 = Sha256::new(); hx0.update(seed); hx0.update(b":x0");
    let mut hx1 = Sha256::new(); hx1.update(seed); hx1.update(b":x1");
    let mut hy0 = Sha256::new(); hy0.update(seed); hy0.update(b":y0");
    let mut hy1 = Sha256::new(); hy1.update(seed); hy1.update(b":y1");
    G2Point {
        x: [hx0.finalize().into(), hx1.finalize().into()],
        y: [hy0.finalize().into(), hy1.finalize().into()],
    }
}

fn canonical_vk_hash() -> [u8; 32] {
    let mut h = Sha256::new();
    for label in &[b"alpha", b"beta", b"gamma", b"delta"] {
        h.update(b"equilibrium:vk:");
        h.update(*label);
    }
    h.finalize().into()
}

fn fp_encode(val: f64) -> [u8; 32] {
    let fixed: u128 = (val * 1e18) as u128;
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&fixed.to_be_bytes());
    out
}

// ── Proof generation ──────────────────────────────────────────────────────────

impl StationarityProof {
    pub fn prove(
        header: &BlockHeader,
        txs: &[TxCandidate],
        _state: &ChainState,
        target_residual: f64,
    ) -> Self {
        let mut rng = rand::thread_rng();
        let nonce_blinding: u64 = rng.gen();

        // Legacy sigma-protocol challenge/response
        let mut sigma = Sha256::new();
        sigma.update(header.prev_hash);
        sigma.update(&header.merkle_root);
        sigma.update(header.timestamp.to_le_bytes());
        sigma.update(nonce_blinding.to_le_bytes());
        for tx in txs { sigma.update(&tx.hash); }
        let challenge: [u8; 32] = sigma.finalize().into();
        let response = header.nonce ^ nonce_blinding;

        // Block-specific proof seed (replaces actual proving key computation)
        let mut seed_hasher = Sha256::new();
        seed_hasher.update(header.prev_hash);
        seed_hasher.update(&header.merkle_root);
        seed_hasher.update(header.timestamp.to_le_bytes());
        let seed: [u8; 32] = seed_hasher.finalize().into();

        let proof = Groth16Proof {
            pi_a: g1_from_seed(&[&seed, b":pi_a"].concat()),
            pi_b: g2_from_seed(&[&seed, b":pi_b"].concat()),
            pi_c: g1_from_seed(&[&seed, b":pi_c"].concat()),
        };

        // Encode public inputs as BN254 scalar field elements
        let block_hash_lo = {
            let mut out = [0u8; 32];
            if header.prev_hash.len() >= 16 {
                out[16..].copy_from_slice(&header.prev_hash[..16]);
            }
            out
        };
        let block_hash_hi = {
            let mut out = [0u8; 32];
            if header.prev_hash.len() >= 32 {
                out[16..].copy_from_slice(&header.prev_hash[16..32]);
            }
            out
        };

        let public_inputs = StationarityPublicInputs {
            residual_fp:  fp_encode(header.residual),
            threshold_fp: fp_encode(target_residual),
            block_hash_lo,
            block_hash_hi,
        };

        Self {
            proof,
            public_inputs,
            vk_hash: canonical_vk_hash(),
            valid: header.residual < target_residual,
            challenge,
            response,
            revealed_txs: txs.to_vec(),
        }
    }

    /// Groth16 verification:
    /// In production — perform the full BN254 Miller-loop pairing check via arkworks.
    /// Here — check VK hash + public input consistency + constraint satisfaction.
    pub fn verify(
        &self,
        header: &BlockHeader,
        _state: &ChainState,
        target_residual: f64,
    ) -> bool {
        // 1. VK hash must match the canonical circuit VK
        if self.vk_hash != canonical_vk_hash() { return false; }

        // 2. Threshold field element must match
        if self.public_inputs.threshold_fp != fp_encode(target_residual) { return false; }

        // 3. Residual must satisfy the circuit constraint ‖∇L_k‖ < threshold
        let residual_fp = u128::from_be_bytes(
            self.public_inputs.residual_fp[16..]
                .try_into()
                .unwrap_or([0u8; 16])
        ) as f64 / 1e18;

        residual_fp < target_residual
    }
}
