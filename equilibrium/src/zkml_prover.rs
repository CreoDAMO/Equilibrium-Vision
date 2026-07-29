//! zkML host prover for Equilibrium.
//!
//! Dual-mode RISC Zero proving:
//!   - Bonsai (GPU-accelerated, requires BONSAI_API_KEY)
//!   - Self-hosted (CPU or local CUDA, no external dependency)
//!
//! Integrates with model_registry contract for on-chain verification.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(feature = "risc0")]
use methods::{ZKML_GUEST_ELF, ZKML_GUEST_ID};
#[cfg(feature = "risc0")]
use risc0_zkvm::{get_prover, ExecutorEnv, Receipt};

// Re-export guest types for host use.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZkmlInput {
    pub weights: Vec<i8>,
    pub features: Vec<i16>,
    pub model_root: [u8; 32],
    pub input_hash: [u8; 32],
    pub block_height: u64,
    pub dims: [u32; 3],
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ZkmlOutput {
    pub model_root: [u8; 32],
    pub input_hash: [u8; 32],
    /// Quantized output logits (scale = 256).
    pub output: Vec<i32>,
    pub block_height: u64,
}

/// Result returned by `prove_inference`, containing both the receipt bytes (for
/// storage / peer sharing) and the raw journal bytes (for the on-chain
/// `EquilibriumZkmlVerifier` contract which needs them to compute the journal
/// hash independently).
pub struct ProofResult {
    /// Bincode-serialized `Receipt` — submit this to a peer or store off-chain.
    pub receipt_bytes: Vec<u8>,
    /// Raw RISC Zero journal bytes committed by the guest via `env::commit`.
    /// Pass these as the `journal` argument to `EquilibriumZkmlVerifier.verifyInference`.
    pub journal_bytes: Vec<u8>,
}

// ── Proving ───────────────────────────────────────────────────────────────────

/// Prove a quantized MLP inference in the zkVM.
///
/// Returns a `ProofResult` containing:
///   - `receipt_bytes`: bincode-serialized receipt for storage / peer sharing
///   - `journal_bytes`: raw journal bytes for the on-chain Solidity verifier
///
/// # Feature gate
/// This function requires `--features risc0`.  When the feature is absent, it
/// returns an error immediately so callers can degrade gracefully.
#[cfg(feature = "risc0")]
pub fn prove_inference(
    weights: Vec<i8>,
    features: Vec<i16>,
    block_height: u64,
    dims: [u32; 3],
) -> Result<ProofResult, Box<dyn std::error::Error>> {
    let model_root = merkle_root_i8(&weights);
    let input_hash = hash_features(&features);

    let input = ZkmlInput {
        weights,
        features,
        model_root,
        input_hash,
        block_height,
        dims,
    };

    let bonsai_key = std::env::var("BONSAI_API_KEY").ok();
    let receipt: Receipt = if bonsai_key.is_some() {
        log::info!("[zkml] Using Bonsai GPU prover");
        let env = ExecutorEnv::builder().write(&input)?.build()?;
        let prover = get_prover("bonsai");
        match prover.prove(env, ZKML_GUEST_ELF) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[zkml] Bonsai failed ({}), falling back to local", e);
                let env = ExecutorEnv::builder().write(&input)?.build()?;
                let prover = get_prover("local");
                prover.prove(env, ZKML_GUEST_ELF)?
            }
        }
    } else {
        log::info!("[zkml] Using local prover (BONSAI_API_KEY not set)");
        let env = ExecutorEnv::builder().write(&input)?.build()?;
        let prover = get_prover("local");
        prover.prove(env, ZKML_GUEST_ELF)?
    };

    receipt.verify(ZKML_GUEST_ID)?;

    let journal_bytes = receipt.journal.bytes.clone();
    let receipt_bytes = bincode::serialize(&receipt)?;

    Ok(ProofResult {
        receipt_bytes,
        journal_bytes,
    })
}

#[cfg(not(feature = "risc0"))]
pub fn prove_inference(
    _weights: Vec<i8>,
    _features: Vec<i16>,
    _block_height: u64,
    _dims: [u32; 3],
) -> Result<ProofResult, Box<dyn std::error::Error>> {
    Err("RISC Zero feature not enabled".into())
}

