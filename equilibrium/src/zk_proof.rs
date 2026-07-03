use sha2::{Sha256, Digest};
use serde::{Serialize, Deserialize};
use rand::rngs::StdRng;
use rand::SeedableRng;
use crate::chain_state::{BlockHeader, TxCandidate, ChainState};

// ── Groth16 on BN254 (ark-groth16 + ark-bn254) ───────────────────────────────
//
// Circuit: proves ∃ difference > 0 such that residual_fp + difference = threshold_fp
// and difference fits in 64 bits.
//
// Public inputs:  [residual_fp, threshold_fp, block_hash_lo, block_hash_hi]
// Private witness: difference = threshold_fp - residual_fp
//
// ⚠ TESTNET NOTE: The proving key is generated from a fixed seed (not a ceremony).
// This is suitable for testnet but must be replaced with a MPC ceremony for mainnet.

use ark_bn254::{Bn254, Fr};
use ark_groth16::{Groth16, ProvingKey, PreparedVerifyingKey, prepare_verifying_key};
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalSerialize, CanonicalDeserialize};
use ark_snark::SNARK;
use std::sync::OnceLock;

// ── Circuit definition ────────────────────────────────────────────────────────

/// R1CS circuit proving residual_fp < threshold_fp.
#[derive(Clone)]
pub struct StationarityCircuit {
    // Public inputs
    pub residual_fp: u64,   // residual × 10^18 as fixed-point integer
    pub threshold_fp: u64,  // threshold × 10^18 as fixed-point integer
    pub block_hash_lo: u64, // block_hash bytes [0..8]
    pub block_hash_hi: u64, // block_hash bytes [8..16]
    // Private witness
    pub difference: u64,    // threshold_fp − residual_fp  (must be > 0)
}

impl ConstraintSynthesizer<Fr> for StationarityCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        use ark_r1cs_std::fields::fp::FpVar;

        // Allocate public inputs ─────────────────────────────────────────────
        let residual_var = FpVar::<Fr>::new_input(
            ark_relations::ns!(cs, "residual"),
            || Ok(Fr::from(self.residual_fp)),
        )?;
        let threshold_var = FpVar::<Fr>::new_input(
            ark_relations::ns!(cs, "threshold"),
            || Ok(Fr::from(self.threshold_fp)),
        )?;
        // Block hash public inputs bind the proof to this specific block.
        let _hash_lo = FpVar::<Fr>::new_input(
            ark_relations::ns!(cs, "hash_lo"),
            || Ok(Fr::from(self.block_hash_lo)),
        )?;
        let _hash_hi = FpVar::<Fr>::new_input(
            ark_relations::ns!(cs, "hash_hi"),
            || Ok(Fr::from(self.block_hash_hi)),
        )?;

        // Allocate private witness ───────────────────────────────────────────
        let diff_var = FpVar::<Fr>::new_witness(
            ark_relations::ns!(cs, "diff"),
            || Ok(Fr::from(self.difference)),
        )?;

        // Constraint 1: residual + diff == threshold
        let expected = &residual_var + &diff_var;
        expected.enforce_equal(&threshold_var)?;

        // Constraint 2: diff ≠ 0  (strict inequality: residual < threshold)
        diff_var.enforce_not_equal(&FpVar::zero())?;

        // Constraint 3: diff fits in 64 bits (range proof)
        // Decompose diff into 254 bits; enforce bits [64..254] are zero.
        let diff_bits = diff_var.to_bits_le()?;
        for bit in diff_bits.iter().skip(64) {
            bit.enforce_equal(&Boolean::FALSE)?;
        }

        Ok(())
    }
}

// ── Proving key cache (generated once per process) ───────────────────────────

struct Groth16Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

// SAFETY: ark-bn254 types are purely data (no raw pointers), so Send + Sync hold.
unsafe impl Send for Groth16Keys {}
unsafe impl Sync for Groth16Keys {}

static KEYS: OnceLock<Groth16Keys> = OnceLock::new();

/// Returns the cached proving/verifying keys.
/// On first call, generates a test CRS from a fixed seed (~100 ms on first run).
///
/// ⚠ TESTNET ONLY — replace with a proper MPC ceremony output before mainnet.
fn keys() -> &'static Groth16Keys {
    KEYS.get_or_init(|| {
        let mut rng = StdRng::seed_from_u64(0xCAFE_BABE_DEAD_BEEF);
        // Use a satisfiable witness for setup
        let circuit = StationarityCircuit {
            residual_fp:  5_000_000_000_000_000,  // 0.005
            threshold_fp: 10_000_000_000_000_000, // 0.01
            block_hash_lo: 0,
            block_hash_hi: 0,
            difference:   5_000_000_000_000_000,
        };
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng)
            .expect("Groth16 setup failed");
        let pvk = prepare_verifying_key(&vk);
        Groth16Keys { pk, pvk }
    })
}

