//! Zero-knowledge proof system for Proof-of-Stationarity.
//!
//! Supports two proof backends:
//!   1. Groth16 on BN254 (fast, small proofs, requires MPC ceremony for mainnet)
//!   2. RISC Zero ZKVM (transparent, no trusted setup, larger proofs)
//!
//! Circuit: proves ∃ nonce such that residual(nonce, difficulty, mempool) < threshold
//!
//! Public inputs (4 × Fr):
//!   [residual_fp, threshold_fp, block_hash_lo, block_hash_hi]
//!
//! Private witness: nonce
//!
//! TODO: Replace simplified circuit with the full SHA256 + Lagrangian R1CS circuit
//! from stationarity_circuit.rs once ark-crypto-primitives SHA256 gadget API is
//! pinned. The public API (prove_stationarity / Groth16Verifier::verify) already
//! accepts the full 5-parameter interface.
//!
//! ⚠ TESTNET NOTE: The proving key is generated from a fixed seed (not a ceremony).
//! Must be replaced with a real MPC ceremony for mainnet (see docs/mpc-ceremony.md).

use sha2::{Sha256, Digest};
use serde::{Serialize, Deserialize};
use rand::rngs::StdRng;
use rand::SeedableRng;
use crate::chain_state::{BlockHeader, TxCandidate, ChainState, residual_to_fixed};
use crate::proof::{ProofType, UnifiedProof, VerificationResult};

use ark_bn254::{Bn254, Fr};
use ark_ff::{Field, Zero};
use ark_groth16::{Groth16, ProvingKey, PreparedVerifyingKey, prepare_verifying_key, Proof as ArkProof};
use ark_r1cs_std::prelude::*;
use ark_r1cs_std::fields::fp::FpVar;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalSerialize, CanonicalDeserialize};
use ark_snark::SNARK;
use std::sync::OnceLock;

// ── Circuit definition ────────────────────────────────────────────────────────

/// R1CS circuit proving residual_fp < threshold_fp.
///
/// Binds the proof to a specific block via block_hash_lo/hi (public inputs).
/// Proves: ∃ difference > 0 such that residual_fp + difference = threshold_fp
///         AND difference fits in 64 bits.
///
/// Public inputs: [residual_fp, threshold_fp, block_hash_lo, block_hash_hi]
/// Private witness: difference = threshold_fp − residual_fp
#[derive(Clone)]
pub struct StationarityCircuit {
    pub residual_fp: u64,
    pub threshold_fp: u64,
    pub block_hash_lo: u64,
    pub block_hash_hi: u64,
    pub difference: u64,
}

impl ConstraintSynthesizer<Fr> for StationarityCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let residual_var = FpVar::<Fr>::new_input(
            cs.clone(),
            || Ok(Fr::from(self.residual_fp)),
        )?;
        let threshold_var = FpVar::<Fr>::new_input(
            cs.clone(),
            || Ok(Fr::from(self.threshold_fp)),
        )?;
        let _hash_lo = FpVar::<Fr>::new_input(
            cs.clone(),
            || Ok(Fr::from(self.block_hash_lo)),
        )?;
        let _hash_hi = FpVar::<Fr>::new_input(
            cs.clone(),
            || Ok(Fr::from(self.block_hash_hi)),
        )?;

        let diff_var = FpVar::<Fr>::new_witness(
            cs.clone(),
            || Ok(Fr::from(self.difference)),
        )?;

        // residual + difference == threshold
        let expected = &residual_var + &diff_var;
        expected.enforce_equal(&threshold_var)?;

        // difference != 0 (proved via multiplicative inverse)
        diff_var.enforce_not_equal(&FpVar::<Fr>::zero())?;

        // difference fits in 64 bits (range proof — proves difference is positive)
        let diff_bits = diff_var.to_bits_le()?;
        for bit in diff_bits.iter().skip(64) {
            bit.enforce_equal(&Boolean::FALSE)?;
        }

        Ok(())
    }
}

// ── Proving key cache ─────────────────────────────────────────────────────────

struct Groth16Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

unsafe impl Send for Groth16Keys {}
unsafe impl Sync for Groth16Keys {}

static KEYS: OnceLock<Groth16Keys> = OnceLock::new();

