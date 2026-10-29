pub mod stationary_solver;
pub mod chain_state;
pub mod crypto;
pub mod p2p;
pub mod p2p_runtime;
pub mod consensus;
// ── snarkjs / ceremony prove path ────────────────────────────────────────────
pub mod circom_reduction;
pub mod zk_proof;
/// Integer successor skeleton. Not a proof of `applySuccessor`.
pub mod transition_circuit;
/// Opening of `faithful-v1.1`. Integer checks and the pinned relation. Not `applySuccessor`.
pub mod faithful_v1;
/// Integer projection of a CTP-1 statement. Not a proof of `Reference`.
pub mod ctp1_circuit;
/// Binary64 difficulty arithmetic. The same rounding ECMA-262 uses.
pub mod binary64;
/// Groth16 of the production difficulty law, clamp included.
pub mod difficulty_law;
/// SHA-256 of the residual header.
pub mod header_digest;
/// Header, residual, reward, and split in one statement.
pub mod header_reward;
/// Liquid split and staking floors. The reward is not yet derived.
pub mod reward_split;
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
// solveBlock searches the shared residual. It does not apply the successor.
#[cfg(target_os = "android")]
pub mod jni_bridge;

#[cfg(test)]
mod site_contract;

// Digests of a site-produced state, and the native successor for the
// transitions membrane.run.ts executes, including one composed input.
// Not a second chain, and not the phone.
#[cfg(test)]
mod commitment;

// ── zkML / ERC-7992 DeepProve ─────────────────────────────────────────────────
// Host prover for quantized MLP inference via RISC Zero.
// Quantization utilities (quantize_weights, quantize_features, dequantize_output)
// are available unconditionally; prove_inference / verify_receipt are no-ops
// unless the `risc0` feature is enabled.
pub mod zkml_prover;

// Bridge between the on-chain model_registry contract and the off-chain prover.
// submit_model_inference is a no-op stub unless the `risc0` feature is enabled.
pub mod model_registry_integration;
