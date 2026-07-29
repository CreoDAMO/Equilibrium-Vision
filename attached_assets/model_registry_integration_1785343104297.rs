//! Integration: model_registry contract ↔ zkML prover
//!
//! When a model is registered on-chain, its weight Merkle root is stored.
//! When inference is requested, the host:
//!   1. Loads the model weights
//!   2. Quantizes to i8
//!   3. Computes the Merkle root
//!   4. Runs the zkML guest to prove correct inference
//!   5. Submits the receipt to the model_registry contract

use crate::zkml_prover::{prove_inference, merkle_root_i8, quantize_weights, quantize_features};
use crate::chain_state::ChainState;

/// Submit an inference proof for an on-chain registered model.
///
/// # Flow
/// 1. Fetch model weights from storage / IPFS
/// 2. Quantize
/// 3. Prove in zkVM
/// 4. Submit receipt to contract
#[cfg(feature = "risc0")]
pub fn submit_model_inference(
    model_id: &str,
    raw_weights: &[f32],
    raw_features: &[f32],
    dims: [u32; 3],
    chain_state: &ChainState,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let weights = quantize_weights(raw_weights);
    let features = quantize_features(raw_features);
    let block_height = chain_state.height();

    let receipt_bytes = prove_inference(weights, features, block_height, dims)?;

    // TODO: Submit receipt_bytes to model_registry contract via RPC
    // contract.verify_inference(model_id, input_hash, output, receipt_bytes)

    Ok(receipt_bytes)
}