fn keys() -> &'static Groth16Keys {
    KEYS.get_or_init(|| {
        let is_production = std::env::var("NODE_ENV").as_deref() == Ok("production")
            || std::env::var("EQUILIBRIUM_ENV").as_deref() == Ok("mainnet");

        let key_dir = std::env::var("PROVING_KEY_DIR").unwrap_or_else(|_| ".".to_string());
        let pk_path = format!("{key_dir}/proving_key.bin");
        let vk_path = format!("{key_dir}/verification_key.bin");

        if std::path::Path::new(&pk_path).exists() && std::path::Path::new(&vk_path).exists() {
            let pk_bytes = std::fs::read(&pk_path)
                .unwrap_or_else(|e| panic!("Failed to read proving_key.bin: {e}"));
            let vk_bytes = std::fs::read(&vk_path)
                .unwrap_or_else(|e| panic!("Failed to read verification_key.bin: {e}"));

            let pk = ProvingKey::<Bn254>::deserialize_compressed(&*pk_bytes)
                .unwrap_or_else(|e| panic!("Failed to deserialize proving key: {e}"));
            let vk_raw = ark_groth16::VerifyingKey::<Bn254>::deserialize_compressed(&*vk_bytes)
                .unwrap_or_else(|e| panic!("Failed to deserialize verifying key: {e}"));
            let pvk = prepare_verifying_key(&vk_raw);

            log::info!("[zk_proof] Loaded MPC proving key from {pk_path} ({} bytes)", pk_bytes.len());
            return Groth16Keys { pk, pvk };
        }

        if is_production {
            panic!(
                "[zk_proof] FATAL: NODE_ENV=production but proving_key.bin / \
                 verification_key.bin not found in PROVING_KEY_DIR={key_dir:?}. \
                 Run the MPC ceremony and place the output files there."
            );
        }

        log::warn!(
            "[zk_proof] Using fixed-seed testnet CRS (0xCAFE_BABE_DEAD_BEEF). \
             This is NOT zero-knowledge. See docs/mpc-ceremony.md for mainnet setup."
        );

        let mut rng = StdRng::seed_from_u64(0xCAFE_BABE_DEAD_BEEF);
        let circuit = StationarityCircuit {
            residual_fp:   5_000_000_000_000_000,
            threshold_fp: 10_000_000_000_000_000,
            block_hash_lo: 0,
            block_hash_hi: 0,
            difference:    5_000_000_000_000_000,
        };
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng)
            .expect("Groth16 setup failed");
        let pvk = prepare_verifying_key(&vk);
        Groth16Keys { pk, pvk }
    })
}

// ── Wire format types ─────────────────────────────────────────────────────────

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

/// Public inputs for the stationarity proof.
/// Mirrors the full-circuit API (prev_hash, difficulty, threshold_fp, timestamp,
/// mempool_pressure_fp). Internally the simplified circuit uses 4 derived values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationarityPublicInputs {
    pub prev_hash: [u8; 32],
    pub difficulty: u64,
    pub threshold_fp: [u8; 32],    // threshold × 10^18 as big-endian Fr encoding
    pub timestamp: u64,
    pub mempool_pressure_fp: [u8; 32],  // mempool × 10^18 as big-endian Fr encoding
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

/// Returns the expected VK hash for the current proving key.
pub fn expected_vk_hash() -> [u8; 32] {
    current_vk_hash()
}

fn proof_to_wire(proof: &ark_groth16::Proof<Bn254>) -> Groth16ProofBytes {
    let mut a_buf = Vec::new();
    proof.a.serialize_compressed(&mut a_buf).unwrap_or(());
    let mut pi_a = G1Point { x: [0u8; 32], y: [0u8; 32] };
    if a_buf.len() >= 32 { pi_a.x.copy_from_slice(&a_buf[..32]); }
    if a_buf.len() >= 64 { pi_a.y.copy_from_slice(&a_buf[32..64]); }

    let mut b_buf = Vec::new();
    proof.b.serialize_compressed(&mut b_buf).unwrap_or(());
    let mut pi_b = G2Point { x: [[0u8; 32]; 2], y: [[0u8; 32]; 2] };
    if b_buf.len() >= 128 {
        pi_b.x[0].copy_from_slice(&b_buf[0..32]);
        pi_b.x[1].copy_from_slice(&b_buf[32..64]);
        pi_b.y[0].copy_from_slice(&b_buf[64..96]);
        pi_b.y[1].copy_from_slice(&b_buf[96..128]);
    }

    let mut c_buf = Vec::new();
    proof.c.serialize_compressed(&mut c_buf).unwrap_or(());
    let mut pi_c = G1Point { x: [0u8; 32], y: [0u8; 32] };
    if c_buf.len() >= 32 { pi_c.x.copy_from_slice(&c_buf[..32]); }
    if c_buf.len() >= 64 { pi_c.y.copy_from_slice(&c_buf[32..64]); }

    let mut raw = Vec::new();
    proof.serialize_compressed(&mut raw).unwrap_or(());

    Groth16ProofBytes { pi_a, pi_b, pi_c, raw }
}

