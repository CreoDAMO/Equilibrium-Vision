// ── Android JNI bridge ────────────────────────────────────────────────────────
//
// Exposes `com.equilibrium.MiningWorker.solveBlock` to the JVM.
//
// This module is compiled only when targeting Android (`cfg(target_os = "android")`).
// The host build (consensus-api sidecar, testnet-node, wallet) is unaffected.
//
// Cross-compile with cargo-ndk:
//   cargo ndk -t armeabi-v7a -t arm64-v8a -t x86_64 \
//     -o mobile/android/app/src/main/jniLibs build --release --lib
//
// See mobile/android/build-jni.sh for the full setup script.

#![cfg(target_os = "android")]

use jni::{
    objects::{JByteArray, JDoubleArray, JLongArray, JObject},
    sys::{jboolean, jdouble, jint, jlong, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};

use crate::{
    chain_state::{BlockHeader, ChainState},
    stationary_solver::StationarySolver,
};

/// JNI entry point for `com.equilibrium.MiningWorker.solveBlock`.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun solveBlock(
///     prevHash:        ByteArray,
///     merkleRoot:      ByteArray,
///     timestamp:       Long,
///     difficulty:      Long,
///     recursionDepth:  Int,
///     mempoolPressure: Double,
///     cumWork:         Long,
///     maxAttempts:     Long,
///     outNonce:        LongArray,   // out: [nonce]
///     outResidual:     DoubleArray  // out: [residual]
/// ): Boolean
/// ```
///
/// Returns JNI_TRUE on success (outNonce[0] and outResidual[0] are filled in),
/// JNI_FALSE if the solver exhausted maxAttempts without finding a solution or
/// if a JNI array operation fails.
///
/// # Safety
/// Called by the JVM; all pointer validity is enforced by the JNI layer.
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_MiningWorker_solveBlock(
    mut env:            JNIEnv,
    _obj:               JObject,
    prev_hash:          JByteArray,
    merkle_root:        JByteArray,
    timestamp:          jlong,
    difficulty:         jlong,
    recursion_depth:    jint,
    mempool_pressure:   jdouble,
    cum_work:           jlong,
    max_attempts:       jlong,
    out_nonce:          JLongArray,
    out_residual:       JDoubleArray,
) -> jboolean {
    // ── 1. Copy byte arrays from the JVM heap ─────────────────────────────────
    let prev_bytes = match env.convert_byte_array(&prev_hash) {
        Ok(b) => b,
        Err(_) => return JNI_FALSE,
    };
    let merkle_bytes = match env.convert_byte_array(&merkle_root) {
        Ok(b) => b,
        Err(_) => return JNI_FALSE,
    };

    if prev_bytes.len() < 32 || merkle_bytes.len() < 32 {
        return JNI_FALSE;
    }

    // ── 2. Build header and chain-state structs ───────────────────────────────
    let prev_arr:   [u8; 32] = match prev_bytes[..32].try_into() {
        Ok(a) => a,
        Err(_) => return JNI_FALSE,
    };
    let merkle_arr: [u8; 32] = match merkle_bytes[..32].try_into() {
        Ok(a) => a,
        Err(_) => return JNI_FALSE,
    };

    let header = BlockHeader {
        prev_hash:      prev_arr,
        merkle_root:    merkle_arr,
        timestamp:      timestamp as u64,
        nonce:          0,
        difficulty:     difficulty as u64,
        recursion_depth: recursion_depth as u32,
        residual:       0.0,
    };

    let state = ChainState {
        cumulative_work:  cum_work as u64,
        mempool_pressure,
        validator_count:  1,
        last_quality:     1.0,
        height:           0,
    };

    // ── 3. Run the Lagrangian stationarity solver ─────────────────────────────
    let solver = StationarySolver::new(
        max_attempts as u64,
        1e-8,
        0.01,
        recursion_depth as u32,
    );

    match solver.optimize_full(header, vec![], &state) {
        Some((solution, _)) => {
            // Write nonce back into JVM LongArray[0]
            if env.set_long_array_region(&out_nonce, 0, &[solution.nonce as i64]).is_err() {
                return JNI_FALSE;
            }
            // Write residual back into JVM DoubleArray[0]
            if env.set_double_array_region(&out_residual, 0, &[solution.residual]).is_err() {
                return JNI_FALSE;
            }
            JNI_TRUE
        }
        None => JNI_FALSE,
    }
}
