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
    objects::{JByteArray, JLongArray, JObject, JString},
    sys::{jboolean, jdouble, jint, jlong, jstring, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};
use crate::p2p_runtime;

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
///     outResidual:     LongArray    // out: [residual], fixed-point scaled by 10^18
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
    out_residual:       JLongArray,
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
        residual:       0,
        state_root:     [0u8; 32],
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
            // Write residual back into JVM LongArray[0] — fixed-point (scaled by 10^18),
            // never a float, so ARM (mobile) and x86 (cloud) agree bit-for-bit.
            if env.set_long_array_region(&out_residual, 0, &[solution.residual]).is_err() {
                return JNI_FALSE;
            }
            JNI_TRUE
        }
        None => JNI_FALSE,
    }
}

/// Start the in-process mobile swarm. The Android UI supplies the TCP and QUIC
/// listener ports; a zero QUIC port disables QUIC for constrained networks.
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_start(
    _env: JNIEnv,
    _obj: JObject,
    tcp_port: jint,
    quic_port: jint,
) -> jboolean {
    if p2p_runtime::start(tcp_port.max(0) as u16, quic_port.max(0) as u16) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_stop(
    _env: JNIEnv,
    _obj: JObject,
) {
    p2p_runtime::stop();
}

#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_connect(
    mut env: JNIEnv,
    _obj: JObject,
    invite_addr: JString,
) -> jboolean {
    let Ok(addr) = env.get_string(&invite_addr) else { return JNI_FALSE; };
    if p2p_runtime::connect(addr.to_str().unwrap_or_default()) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

/// Publish a solved block hash to all connected peers via Gossipsub.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun gossipBlock(hash: String): Boolean
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_gossipBlock(
    mut env: JNIEnv,
    _obj: JObject,
    hash: JString,
) -> jboolean {
    let Ok(hash_str) = env.get_string(&hash) else { return JNI_FALSE; };
    if p2p_runtime::gossip_block(hash_str.to_str().unwrap_or_default()) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

/// Pop the next inbound block hash from the gossip queue, or an empty string
/// if the queue is empty.  The Android mining loop uses this to learn about
/// competing solutions that arrived while the solver was running.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun pollGossip(): String
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_pollGossip(
    env: JNIEnv,
    _obj: JObject,
) -> jstring {
    let hash = p2p_runtime::poll_gossip().unwrap_or_default();
    env.new_string(&hash)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// Whether the in-process swarm is currently running.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun isRunning(): Boolean
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_isRunning(
    _env: JNIEnv,
    _obj: JObject,
) -> jboolean {
    if p2p_runtime::is_running() { JNI_TRUE } else { JNI_FALSE }
}

/// Return the latest locally-cached chain tip as a JSON string, or an empty
/// string if no tip has been stored yet (i.e. the phone hasn't accepted or
/// received a block since the swarm started).
///
/// MiningWorker calls this before the HTTP fallback so that when peers are
/// reachable the cloud node is not required for tip data.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun fetchTip(): String
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_fetchTip(
    env: JNIEnv,
    _obj: JObject,
) -> jstring {
    let json = p2p_runtime::fetch_tip();
    env.new_string(&json)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// Update the local tip cache after a block is accepted or received from a
/// peer.  Returns JNI_TRUE if the height advanced (tip is newer).
///
/// Kotlin declaration:
/// ```kotlin
/// external fun setLocalTip(height: Long, hash: String, difficulty: Long): Boolean
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_setLocalTip(
    mut env: JNIEnv,
    _obj:    JObject,
    height:     jlong,
    hash:       JString,
    difficulty: jlong,
) -> jboolean {
    let Ok(hash_str) = env.get_string(&hash) else { return JNI_FALSE; };
    if p2p_runtime::set_local_tip(
        height.max(0) as u64,
        hash_str.to_str().unwrap_or_default(),
        difficulty.max(0) as u64,
    ) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}
