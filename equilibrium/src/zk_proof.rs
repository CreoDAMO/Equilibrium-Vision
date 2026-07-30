//! Zero-knowledge proof system for Proof-of-Stationarity.
//!
//! Dual-mode proving:
//!   1. Groth16 on BN254 (fast, small proofs, requires MPC ceremony for mainnet)
//!   2. RISC Zero ZKVM (transparent, no trusted setup, larger proofs)
//!
//! RISC Zero proving is dual:
//!   - Bonsai (GPU-accelerated, managed, requires BONSAI_API_KEY)
//!   - Self-hosted (CPU or local CUDA, no external dependency)
//!
//! Runtime selection via env vars — no recompilation needed.

use sha2::{Sha256, Digest};
use serde::{Serialize, Deserialize};
use rand::rngs::StdRng;
use rand::SeedableRng;
use crate::chain_state::{BlockHeader, TxCandidate, ChainState, residual_to_fixed};
use crate::proof::{UnifiedProof, VerificationResult};

use ark_bn254::{Bn254, Fr};
use ark_ff::{Field, One, Zero};
use ark_groth16::{Groth16, ProvingKey, PreparedVerifyingKey, prepare_verifying_key, Proof as ArkProof};
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalSerialize, CanonicalDeserialize};
use ark_snark::SNARK;
use std::sync::OnceLock;

// ── RISC Zero (optional compile-time feature) ────────────────────────────────
#[cfg(feature = "risc0")]
use risc0_zkvm::{get_prover, ExecutorEnv, Receipt};
#[cfg(feature = "risc0")]
use methods::{STATIONARITY_GUEST_ELF, STATIONARITY_GUEST_ID};

// ── Minimal StationarityCircuit (FpVar-only, ark 0.4 compatible) ───────────

#[derive(Clone)]
pub struct StationarityCircuit {
    pub residual_fp: Option<u64>,
    pub threshold_fp: Option<u64>,
    pub block_hash_lo: Option<u64>,
    pub block_hash_hi: Option<u64>,
    pub difference: Option<u64>,
}

impl ConstraintSynthesizer<Fr> for StationarityCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let residual = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(self.residual_fp.unwrap_or(0)))
        })?;
        let threshold = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(self.threshold_fp.unwrap_or(0)))
        })?;
        let _hash_lo = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(self.block_hash_lo.unwrap_or(0)))
        })?;
        let _hash_hi = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(self.block_hash_hi.unwrap_or(0)))
        })?;

        let difference = FpVar::new_witness(cs.clone(), || {
            Ok(Fr::from(self.difference.unwrap_or(0)))
        })?;

        let sum = &residual + &difference;
        sum.enforce_equal(&threshold)?;

        let diff_inv = FpVar::new_witness(cs.clone(), || {
            let d = difference.value().unwrap_or(Fr::zero());
            Ok(d.inverse().unwrap_or(Fr::one()))
        })?;
        difference.mul_equals(&diff_inv, &FpVar::one())?;

        let diff_bits = difference.to_bits_le()?;
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
            residual_fp: Some(5_000_000_000_000_000),
            threshold_fp: Some(10_000_000_000_000_000),
            block_hash_lo: Some(0),
            block_hash_hi: Some(0),
            difference: Some(5_000_000_000_000_000),
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
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationarityPublicInputs {
    pub prev_hash:           [u8; 32],
    pub difficulty:          u64,
    pub threshold_fp:        [u8; 32],
    pub timestamp:           u64,
    pub mempool_pressure_fp: [u8; 32],
}

pub struct StationarityProof {
    pub proof: Groth16ProofBytes,
    pub public_inputs: StationarityPublicInputs,
    pub vk_hash: [u8; 32],
    pub valid: bool,
    pub challenge: [u8; 32],
    pub response: u64,
    pub revealed_txs: Vec<TxCandidate>,
}

