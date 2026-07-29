pub mod stationary_solver;
pub mod chain_state;
pub mod crypto;
pub mod p2p;
pub mod p2p_runtime;
pub mod consensus;
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
