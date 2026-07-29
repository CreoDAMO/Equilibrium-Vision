//! Integration: model_registry contract ↔ zkML prover
//!
//! When a model is registered on-chain, its weight Merkle root is stored.
//! When inference is requested, the host:
//!   1. Loads the model weights
//!   2. Quantizes to i8
//!   3. Computes the Merkle root
//!   4. Runs the zkML guest to prove correct inference
//!   5. POSTs the proof to the local API server (`POST /api/models/{id}/zkml-proof`)
//!      which stores the receipt and decoded output in the model registry.
//!
//! API contract (JSON body sent to the server):
//!   {
//!     "sealHex":       "<hex-encoded receipt_bytes>",
//!     "journalHex":    "<hex-encoded journal_bytes>",
//!     "modelRootHex":  "<hex-encoded model_root>",
//!     "inputHashHex":  "<hex-encoded input_hash>",
//!     "blockHeight":   <u64>
//!   }

use crate::chain_state::ChainState;

// ── With RISC Zero feature ────────────────────────────────────────────────────

#[cfg(feature = "risc0")]
pub fn submit_model_inference(
    model_id: u32,
    raw_weights: &[f32],
    raw_features: &[f32],
    dims: [u32; 3],
    chain_state: &ChainState,
    /// Base URL of the running API server, e.g. "http://localhost:8080".
    api_base_url: &str,
) -> Result<Vec<i32>, Box<dyn std::error::Error>> {
    use crate::zkml_prover::{parse_journal_bytes, prove_inference, quantize_features, quantize_weights};
    use reqwest::blocking::Client;

    let weights = quantize_weights(raw_weights);
    let features = quantize_features(raw_features);
    let block_height = chain_state.height;

    // Prove inference in the zkVM (Bonsai or local).
    let proof = prove_inference(weights, features, block_height, dims)?;

    // Parse the journal to extract public outputs for the request body.
    let output_info = parse_journal_bytes(&proof.journal_bytes)?;

    // Build the request body for POST /api/models/{id}/zkml-proof.
    let body = serde_json::json!({
        "sealHex":      hex::encode(&proof.receipt_bytes),
        "journalHex":   hex::encode(&proof.journal_bytes),
        "modelRootHex": hex::encode(output_info.model_root),
        "inputHashHex": hex::encode(output_info.input_hash),
        "blockHeight":  output_info.block_height,
    });

    let url = format!("{}/api/models/{}/zkml-proof", api_base_url, model_id);
    let client = Client::new();
    let resp = client.post(&url).json(&body).send()?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("API error {status}: {text}").into());
    }

    Ok(output_info.output)
}

// ── Stub when RISC Zero is not available ─────────────────────────────────────

/// Stub: returns an error when the `risc0` Cargo feature is not enabled.
#[cfg(not(feature = "risc0"))]
pub fn submit_model_inference(
    _model_id: u32,
    _raw_weights: &[f32],
    _raw_features: &[f32],
    _dims: [u32; 3],
    _chain_state: &ChainState,
    _api_base_url: &str,
) -> Result<Vec<i32>, Box<dyn std::error::Error>> {
    Err("RISC Zero feature not enabled — build with --features risc0".into())
}