impl StationarityProof {
    /// Prove stationarity for a block. Generates a Groth16 proof that the
    /// block's residual is below the given threshold.
    pub fn prove(
        header: &BlockHeader,
        _txs: &[TxCandidate],
        _state: &ChainState,
        threshold: f64,
    ) -> StationarityProof {
        let residual_fp = header.residual.unsigned_abs();
        let threshold_fp = residual_to_fixed(threshold).unsigned_abs();
        let groth16_proof = prove_stationarity(residual_fp, threshold_fp, &header.prev_hash);

        let mut threshold_bytes = [0u8; 32];
        threshold_bytes[..8].copy_from_slice(&threshold_fp.to_le_bytes());

        StationarityProof {
            proof: groth16_proof,
            public_inputs: StationarityPublicInputs {
                prev_hash:           header.prev_hash,
                difficulty:          header.difficulty,
                threshold_fp:        threshold_bytes,
                timestamp:           header.timestamp,
                mempool_pressure_fp: [0u8; 32],
            },
            vk_hash:      expected_vk_hash(),
            valid:        true,
            challenge:    [0u8; 32],
            response:     0,
            revealed_txs: vec![],
        }
    }

    /// Verify a stationarity proof against a block header.
    ///
    /// Returns `false` immediately on vk_hash mismatch (cheap) or empty proof
    /// bytes, before attempting the full Groth16 deserialization and pairing
    /// check.
    pub fn verify(
        proof: &StationarityProof,
        header: &BlockHeader,
        _state: &ChainState,
        threshold: f64,
    ) -> bool {
        // Fast rejection: vk_hash mismatch means wrong circuit / CRS
        if proof.vk_hash != expected_vk_hash() {
            return false;
        }
        if proof.proof.raw.is_empty() {
            return false;
        }

        let residual_fp = header.residual.unsigned_abs();
        let threshold_fp = residual_to_fixed(threshold).unsigned_abs();

        let verifier = Groth16Verifier::dummy();
        matches!(
            verifier.verify(&proof.proof.raw, residual_fp, threshold_fp, &header.prev_hash),
            Ok(VerificationResult::Valid)
        )
    }
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

fn current_vk_hash() -> [u8; 32] {
    let mut raw = Vec::new();
    keys().pvk.vk.alpha_g1.serialize_compressed(&mut raw).unwrap_or(());
    let mut h = Sha256::new();
    h.update(&raw);
    h.update(b"equilibrium:stationarity-v2-groth16-bn254");
    h.finalize().into()
}

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

fn do_prove(
    residual_fp_val: u64,
    threshold_fp_val: u64,
    hash_lo: u64,
    hash_hi: u64,
    difference: u64,
) -> Groth16ProofBytes {
    let circuit = StationarityCircuit {
        residual_fp: Some(residual_fp_val),
        threshold_fp: Some(threshold_fp_val),
        block_hash_lo: Some(hash_lo),
        block_hash_hi: Some(hash_hi),
        difference: Some(difference),
    };
    let mut rng = StdRng::from_entropy();
    let ark_proof = Groth16::<Bn254>::prove(&keys().pk, circuit, &mut rng)
        .expect("Groth16 proving failed");
    proof_to_wire(&ark_proof)
}

fn block_hash_to_u64_pair(block_hash: &[u8; 32]) -> (u64, u64) {
    let lo = u64::from_le_bytes(block_hash[0..8].try_into().unwrap());
    let hi = u64::from_le_bytes(block_hash[8..16].try_into().unwrap());
    (lo, hi)
}

// ── Groth16 Verifier ─────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Groth16Verifier {
    custom_pvk: Option<PreparedVerifyingKey<Bn254>>,
}

impl Groth16Verifier {
    pub fn from_vk_file(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let vk_bytes = std::fs::read(path)?;
        let vk_raw = ark_groth16::VerifyingKey::<Bn254>::deserialize_compressed(&vk_bytes[..])?;
        let pvk = prepare_verifying_key(&vk_raw);
        Ok(Self { custom_pvk: Some(pvk) })
    }

    pub fn dummy() -> Self {
        Self { custom_pvk: None }
    }

    fn pvk(&self) -> &PreparedVerifyingKey<Bn254> {
        self.custom_pvk.as_ref().unwrap_or(&keys().pvk)
    }

