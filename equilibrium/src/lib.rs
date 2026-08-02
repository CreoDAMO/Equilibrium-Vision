pub mod stationary_solver;
pub mod chain_state;
pub mod crypto;
pub mod p2p;
pub mod p2p_runtime;
pub mod consensus;
// ── snarkjs / ceremony prove path ────────────────────────────────────────────
pub mod circom_reduction;
pub mod zk_proof;
pub mod ffi;
pub mod wallet;

// ── Dual-proof architecture (ZK Claim) ───────────────────────────────────────
// Unified proof types for Groth16 and RISC Zero — used by consensus.rs to
// dispatch to the correct verifier and by audit/canary mode.
pub mod proof;

// ── Mobile block validator (Mobile Claim) ────────────────────────────────────
// Background validation thread for Android phones — verifies residuals,
// signatures, Merkle roots, and state roots without trusting gossip.
pub mod mobile_validator;

// Android JNI bridge — compiled only when targeting Android.
// Host builds (consensus-api, testnet-node, wallet) are unaffected.
#[cfg(target_os = "android")]
pub mod jni_bridge;

// ── zkML / ERC-7992 DeepProve ─────────────────────────────────────────────────
// Host prover for quantized MLP inference via RISC Zero.
// Quantization utilities (quantize_weights, quantize_features, dequantize_output)
// are available unconditionally; prove_inference / verify_receipt are no-ops
// unless the `risc0` feature is enabled.
pub mod zkml_prover;

// Bridge between the on-chain model_registry contract and the off-chain prover.
// submit_model_inference is a no-op stub unless the `risc0` feature is enabled.
pub mod model_registry_integration;