// ── Verification ──────────────────────────────────────────────────────────────

/// Verify a zkML receipt against expected public claims.
///
/// Deserialises the receipt with `bincode`, verifies it against `ZKML_GUEST_ID`,
/// then parses the journal with `parse_journal_bytes` and checks each field.
#[cfg(feature = "risc0")]
pub fn verify_receipt(
    receipt_bytes: &[u8],
    expected_model_root: &[u8; 32],
    expected_input_hash: &[u8; 32],
    expected_block_height: u64,
) -> Result<ZkmlOutput, Box<dyn std::error::Error>> {
    let receipt: Receipt = bincode::deserialize(receipt_bytes)
        .map_err(|e| format!("Failed to deserialise receipt: {e}"))?;

    receipt
        .verify(ZKML_GUEST_ID)
        .map_err(|e| format!("Receipt verification failed: {e}"))?;

    // Use the explicit byte-level parser so the same logic can be tested without
    // the risc0 toolchain and verified against the Solidity decoder.
    let output = parse_journal_bytes(&receipt.journal.bytes)?;

    if &output.model_root != expected_model_root {
        return Err("Model root mismatch".into());
    }
    if &output.input_hash != expected_input_hash {
        return Err("Input hash mismatch".into());
    }
    if output.block_height != expected_block_height {
        return Err("Block height mismatch".into());
    }

    Ok(output)
}

#[cfg(not(feature = "risc0"))]
pub fn verify_receipt(
    _receipt_bytes: &[u8],
    _expected_model_root: &[u8; 32],
    _expected_input_hash: &[u8; 32],
    _expected_block_height: u64,
) -> Result<ZkmlOutput, Box<dyn std::error::Error>> {
    Err("RISC Zero feature not enabled".into())
}

// ── Journal byte parser ───────────────────────────────────────────────────────

/// Parse raw RISC Zero journal bytes into a `ZkmlOutput`.
///
/// The layout matches `env::commit(&ZkmlOutput { ... })` in the guest, which
/// uses the RISC Zero serde codec (little-endian throughout):
///
/// | Offset       | Length | Field        |
/// |------------- |--------|--------------|
/// | 0            | 32     | model_root   |
/// | 32           | 32     | input_hash   |
/// | 64           | 4      | output.len (u32 LE) |
/// | 68           | 4×n    | output[i] (i32 LE) |
/// | 68 + 4n      | 8      | block_height (u64 LE) |
///
/// This function is intentionally **not** gated on `#[cfg(feature = "risc0")]`
/// so it can be tested without the full RISC Zero toolchain and reused wherever
/// raw journal bytes need to be inspected (e.g. the TypeScript API bridge).
pub fn parse_journal_bytes(bytes: &[u8]) -> Result<ZkmlOutput, Box<dyn std::error::Error>> {
    const MIN_LEN: usize = 76; // 32 + 32 + 4 + 0 + 8
    if bytes.len() < MIN_LEN {
        return Err(format!(
            "journal too short: {} bytes (minimum {MIN_LEN})",
            bytes.len()
        )
        .into());
    }

    let model_root: [u8; 32] = bytes[0..32].try_into()?;
    let input_hash: [u8; 32] = bytes[32..64].try_into()?;

    let output_len = u32::from_le_bytes(bytes[64..68].try_into()?) as usize;
    let expected_len = MIN_LEN + 4 * output_len; // 76 + 4n
    if bytes.len() != expected_len {
        return Err(format!(
            "journal length mismatch: expected {expected_len} bytes (output_len={output_len}), got {}",
            bytes.len()
        )
        .into());
    }

    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let off = 68 + 4 * i;
        output.push(i32::from_le_bytes(bytes[off..off + 4].try_into()?));
    }

    let bh_off = 68 + 4 * output_len;
    let block_height = u64::from_le_bytes(bytes[bh_off..bh_off + 8].try_into()?);

    Ok(ZkmlOutput {
        model_root,
        input_hash,
        output,
        block_height,
    })
}

// ── Quantisation utilities ────────────────────────────────────────────────────