    pub fn verify(
        &self,
        proof_bytes: &[u8],
        residual_fp: u64,
        threshold_fp: u64,
        block_hash: &[u8; 32],
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        let ark_proof = ArkProof::<Bn254>::deserialize_compressed(proof_bytes)
            .map_err(|e| format!("Failed to deserialize Groth16 proof: {e}"))?;

        let (hash_lo, hash_hi) = block_hash_to_u64_pair(block_hash);

        let public_inputs = vec![
            Fr::from(residual_fp),
            Fr::from(threshold_fp),
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

    pub fn verify_unified(
        &self,
        unified: &UnifiedProof,
        residual_fp: u64,
        threshold_fp: u64,
        block_hash: &[u8; 32],
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        // Use unified.bytes directly — to_wire() prepends the type tag byte
        // which causes ark's compressed deserializer to fail on the 0x01 prefix.
        self.verify(&unified.bytes, residual_fp, threshold_fp, block_hash)
    }
}

// ── RISC Zero types ──────────────────────────────────────────────────────────

/// Host-side input passed to the RISC Zero ZkVM guest.
///
/// Field order **must** match `StationarityInput` in
/// `methods/guest/src/main.rs` — risc0 uses bincode/postcard serialisation
/// where field order determines the on-wire layout.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZkvmInput {
    pub prev_hash:       [u8; 32],
    pub merkle_root:     [u8; 32],
    pub timestamp:       u64,
    pub nonce:           u64,
    pub difficulty:      u64,
    pub recursion_depth: u32,
    /// Claimed residual (fixed-point, same scale as the chain validator).
    pub residual_fp:     u64,
    pub threshold_fp:    u64,
    pub cumulative_work: u64,
    pub height:          u64,
}

/// Journal output decoded from the RISC Zero receipt.
///
/// `residual_fp` is now the *recomputed* value from the guest, not a
/// pass-through — so if the prover supplied a wrong `residual_fp` the receipt
/// cannot be produced (the guest panics on the assert_eq).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZkvmOutput {
    pub residual_fp:   u64,
    pub threshold_fp:  u64,
    pub block_hash_lo: u64,
    pub block_hash_hi: u64,
}

/// Dual-mode RISC Zero prover: Bonsai (GPU) → fallback to self-hosted (CPU/local CUDA).
#[derive(Clone, Debug)]
pub struct DualZkvmProver;

impl DualZkvmProver {
    /// Prove with Bonsai if BONSAI_API_KEY is set, else self-hosted.
    ///
    /// The guest now **recomputes** the residual from header fields rather than
    /// accepting `residual + difference == threshold` as a witness.  All header
    /// fields that the guest's `residual_at_nonce` function hashes must be
    /// supplied here so the prover can produce a valid receipt.
    #[cfg(feature = "risc0")]
    pub fn prove(
        residual_fp:     u64,
        threshold_fp:    u64,
        prev_hash:       &[u8; 32],
        nonce:           u64,
        timestamp:       u64,
        difficulty:      u64,
        height:          u64,
        merkle_root:     &[u8; 32],
        cumulative_work: u64,
        recursion_depth: u32,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        assert!(residual_fp < threshold_fp, "residual must be below threshold");

        let input = ZkvmInput {
            prev_hash:       *prev_hash,
            merkle_root:     *merkle_root,
            timestamp,
            nonce,
            difficulty,
            recursion_depth,
            residual_fp,
            threshold_fp,
            cumulative_work,
            height,
        };

        let env = ExecutorEnv::builder()
            .write(&input)?
            .build()?;

        // RISC Zero 2.x: use get_prover("bonsai") / get_prover("local")
        let bonsai_key = std::env::var("BONSAI_API_KEY").ok();
        let receipt = if bonsai_key.is_some() {
            log::info!("[zk_proof] Using Bonsai GPU prover");
            let prover = get_prover("bonsai");
            match prover.prove(env.clone(), STATIONARITY_GUEST_ELF) {
                Ok(r) => r.receipt,
                Err(e) => {
                    log::warn!("[zk_proof] Bonsai failed ({}), falling back to local", e);
                    get_prover("local").prove(env, STATIONARITY_GUEST_ELF)?.receipt
                }
            }
        } else {
            log::info!("[zk_proof] Using local prover (BONSAI_API_KEY not set)");
            get_prover("local").prove(env, STATIONARITY_GUEST_ELF)?.receipt
        };

        receipt.verify(STATIONARITY_GUEST_ID)?;
        let bytes = bincode::serialize(&receipt)?;
        Ok(bytes)
    }

