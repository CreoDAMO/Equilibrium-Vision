#![no_main]

use risc0_zkvm::guest::env;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Quantized MLP weights + input features.
/// All values are little-endian fixed-point.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ZkmlInput {
    /// Flattened i8 weights: [W1 (in×hid), b1 (hid), W2 (hid×out), b2 (out)]
    pub weights: Vec<i8>,
    /// Input feature vector (quantized i16)
    pub features: Vec<i16>,
    /// Expected model commitment (Merkle root of weights)
    pub model_root: [u8; 32],
    /// Hash of input features
    pub input_hash: [u8; 32],
    /// Block height for replay protection
    pub block_height: u64,
    /// Architecture: [input_dim, hidden_dim, output_dim]
    pub dims: [u32; 3],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ZkmlOutput {
    pub model_root: [u8; 32],
    pub input_hash: [u8; 32],
    /// Quantized output logits (scale = 256)
    pub output: Vec<i32>,
    pub block_height: u64,
}

risc0_zkvm::guest::entry!(main);

fn main() {
    let input: ZkmlInput = env::read();
    let [in_dim, hid_dim, out_dim] = input.dims.map(|d| d as usize);

    // 1. Verify model commitment
    let computed_root = merkle_root_i8(&input.weights);
    assert_eq!(computed_root, input.model_root, "model root mismatch");

    // 2. Verify input commitment
    let mut hasher = Sha256::new();
    for f in &input.features {
        hasher.update(&f.to_le_bytes());
    }
    let computed_input_hash: [u8; 32] = hasher.finalize().into();
    assert_eq!(computed_input_hash, input.input_hash, "input hash mismatch");

    // 3. Verify weight buffer size matches declared architecture
    let expected_weights = in_dim * hid_dim + hid_dim + hid_dim * out_dim + out_dim;
    assert_eq!(
        input.weights.len(),
        expected_weights,
        "weight buffer size mismatch"
    );

    // 4. Verify feature buffer size
    assert_eq!(input.features.len(), in_dim, "feature buffer size mismatch");

    // 5. Run quantized inference
    let output = quantized_mlp(&input.features, &input.weights, in_dim, hid_dim, out_dim);

    // 6. Commit public outputs
    env::commit(&ZkmlOutput {
        model_root: input.model_root,
        input_hash: input.input_hash,
        output,
        block_height: input.block_height,
    });
}

/// 2-layer MLP with ReLU.
/// Fixed-point scale = 256 for all intermediate values.
fn quantized_mlp(
    features: &[i16],
    weights: &[i8],
    in_dim: usize,
    hid_dim: usize,
    out_dim: usize,
) -> Vec<i32> {
    const SCALE: i32 = 256;

    let w1 = &weights[0..in_dim * hid_dim];
    let b1 = &weights[in_dim * hid_dim..in_dim * hid_dim + hid_dim];
    let w2 = &weights[in_dim * hid_dim + hid_dim..in_dim * hid_dim + hid_dim + hid_dim * out_dim];
    let b2 = &weights[in_dim * hid_dim + hid_dim + hid_dim * out_dim..];

    // Layer 1: hidden = relu(features · W1 + b1)
    let mut hidden = vec![0i32; hid_dim];
    for h in 0..hid_dim {
        let mut acc = (b1[h] as i32) * SCALE;
        for i in 0..in_dim {
            acc += (features[i] as i32) * (w1[i * hid_dim + h] as i32);
        }
        hidden[h] = relu(acc / SCALE);
    }

    // Layer 2: output = hidden · W2 + b2
    let mut out = vec![0i32; out_dim];
    for o in 0..out_dim {
        let mut acc = (b2[o] as i32) * SCALE;
        for h in 0..hid_dim {
            acc += hidden[h] * (w2[h * out_dim + o] as i32);
        }
        out[o] = acc / SCALE;
    }
    out
}

fn relu(x: i32) -> i32 {
    if x > 0 {
        x
    } else {
        0
    }
}

/// Merkle root of i8 weights using SHA-256.
fn merkle_root_i8(data: &[i8]) -> [u8; 32] {
    let bytes: Vec<u8> = data.iter().map(|&x| x as u8).collect();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hasher.finalize().into()
}