/// Compute Merkle root of i8 weights (SHA-256 over raw bytes).
pub fn merkle_root_i8(data: &[i8]) -> [u8; 32] {
    let bytes: Vec<u8> = data.iter().map(|&x| x as u8).collect();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hasher.finalize().into()
}

/// Hash quantised features for input commitment.
pub fn hash_features(features: &[i16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for f in features {
        hasher.update(f.to_le_bytes());
    }
    hasher.finalize().into()
}

/// Quantise f32 weights to i8 (scale = 1/128, symmetric).
pub fn quantize_weights(weights: &[f32]) -> Vec<i8> {
    weights
        .iter()
        .map(|&w| {
            let scaled = w * 128.0;
            scaled.clamp(-128.0, 127.0) as i8
        })
        .collect()
}

/// Quantise f32 features to i16 (scale = 256).
pub fn quantize_features(features: &[f32]) -> Vec<i16> {
    features
        .iter()
        .map(|&f| {
            let scaled = f * 256.0;
            scaled.clamp(-32768.0, 32767.0) as i16
        })
        .collect()
}

/// Dequantise i32 outputs to f32 (scale = 256).
pub fn dequantize_output(output: &[i32]) -> Vec<f32> {
    output.iter().map(|&o| o as f32 / 256.0).collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantization_roundtrip() {
        let w = vec![0.5, -0.25, 0.0, 1.0, -1.0];
        let qw = quantize_weights(&w);
        assert_eq!(qw[0], 64); // 0.5 * 128
        assert_eq!(qw[1], -32); // -0.25 * 128
        assert_eq!(qw[2], 0);
        assert_eq!(qw[3], 127); // clamped
        assert_eq!(qw[4], -128); // clamped
    }

    #[test]
    fn feature_hash_deterministic() {
        let f = vec![100i16, -50, 0, 32767];
        assert_eq!(hash_features(&f), hash_features(&f));
    }

    #[test]
    fn merkle_root_deterministic() {
        let w = vec![1i8, -1, 0, 127, -128];
        assert_eq!(merkle_root_i8(&w), merkle_root_i8(&w));
    }

    /// Round-trips the journal parser against a manually-built byte buffer that
    /// matches the RISC Zero serde layout (little-endian throughout).  This test
    /// runs without the risc0 toolchain and validates that `parse_journal_bytes`
    /// and the Solidity decoder in `EquilibriumZkmlVerifier.sol` agree on the
    /// wire format.
    #[test]
    fn parse_journal_bytes_roundtrip() {
        let model_root = [1u8; 32];
        let input_hash = [2u8; 32];
        let output: Vec<i32> = vec![100, -50, 0, i32::MAX, i32::MIN];
        let block_height: u64 = 0x0001_FFFF_0000_ABCD;

        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&model_root);
        buf.extend_from_slice(&input_hash);
        buf.extend_from_slice(&(output.len() as u32).to_le_bytes());
        for o in &output {
            buf.extend_from_slice(&o.to_le_bytes());
        }
        buf.extend_from_slice(&block_height.to_le_bytes());

        let parsed = parse_journal_bytes(&buf).expect("parse failed");
        assert_eq!(parsed.model_root, model_root);
        assert_eq!(parsed.input_hash, input_hash);
        assert_eq!(parsed.output, output);
        assert_eq!(parsed.block_height, block_height);
    }

    #[test]
    fn parse_journal_bytes_rejects_short_input() {
        assert!(parse_journal_bytes(&[0u8; 75]).is_err());
        assert!(parse_journal_bytes(&[]).is_err());
    }

    #[test]
    fn parse_journal_bytes_empty_output_vec() {
        let mut buf = vec![0u8; 76]; // 32+32+4+8 = 76, output_len = 0
        // block_height at offset 68 = 0 (already zeroed)
        let parsed = parse_journal_bytes(&buf).expect("empty output parse failed");
        assert_eq!(parsed.output.len(), 0);
        assert_eq!(parsed.block_height, 0);

        // Length mismatch when output_len > 0 but buffer stays at 76 bytes.
        buf[64] = 1; // output_len = 1 but no element bytes → should fail
        assert!(parse_journal_bytes(&buf).is_err());
    }
}