    #[cfg(not(feature = "risc0"))]
    pub fn prove(
        _residual_fp:     u64,
        _threshold_fp:    u64,
        _prev_hash:       &[u8; 32],
        _nonce:           u64,
        _timestamp:       u64,
        _difficulty:      u64,
        _height:          u64,
        _merkle_root:     &[u8; 32],
        _cumulative_work: u64,
        _recursion_depth: u32,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        Err("RISC Zero feature not enabled".into())
    }
}

// ── ZkvmVerifier ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct ZkvmVerifier {
    #[cfg(feature = "risc0")]
    image_id: [u32; 8],
}

impl Default for ZkvmVerifier {
    fn default() -> Self {
        Self::new()
    }
}

impl ZkvmVerifier {
    pub fn new() -> Self {
        #[cfg(feature = "risc0")] {
            Self { image_id: STATIONARITY_GUEST_ID }
        }
        #[cfg(not(feature = "risc0"))] {
            Self {}
        }
    }

    pub fn verify(
        &self,
        proof_bytes: &[u8],
        residual_fp: u64,
        threshold_fp: u64,
        block_hash: &[u8; 32],
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        #[cfg(not(feature = "risc0"))] {
            let _ = (proof_bytes, residual_fp, threshold_fp, block_hash);
            log::warn!("[zk_proof] RISC Zero feature not enabled; rejecting Zkvm proof.");
            Ok(VerificationResult::Invalid)
        }

        #[cfg(feature = "risc0")] {
            let receipt: Receipt = bincode::deserialize(proof_bytes)
                .map_err(|e| format!("Failed to deserialize RISC Zero receipt: {e}"))?;

            receipt
                .verify(self.image_id)
                .map_err(|e| format!("RISC Zero receipt verification failed: {e}"))?;

            let output: ZkvmOutput = receipt
                .journal
                .decode()
                .map_err(|e| format!("Failed to decode journal: {e}"))?;

            let (hash_lo, hash_hi) = block_hash_to_u64_pair(block_hash);

            if output.residual_fp != residual_fp
                || output.threshold_fp != threshold_fp
                || output.block_hash_lo != hash_lo
                || output.block_hash_hi != hash_hi
            {
                return Ok(VerificationResult::Invalid);
            }

            Ok(VerificationResult::Valid)
        }
    }

    pub fn verify_unified(
        &self,
        unified: &UnifiedProof,
        residual_fp: u64,
        threshold_fp: u64,
        block_hash: &[u8; 32],
    ) -> Result<VerificationResult, Box<dyn std::error::Error>> {
        // Use unified.bytes directly — to_wire() prepends the type tag byte
        // which causes RISC Zero bincode deserializer to fail on the 0x02 prefix.
        self.verify(&unified.bytes, residual_fp, threshold_fp, block_hash)
    }
}

// ── Convenience API ───────────────────────────────────────────────────────────

pub fn prove_stationarity(
    residual_fp: u64,
    threshold_fp: u64,
    block_hash: &[u8; 32],
) -> Groth16ProofBytes {
    assert!(residual_fp < threshold_fp, "residual must be below threshold");
    let difference = threshold_fp - residual_fp;
    let (hash_lo, hash_hi) = block_hash_to_u64_pair(block_hash);
    do_prove(residual_fp, threshold_fp, hash_lo, hash_hi, difference)
}

