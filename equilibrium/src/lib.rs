pub mod stationary_solver;
pub mod chain_state;
pub mod crypto;
pub mod p2p;
pub mod consensus;
pub mod zk_proof;
pub mod ffi;
pub mod wallet;

// Android JNI bridge — compiled only when targeting Android.
// Host builds (consensus-api, testnet-node, wallet) are unaffected.
#[cfg(target_os = "android")]
pub mod jni_bridge;