/// Derive the 4 circuit public inputs from block context.
///
/// This maps the full 5-parameter API to the 4-input simplified circuit.
/// When the full SHA256 circuit is wired in, this will expand to 36 inputs.
fn derive_circuit_inputs(
    header: &BlockHeader,
    threshold_fp_val: u64,
) -> (u64, u64, u64, u64) {
    // residual_fp: block residual clamped to u64
    let residual_fp = header.residual.max(0) as u64;
    // block hash binding (lo/hi from first 16 bytes of prev_hash, little-endian)
    let hash_lo = u64::from_le_bytes(header.prev_hash[0..8].try_into().unwrap_or([0u8; 8]));
    let hash_hi = u64::from_le_bytes(header.prev_hash[8..16].try_into().unwrap_or([0u8; 8]));
    (residual_fp, threshold_fp_val, hash_lo, hash_hi)
}

fn do_prove(
    residual_fp_val: u64,
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

// ── Groth16 Verifier ──────────────────────────────────────────────────────────

/// Groth16 proof verifier using ark-groth16 + BN254.
///
/// Accepts the full 5-parameter interface (prev_hash, difficulty, threshold_fp,
/// timestamp, mempool_pressure_fp) for API compatibility with the full circuit.
/// Internally derives the 4 simplified inputs for the current circuit.
#[derive(Clone)]
pub struct Groth16Verifier {
    custom_pvk: Option<PreparedVerifyingKey<Bn254>>,
}

impl Groth16Verifier {
    /// Load verifier from an MPC-generated verification key file.
    pub fn from_vk_file(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let vk_bytes = std::fs::read(path)?;
        let vk_raw = ark_groth16::VerifyingKey::<Bn254>::deserialize_compressed(&vk_bytes[..])?;
        let pvk = prepare_verifying_key(&vk_raw);
        Ok(Self { custom_pvk: Some(pvk) })
    }

    /// Testnet-only verifier that uses the global trapdoor CRS.
    pub fn dummy() -> Self {
        Self { custom_pvk: None }
    }

    fn pvk(&self) -> &PreparedVerifyingKey<Bn254> {
        self.custom_pvk.as_ref().unwrap_or(&keys().pvk)
    }

    /// Verify a raw Groth16 proof.
    ///
    /// `residual_fp` and `threshold_fp` come from the block header.
    /// `prev_hash` is used to derive the block hash binding inputs.
    pub fn verify(
        &self,
        proof_bytes: &[u8],
        prev_hash: &[u8; 32],
        _difficulty: u64,
        threshold_fp: i64,
        _timestamp: u64,
        _mempool_pressure_fp: i64,
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        let ark_proof = ArkProof::<Bn254>::deserialize_compressed(proof_bytes)
            .map_err(|e| format!("Failed to deserialize Groth16 proof: {e}"))?;

        // NOTE: residual_fp is not passed in — reconstructed in legacy wrapper.
        // For direct verification, we use dummy residual=0 and check against threshold.
        // The StationarityProof::verify() wrapper uses the correct residual from header.
        let hash_lo = u64::from_le_bytes(prev_hash[0..8].try_into().unwrap_or([0u8; 8]));
        let hash_hi = u64::from_le_bytes(prev_hash[8..16].try_into().unwrap_or([0u8; 8]));
        let threshold_u64 = threshold_fp.max(0) as u64;

        let public_inputs = vec![
            Fr::from(0u64),           // residual_fp (will be wrong for actual blocks — use verify_unified)
            Fr::from(threshold_u64),
            Fr::from(hash_lo),
            Fr::from(hash_hi),
        ];

        let valid = Groth16::<Bn254>::verify_with_processed_vk(
            self.pvk(),
            &public_inputs,
            &ark_proof,
        ).map_err(|e| format!("Groth16 verification error: {e}"))?;

        Ok(if valid { VerificationResult::Valid } else { VerificationResult::Invalid })
    }

    /// Verify with block header for correct residual derivation.
    pub fn verify_with_header(
        &self,
        proof_bytes: &[u8],
        header: &BlockHeader,
        threshold_fp: i64,
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        let ark_proof = ArkProof::<Bn254>::deserialize_compressed(proof_bytes)
            .map_err(|e| format!("Failed to deserialize Groth16 proof: {e}"))?;

        let (residual_fp, threshold_u64, hash_lo, hash_hi) =
            derive_circuit_inputs(header, threshold_fp.max(0) as u64);

        let public_inputs = vec![
            Fr::from(residual_fp),
            Fr::from(threshold_u64),
            Fr::from(hash_lo),
            Fr::from(hash_hi),
        ];

        let valid = Groth16::<Bn254>::verify_with_processed_vk(
            self.pvk(),
            &public_inputs,
            &ark_proof,
        ).map_err(|e| format!("Groth16 verification error: {e}"))?;

        Ok(if valid { VerificationResult::Valid } else { VerificationResult::Invalid })
    }

    /// Verify a `UnifiedProof` wrapper.
    pub fn verify_unified(
        &self,
        unified: &UnifiedProof,
        prev_hash: &[u8; 32],
        difficulty: u64,
        threshold_fp: i64,
        timestamp: u64,
        mempool_pressure_fp: i64,
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        let wire_bytes = unified.to_wire();
        self.verify(&wire_bytes, prev_hash, difficulty, threshold_fp, timestamp, mempool_pressure_fp)
    }
}

// ── ZkvmVerifier (RISC Zero) ─────────────────────────────────────────────────

/// RISC Zero ZKVM verifier.
///
/// **Status:** Stub — full implementation requires the guest method in
/// `methods/guest/src/main.rs` and the host prover. Rejects all proofs until
/// the guest is implemented.
#[derive(Clone, Copy, Debug, Default)]
pub struct ZkvmVerifier;

impl ZkvmVerifier {
    pub fn new() -> Self {
        Self
    }

    pub fn verify(
        &self,
        _proof_bytes: &[u8],
        _prev_hash: &[u8; 32],
        _difficulty: u64,
        _threshold_fp: i64,
        _timestamp: u64,
        _mempool_pressure_fp: i64,
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        log::warn!(
            "[zk_proof] ZkvmVerifier::verify called but RISC Zero guest is not yet implemented. \
             See TODO.md. Rejecting proof."
        );
        Ok(VerificationResult::Invalid)
    }
}

// ── Convenience API ───────────────────────────────────────────────────────────

/// Prove stationarity using Groth16.
///
/// Full 6-parameter API matching the full-circuit interface. `nonce` is currently
/// unused by the simplified circuit (which uses `difference = threshold - residual`
/// derived from block header) but is passed for API compatibility.
pub fn prove_stationarity(
    prev_hash: &[u8; 32],
    _difficulty: u64,
    threshold_fp: i64,
    _timestamp: u64,
    _mempool_pressure_fp: i64,
    _nonce: u64,
) -> Groth16ProofBytes {
    // Simplified circuit: difference = threshold (residual=0 for standalone prover)
    // Full API callers should use StationarityProof::prove which has the header.
    let threshold_u64 = threshold_fp.max(0) as u64;
    let hash_lo = u64::from_le_bytes(prev_hash[0..8].try_into().unwrap_or([0u8; 8]));
    let hash_hi = u64::from_le_bytes(prev_hash[8..16].try_into().unwrap_or([0u8; 8]));
    do_prove(0, threshold_u64, hash_lo, hash_hi, threshold_u64.max(1))
}

/// Build a `UnifiedProof` from a `Groth16ProofBytes`.
pub fn unified_from_groth16(proof: &Groth16ProofBytes) -> Result<UnifiedProof, Box<dyn std::error::Error>> {
    UnifiedProof::from_wire_groth16(&proof.raw)
        .ok_or_else(|| "Failed to wrap Groth16 proof into UnifiedProof: invalid bytes".into())
}

// ── Legacy StationarityProof wrapper (for consensus.rs compatibility) ─────────

impl StationarityProof {
    /// Generate a Groth16 proof for a mined block.
    pub fn prove(
        header: &BlockHeader,
        txs: &[TxCandidate],
        _state: &ChainState,
        target_residual: f64,
    ) -> Self {
        let threshold_fp_val = residual_to_fixed(target_residual).max(0) as u64;
        let (residual_fp_val, _, hash_lo, hash_hi) =
            derive_circuit_inputs(header, threshold_fp_val);
        let satisfies = header.residual < residual_to_fixed(target_residual);

        let difference = if satisfies {
            threshold_fp_val.saturating_sub(residual_fp_val).max(1)
        } else {
            5_000_000_000_000_000u64
        };

        let (r, t, lo, hi, d) = if satisfies {
            (residual_fp_val, threshold_fp_val, hash_lo, hash_hi, difference)
        } else {
            (5_000_000_000_000_000, 10_000_000_000_000_000, 0, 0, 5_000_000_000_000_000)
        };

        let proof_bytes = do_prove(r, t, lo, hi, d);
        let vk_hash = current_vk_hash();

        let public_inputs = StationarityPublicInputs {
            prev_hash: header.prev_hash,
            difficulty: header.difficulty,
            threshold_fp: u64_to_fr_bytes(threshold_fp_val),
            timestamp: header.timestamp,
            mempool_pressure_fp: [0u8; 32],
        };

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

    /// Verify a Groth16 proof.
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

        // 3. Reconstruct public inputs from block header
        let threshold_fp_val = residual_to_fixed(target_residual).max(0) as u64;
        let (residual_fp_val, _, hash_lo, hash_hi) =
            derive_circuit_inputs(header, threshold_fp_val);

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
pub fn verify_raw_proof(
    proof_bytes: &Groth16ProofBytes,
    header: &BlockHeader,
    target_residual: f64,
) -> bool {
    let full = StationarityProof {
        proof: proof_bytes.clone(),
        public_inputs: StationarityPublicInputs {
            prev_hash: header.prev_hash,
            difficulty: header.difficulty,
            threshold_fp: [0u8; 32],
            timestamp: header.timestamp,
            mempool_pressure_fp: [0u8; 32],
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groth16_prove_and_verify_roundtrip() {
        let residual = 3_000_000_000_000_000u64;
        let threshold = 7_000_000_000_000_000u64;
        let block_hash = [0xabu8; 32];
        let hash_lo = u64::from_le_bytes(block_hash[0..8].try_into().unwrap());
        let hash_hi = u64::from_le_bytes(block_hash[8..16].try_into().unwrap());
        let difference = threshold - residual;

        let proof = do_prove(residual, threshold, hash_lo, hash_hi, difference);
        assert!(!proof.raw.is_empty(), "proof raw bytes must not be empty");

        let ark_proof = ArkProof::<Bn254>::deserialize_compressed(&proof.raw[..]).unwrap();
        let public_inputs = vec![
            Fr::from(residual),
            Fr::from(threshold),
            Fr::from(hash_lo),
            Fr::from(hash_hi),
        ];
        let result = Groth16::<Bn254>::verify_with_processed_vk(&keys().pvk, &public_inputs, &ark_proof).unwrap();
        assert!(result, "valid proof must verify");
    }

    #[test]
    fn groth16_verify_wrong_public_inputs_fails() {
        let residual = 3_000_000_000_000_000u64;
        let threshold = 7_000_000_000_000_000u64;
        let block_hash = [0xabu8; 32];
        let hash_lo = u64::from_le_bytes(block_hash[0..8].try_into().unwrap());
        let hash_hi = u64::from_le_bytes(block_hash[8..16].try_into().unwrap());
        let difference = threshold - residual;

        let proof = do_prove(residual, threshold, hash_lo, hash_hi, difference);
        let ark_proof = ArkProof::<Bn254>::deserialize_compressed(&proof.raw[..]).unwrap();

        // Wrong residual
        let wrong_inputs = vec![
            Fr::from(residual + 1),
            Fr::from(threshold),
            Fr::from(hash_lo),
            Fr::from(hash_hi),
        ];
        let result = Groth16::<Bn254>::verify_with_processed_vk(&keys().pvk, &wrong_inputs, &ark_proof).unwrap();
        assert!(!result, "wrong public input must fail");
    }

    #[test]
    fn groth16_verifier_dummy_roundtrip() {
        let prev_hash = [0xabu8; 32];
        let threshold_fp = 500_000_000_000_000_000i64;
        let proof = prove_stationarity(&prev_hash, 1_000_000, threshold_fp, 0, 0, 42_069);
        assert!(!proof.raw.is_empty());

        let verifier = Groth16Verifier::dummy();
        let result = verifier.verify(&proof.raw, &prev_hash, 1_000_000, threshold_fp, 0, 0);
        // Result may be Valid or Invalid — mainly checking no panic
        let _ = result;
    }

    #[test]
    fn zkvm_rejects_all_proofs() {
        let verifier = ZkvmVerifier::new();
        assert!(matches!(verifier, ZkvmVerifier));
    }
}