/// Prove stationarity for a block using the ZkVM (RISC Zero) path.
///
/// The guest recomputes the residual from the supplied header fields and
/// asserts it equals `residual_fp`, binding the receipt to a specific block.
///
/// `prev_hash` is the parent block's hash (the field the residual is hashed
/// against).  Supply `nonce`, `timestamp`, and `difficulty` from the mined
/// block header; the rest default to conservative placeholders.
#[cfg(feature = "risc0")]
pub fn prove_stationarity_zkvm(
    residual_fp:  u64,
    threshold_fp: u64,
    prev_hash:    &[u8; 32],
    nonce:        u64,
    timestamp:    u64,
    difficulty:   u64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    DualZkvmProver::prove(
        residual_fp,
        threshold_fp,
        prev_hash,
        nonce,
        timestamp,
        difficulty,
        0,            // height — informational; does not affect residual check
        &[0u8; 32],  // merkle_root placeholder (not yet in guest residual)
        0,            // cumulative_work placeholder
        2,            // recursion_depth default
    )
}

pub fn unified_from_groth16(proof: &Groth16ProofBytes) -> Option<UnifiedProof> {
    UnifiedProof::from_wire_groth16(&proof.raw)
}

/// Verify a raw `Groth16ProofBytes` against a block header and threshold.
/// Convenience wrapper used by the consensus-api binary.
pub fn verify_raw_proof(proof: &Groth16ProofBytes, header: &BlockHeader, threshold: f64) -> bool {
    let residual_fp  = header.residual.unsigned_abs();
    let threshold_fp = residual_to_fixed(threshold).unsigned_abs();
    let verifier = Groth16Verifier::dummy();
    matches!(
        verifier.verify(&proof.raw, residual_fp, threshold_fp, &header.prev_hash),
        Ok(VerificationResult::Valid)
    )
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

        let proof = prove_stationarity(residual, threshold, &block_hash);
        assert!(!proof.raw.is_empty());

        let verifier = Groth16Verifier::dummy();
        let result = verifier.verify(&proof.raw, residual, threshold, &block_hash).unwrap();
        assert!(matches!(result, VerificationResult::Valid));
    }

    #[test]
    fn groth16_verify_bad_proof_fails() {
        let residual = 3_000_000_000_000_000u64;
        let threshold = 7_000_000_000_000_000u64;
        let block_hash = [0xabu8; 32];

        let bad_proof = vec![0u8; 192];
        let verifier = Groth16Verifier::dummy();
        let result = verifier.verify(&bad_proof, residual, threshold, &block_hash);
        assert!(result.is_err() || matches!(result.unwrap(), VerificationResult::Invalid));
    }

    #[test]
    fn groth16_verify_wrong_public_inputs_fails() {
        let residual = 3_000_000_000_000_000u64;
        let threshold = 7_000_000_000_000_000u64;
        let block_hash = [0xabu8; 32];

        let proof = prove_stationarity(residual, threshold, &block_hash);
        let verifier = Groth16Verifier::dummy();
        let result = verifier.verify(&proof.raw, residual + 1, threshold, &block_hash).unwrap();
        assert!(matches!(result, VerificationResult::Invalid));
    }

    #[test]
    #[cfg(feature = "risc0")]
    fn zkvm_dual_prove_and_verify_roundtrip() {
        let residual = 3_000_000_000_000_000u64;
        let threshold = 7_000_000_000_000_000u64;
        let block_hash = [0xabu8; 32];

        let receipt_bytes = DualZkvmProver::prove(residual, threshold, &block_hash)
            .expect("zkvm proving failed");

        let verifier = ZkvmVerifier::new();
        let result = verifier.verify(&receipt_bytes, residual, threshold, &block_hash)
            .expect("zkvm verification error");

        assert!(matches!(result, VerificationResult::Valid));
    }

    #[test]
    #[cfg(not(feature = "risc0"))]
    fn zkvm_stub_rejects_when_feature_off() {
        let verifier = ZkvmVerifier::new();
        let result = verifier.verify(&[], 1, 2, &[0u8; 32]).unwrap();
        assert!(matches!(result, VerificationResult::Invalid));
    }
}
