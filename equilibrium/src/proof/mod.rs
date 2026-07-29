// ── equilibrium::proof — Unified proof types for dual-proof consensus ─────────
//
// Equilibrium supports two independent proof systems for Proof-of-Stationarity:
//
//   Groth16  — 192 bytes, ~2 ms verification, requires MPC-generated CRS.
//              The default for miners once the MPC ceremony completes.
//              Currently uses a testnet CRS (fixed seed); mainnet MUST replace
//              this with keys from the MPC ceremony (see docs/mpc-ceremony.md).
//
//   ZkVM     — 200-500 KB, ~50-100 ms verification, no trusted setup.
//              Uses RISC Zero to prove the solver execution trace itself.
//              Any validator can audit a Groth16 block by re-proving it with
//              ZkVM and comparing claimed residuals — if >10% report mismatch
//              the chain switches to ZkVM-only for the epoch.
//
// Validators accept either proof type. The accepted set is governance-controlled
// via `ChainParameters::accepted_proof_types` (bit mask: 0x01=Groth16, 0x02=ZkVM).
//
// Wire format: the first byte of a serialized proof is the `ProofType` tag.
// This allows future proof systems to be added without breaking existing
// block deserialization.

use serde::{Deserialize, Serialize};

/// Result of running a proof verifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerificationResult {
    /// Proof is cryptographically valid.
    Valid,
    /// Proof is invalid (wrong public inputs, bad pairing, etc.).
    Invalid,
}

/// Identifies which proof system produced a `UnifiedProof`.
///
/// Stored as the first byte of the wire encoding so verifiers can dispatch
/// without deserializing the full proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum ProofType {
    /// Groth16 over BN254. 192-byte proof. Requires MPC-generated CRS.
    /// Verify time: ~2 ms on modern hardware.
    Groth16 = 0x01,

    /// RISC Zero zkVM execution proof. No trusted setup.
    /// Verify time: ~50-100 ms. Larger proof (~200-500 KB).
    Zkvm = 0x02,
}

impl ProofType {
    /// Parse the proof-type tag byte from the start of a wire-encoded proof.
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x01 => Some(Self::Groth16),
            0x02 => Some(Self::Zkvm),
            _ => None,
        }
    }

    /// Human-readable name for logging/diagnostics.
    pub fn name(self) -> &'static str {
        match self {
            Self::Groth16 => "groth16-bn254",
            Self::Zkvm    => "risc0-zkvm",
        }
    }
}

/// A proof of Proof-of-Stationarity in either supported system.
///
/// Carried inside block headers. Validators dispatch to the appropriate
/// verifier based on `proof_type`.
///
/// # Wire format
///
/// ```text
/// [0]:      proof_type  (u8, ProofType tag)
/// [1..N]:   bytes       (proof_type-specific serialization)
/// [N..M]:   public_inputs (proof_type-specific)
/// ```
///
/// The `claimed_residual_fp` is extracted from the proof's public inputs and
/// committed to in the block header — it must equal `block.header.residual`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedProof {
    /// Which proof system produced this proof.
    pub proof_type: ProofType,

    /// Raw proof bytes (Groth16: compressed ark-serialize; ZkVM: Receipt bytes).
    pub bytes: Vec<u8>,

    /// Public inputs in proof-system-native encoding.
    /// - Groth16: canonical ark-serialize of [residual_fp, threshold_fp, hash_lo, hash_hi]
    /// - ZkVM: RISC Zero journal bytes
    pub public_inputs: Vec<u8>,

    /// The residual value this proof commits to, fixed-point (×10^18).
    /// Must equal `block.header.residual`. Extracted from `public_inputs` by
    /// the verifier and compared; a mismatch is a consensus violation.
    pub claimed_residual_fp: i64,
}

impl UnifiedProof {
    /// Serialize to wire bytes (proof_type tag ++ proof bytes ++ public_inputs).
    pub fn to_wire(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + self.bytes.len() + self.public_inputs.len());
        out.push(self.proof_type as u8);
        out.extend_from_slice(&self.bytes);
        out.extend_from_slice(&self.public_inputs);
        out
    }

    /// Parse from wire bytes (inverse of `to_wire`).
    /// `proof_len` must be known from the proof system (Groth16: 192 bytes).
    pub fn from_wire_groth16(wire: &[u8]) -> Option<Self> {
        if wire.is_empty() { return None; }
        let proof_type = ProofType::from_byte(wire[0])?;
        if proof_type != ProofType::Groth16 { return None; }
        // Groth16: 192-byte compressed proof, rest is public inputs
        const GROTH16_PROOF_LEN: usize = 192;
        if wire.len() < 1 + GROTH16_PROOF_LEN { return None; }
        let bytes = wire[1..1 + GROTH16_PROOF_LEN].to_vec();
        let public_inputs = wire[1 + GROTH16_PROOF_LEN..].to_vec();
        Some(Self {
            proof_type,
            bytes,
            public_inputs,
            claimed_residual_fp: 0, // filled by verifier from public_inputs
        })
    }
}

/// Result of a proof audit (re-proving a Groth16 block with ZkVM).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuditResult {
    /// Both proofs claim the same residual — Groth16 block is consistent.
    Consistent {
        groth16_residual_fp: i64,
        zkvm_residual_fp:    i64,
    },
    /// The two proofs disagree on the residual — possible circuit bug or attack.
    Mismatch {
        groth16_residual_fp: i64,
        zkvm_residual_fp:    i64,
    },
    /// The ZkVM re-proof failed (execution error, not a mismatch).
    ZkvmError(String),
}

/// Returns the bitmask of accepted proof types from a governance parameter.
///
/// `mask` comes from `ChainParameters::accepted_proof_types`.
///   0x01 → Groth16 only
///   0x02 → ZkVM only
///   0x03 → both (default for mainnet transition period)
pub fn accepted_proof_types(mask: u8) -> Vec<ProofType> {
    let mut types = Vec::new();
    if mask & 0x01 != 0 { types.push(ProofType::Groth16); }
    if mask & 0x02 != 0 { types.push(ProofType::Zkvm); }
    types
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_type_roundtrip() {
        assert_eq!(ProofType::from_byte(0x01), Some(ProofType::Groth16));
        assert_eq!(ProofType::from_byte(0x02), Some(ProofType::Zkvm));
        assert_eq!(ProofType::from_byte(0x00), None);
        assert_eq!(ProofType::from_byte(0xFF), None);
    }

    #[test]
    fn accepted_proof_types_mask() {
        assert_eq!(accepted_proof_types(0x03), vec![ProofType::Groth16, ProofType::Zkvm]);
        assert_eq!(accepted_proof_types(0x01), vec![ProofType::Groth16]);
        assert_eq!(accepted_proof_types(0x02), vec![ProofType::Zkvm]);
        assert_eq!(accepted_proof_types(0x00), vec![]);
    }

    #[test]
    fn unified_proof_wire_roundtrip() {
        let proof = UnifiedProof {
            proof_type: ProofType::Groth16,
            bytes: vec![0u8; 192],
            public_inputs: vec![1, 2, 3, 4],
            claimed_residual_fp: 5_000_000_000_000_000,
        };
        let wire = proof.to_wire();
        assert_eq!(wire[0], 0x01);
        assert_eq!(wire.len(), 1 + 192 + 4);

        let recovered = UnifiedProof::from_wire_groth16(&wire).unwrap();
        assert_eq!(recovered.proof_type, ProofType::Groth16);
        assert_eq!(recovered.bytes, proof.bytes);
        assert_eq!(recovered.public_inputs, proof.public_inputs);
    }
}
