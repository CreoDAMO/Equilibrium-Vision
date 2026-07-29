//! zkML host prover for Equilibrium.
//!
//! Dual-mode RISC Zero proving:
//!   - Bonsai (GPU-accelerated, requires BONSAI_API_KEY)
//!   - Self-hosted (CPU or local CUDA, no external dependency)
//!
//! Integrates with model_registry contract for on-chain verification.

use serde::{Serialize, Deserialize};
use sha2::{Sha256, Digest};

#[cfg(feature = "risc0")]
use risc0_zkvm::{get_prover, ExecutorEnv, Receipt};
#[cfg(feature = "risc0")]
use methods::{ZKML_GUEST_ELF, ZKML_GUEST_ID};

// Re-export guest types for host use
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZkmlInput {
    pub weights: Vec<i8>,
    pub features: Vec<i16>,
    pub model_root: [u8; 32],
    pub input_hash: [u8; 32],
    pub block_height: u64,
    pub dims: [u32; 3],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZkmlOutput {
    pub model_root: [u8; 32],
    pub input_hash: [u8; 32],
    pub output: Vec<i32>,
    pub block_height: u64,
}

/// Prove a quantized MLP inference in the zkVM.
///
/// # Arguments
/// * `weights` — Flattened i8 weights [W1, b1, W2, b2]
/// * `features` — Input vector (i16)
/// * `block_height` — Replay-protection nonce
/// * `dims` — [input_dim, hidden_dim, output_dim]
///
/// # Returns
/// Serialized `Receipt` bytes ready for on-chain or peer verification.
#[cfg(feature = "risc0")]
pub fn prove_inference(
    weights: Vec<i8>,
    features: Vec<i16>,
    block_height: u64,
    dims: [u32; 3],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
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

    let env = ExecutorEnv::builder()
        .write(&input)?
        .build()?;

    let bonsai_key = std::env::var("BONSAI_API_KEY").ok();
    let receipt = if bonsai_key.is_some() {
        log::info!("[zkml] Using Bonsai GPU prover");
        let prover = get_prover("bonsai");
        match prover.prove(env.clone(), ZKML_GUEST_ELF) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[zkml] Bonsai failed ({}), falling back to local", e);
                let prover = get_prover("local");
                prover.prove(env, ZKML_GUEST_ELF)?
            }
        }
    } else {
        log::info!("[zkml] Using local prover (BONSAI_API_KEY not set)");
        let prover = get_prover("local");
        prover.prove(env, ZKML_GUEST_ELF)?
    };

    receipt.verify(ZKML_GUEST_ID)?;
    let bytes = bincode::serialize(&receipt)?;
    Ok(bytes)
}

#[cfg(not(feature = "risc0"))]
pub fn prove_inference(
    _weights: Vec<i8>,
    _features: Vec<i16>,
    _block_height: u64,
    _dims: [u32; 3],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    Err("RISC Zero feature not enabled".into())
}

/// Verify a zkML receipt against public claims.
#[cfg(feature = "risc0")]
pub fn verify_receipt(
    receipt_bytes: &[u8],
    expected_model_root: &[u8; 32],
    expected_input_hash: &[u8; 32],
    expected_block_height: u64,
) -> Result<ZkmlOutput, Box<dyn std::error::Error>> {
    let receipt: Receipt = bincode::deserialize(receipt_bytes)
        .map_err(|e| format!("Failed to deserialize receipt: {e}"))?;

    receipt.verify(ZKML_GUEST_ID)
        .map_err(|e| format!("Receipt verification failed: {e}"))?;

    let output: ZkmlOutput = receipt.journal
        .decode()
        .map_err(|e| format!("Failed to decode journal: {e}"))?;

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

/// Compute Merkle root of i8 weights.
pub fn merkle_root_i8(data: &[i8]) -> [u8; 32] {
    let bytes: Vec<u8> = data.iter().map(|&x| x as u8).collect();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hasher.finalize().into()
}

/// Hash quantized features for input commitment.
pub fn hash_features(features: &[i16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for f in features {
        hasher.update(&f.to_le_bytes());
    }
    hasher.finalize().into()
}

/// Quantize f32 weights to i8 (scale = 1/128, symmetric).
pub fn quantize_weights(weights: &[f32]) -> Vec<i8> {
    weights.iter().map(|&w| {
        let scaled = w * 128.0;
        scaled.clamp(-128.0, 127.0) as i8
    }).collect()
}

/// Quantize f32 features to i16 (scale = 256).
pub fn quantize_features(features: &[f32]) -> Vec<i16> {
    features.iter().map(|&f| {
        let scaled = f * 256.0;
        scaled.clamp(-32768.0, 32767.0) as i16
    }).collect()
}

/// Dequantize i32 outputs to f32 (scale = 256).
pub fn dequantize_output(output: &[i32]) -> Vec<f32> {
    output.iter().map(|&o| o as f32 / 256.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantization_roundtrip() {
        let w = vec![0.5, -0.25, 0.0, 1.0, -1.0];
        let qw = quantize_weights(&w);
        assert_eq!(qw[0], 64);   // 0.5 * 128
        assert_eq!(qw[1], -32);  // -0.25 * 128
        assert_eq!(qw[2], 0);
        assert_eq!(qw[3], 127);  // clamped at 127
        assert_eq!(qw[4], -128); // clamped at -128
    }

    #[test]
    fn feature_hash_deterministic() {
        let f = vec![100i16, -50, 0, 32767];
        let h1 = hash_features(&f);
        let h2 = hash_features(&f);
        assert_eq!(h1, h2);
    }

    #[test]
    fn merkle_root_deterministic() {
        let w = vec![1i8, -1, 0, 127, -128];
        let r1 = merkle_root_i8(&w);
        let r2 = merkle_root_i8(&w);
        assert_eq!(r1, r2);
    }
}