// ── Public proof types (wire format) ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct G1Point {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct G2Point {
    pub x: [[u8; 32]; 2],
    pub y: [[u8; 32]; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Groth16ProofBytes {
    pub pi_a: G1Point,
    pub pi_b: G2Point,
    pub pi_c: G1Point,
    /// Raw canonical serialization for verification
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationarityPublicInputs {
    pub residual_fp:  [u8; 32],
    pub threshold_fp: [u8; 32],
    pub block_hash_lo: [u8; 32],
    pub block_hash_hi: [u8; 32],
}

/// Full ZK proof package carried inside each block header.
pub struct StationarityProof {
    pub proof: Groth16ProofBytes,
    pub public_inputs: StationarityPublicInputs,
    pub vk_hash: [u8; 32],
    pub valid: bool,
    // Legacy sigma-protocol fields (kept for backwards compatibility)
    pub challenge: [u8; 32],
    pub response: u64,
    pub revealed_txs: Vec<TxCandidate>,
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

fn u64_to_fr_bytes(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

fn current_vk_hash() -> [u8; 32] {
    let mut raw = Vec::new();
    keys().pvk.vk.alpha_g1.serialize_compressed(&mut raw).unwrap_or(());
    let mut h = Sha256::new();
    h.update(&raw);
    h.update(b"equilibrium:stationarity-v2-groth16-bn254");
    h.finalize().into()
}

/// Returns the expected VK hash for the current (test) proving key.
pub fn expected_vk_hash() -> [u8; 32] {
    current_vk_hash()
}

fn proof_to_wire(proof: &ark_groth16::Proof<Bn254>) -> Groth16ProofBytes {
    // Serialize π_A (G1, compressed 32 bytes)
    let mut a_buf = Vec::new();
    proof.a.serialize_compressed(&mut a_buf).unwrap_or(());
    let mut pi_a = G1Point { x: [0u8; 32], y: [0u8; 32] };
    if a_buf.len() >= 32 { pi_a.x.copy_from_slice(&a_buf[..32]); }
    if a_buf.len() >= 64 { pi_a.y.copy_from_slice(&a_buf[32..64]); }

    // Serialize π_B (G2, compressed 64 bytes)
    let mut b_buf = Vec::new();
    proof.b.serialize_compressed(&mut b_buf).unwrap_or(());
    let mut pi_b = G2Point { x: [[0u8; 32]; 2], y: [[0u8; 32]; 2] };
    if b_buf.len() >= 128 {
        pi_b.x[0].copy_from_slice(&b_buf[0..32]);
        pi_b.x[1].copy_from_slice(&b_buf[32..64]);
        pi_b.y[0].copy_from_slice(&b_buf[64..96]);
        pi_b.y[1].copy_from_slice(&b_buf[96..128]);
    }

    // Serialize π_C (G1, compressed 32 bytes)
    let mut c_buf = Vec::new();
    proof.c.serialize_compressed(&mut c_buf).unwrap_or(());
    let mut pi_c = G1Point { x: [0u8; 32], y: [0u8; 32] };
    if c_buf.len() >= 32 { pi_c.x.copy_from_slice(&c_buf[..32]); }
    if c_buf.len() >= 64 { pi_c.y.copy_from_slice(&c_buf[32..64]); }

    // Full raw serialization for compact re-verification
    let mut raw = Vec::new();
    proof.serialize_compressed(&mut raw).unwrap_or(());

    Groth16ProofBytes { pi_a, pi_b, pi_c, raw }
}

fn do_prove(
    residual_fp_val:  u64,
    threshold_fp_val: u64,
    hash_lo: u64,
    hash_hi: u64,
    difference: u64,
) -> Groth16ProofBytes {
    let circuit = StationarityCircuit {
        residual_fp: residual_fp_val,
        threshold_fp: threshold_fp_val,
        block_hash_lo: hash_lo,
        block_hash_hi: hash_hi,
        difference,
    };
    let mut rng = StdRng::from_entropy();
    let ark_proof = Groth16::<Bn254>::prove(&keys().pk, circuit, &mut rng)
        .expect("Groth16 proving failed");
    proof_to_wire(&ark_proof)
}

// ── Proof generation and verification ────────────────────────────────────────

impl StationarityProof {
    /// Generate a real Groth16 proof using arkworks + BN254.
    pub fn prove(
        header: &BlockHeader,
        txs: &[TxCandidate],
        _state: &ChainState,
        target_residual: f64,
    ) -> Self {
        // Fixed-point encode residual and threshold
        let residual_fp_val  = (header.residual * 1e18) as u64;
        let threshold_fp_val = (target_residual * 1e18) as u64;
        let satisfies = header.residual < target_residual;

        // Block hash binding (lo/hi from prev_hash)
        let hash_lo = u64::from_be_bytes(header.prev_hash[..8].try_into().unwrap_or([0u8; 8]));
        let hash_hi = u64::from_be_bytes(header.prev_hash[8..16].try_into().unwrap_or([0u8; 8]));

        // Compute witness: difference = threshold − residual (clamped to 1 if equal)
        let difference = if satisfies {
            threshold_fp_val.saturating_sub(residual_fp_val).max(1)
        } else {
            // Unsatisfiable — produce a dummy proof; verifier will reject it
            5_000_000_000_000_000
        };
        let (actual_r, actual_t, actual_lo, actual_hi, actual_diff) = if satisfies {
            (residual_fp_val, threshold_fp_val, hash_lo, hash_hi, difference)
        } else {
            (5_000_000_000_000_000, 10_000_000_000_000_000, 0, 0, 5_000_000_000_000_000)
        };

        let proof_bytes = do_prove(actual_r, actual_t, actual_lo, actual_hi, actual_diff);
        let vk_hash = current_vk_hash();

        let public_inputs = StationarityPublicInputs {
            residual_fp:  u64_to_fr_bytes(residual_fp_val),
            threshold_fp: u64_to_fr_bytes(threshold_fp_val),
            block_hash_lo: u64_to_fr_bytes(hash_lo),
            block_hash_hi: u64_to_fr_bytes(hash_hi),
        };

        // Legacy sigma fields
        let mut sigma = Sha256::new();
        sigma.update(header.prev_hash);
        sigma.update(header.merkle_root);
        sigma.update(header.timestamp.to_le_bytes());
        let challenge: [u8; 32] = sigma.finalize().into();

        Self {
            proof: proof_bytes,
            public_inputs,
            vk_hash,
            valid: satisfies,
            challenge,
            response: header.nonce,
            revealed_txs: txs.to_vec(),
        }
    }

    /// Verify a real Groth16 proof using the prepared verification key.
    pub fn verify(
        proof: &Self,
        header: &BlockHeader,
        _state: &ChainState,
        target_residual: f64,
    ) -> bool {
        // 1. VK hash must match the canonical circuit VK
        if proof.vk_hash != current_vk_hash() { return false; }

        // 2. Deserialize the proof bytes
        let ark_proof = match ark_groth16::Proof::<Bn254>::deserialize_compressed(
            proof.proof.raw.as_slice()
        ) {
            Ok(p) => p,
            Err(_) => return false,
        };

        // 3. Reconstruct public inputs
        let residual_fp_val  = (header.residual * 1e18) as u64;
        let threshold_fp_val = (target_residual * 1e18) as u64;
        let hash_lo = u64::from_be_bytes(header.prev_hash[..8].try_into().unwrap_or([0u8; 8]));
        let hash_hi = u64::from_be_bytes(header.prev_hash[8..16].try_into().unwrap_or([0u8; 8]));

        let public_inputs = vec![
            Fr::from(residual_fp_val),
            Fr::from(threshold_fp_val),
            Fr::from(hash_lo),
            Fr::from(hash_hi),
        ];

        // 4. Run the pairing-based Groth16 verifier
        matches!(
            Groth16::<Bn254>::verify_with_processed_vk(&keys().pvk, &public_inputs, &ark_proof),
            Ok(true)
        )
    }
}

/// Verify a raw proof given just the proof bytes and block context.
/// Used by the consensus-api sidecar to avoid reconstructing the full proof struct.
pub fn verify_raw_proof(
    proof_bytes: &Groth16ProofBytes,
    header: &BlockHeader,
    target_residual: f64,
) -> bool {
    let full = StationarityProof {
        proof: proof_bytes.clone(),
        public_inputs: StationarityPublicInputs {
            residual_fp:  [0u8; 32],
            threshold_fp: [0u8; 32],
            block_hash_lo: [0u8; 32],
            block_hash_hi: [0u8; 32],
        },
        vk_hash: current_vk_hash(),
        valid: false,
        challenge: [0u8; 32],
        response: 0,
        revealed_txs: vec![],
    };
    let dummy_state = ChainState::default();
    StationarityProof::verify(&full, header, &dummy_state, target_residual)
}
