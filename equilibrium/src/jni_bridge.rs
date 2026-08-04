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

/// Start the swarm and set `EQUILIBRIUM_DATA_DIR` from the supplied Android
/// `filesDir` path in one atomic call.  This ensures the known-peers cache is
/// written to the app's private storage (survives process restarts) rather than
/// relying on the `HOME` environment variable, which is unreliable on Android.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun startWithDataDir(tcpPort: Int, quicPort: Int, dataDir: String): Boolean
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_startWithDataDir(
    mut env: JNIEnv,
    _obj: JObject,
    tcp_port: jint,
    quic_port: jint,
    data_dir: JString,
) -> jboolean {
    if let Ok(dir) = env.get_string(&data_dir) {
        let dir_str = dir.to_str().unwrap_or_default().to_string();
        if !dir_str.is_empty() {
            // Safety: single-threaded before swarm starts; env var is process-wide.
            std::env::set_var("EQUILIBRIUM_DATA_DIR", &dir_str);
        }
    }
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

/// Ask a connected peer for its chain tip via the lightnode RR protocol.
/// Returns a JSON string `{"height":<Long>,"hash":"<hex>","difficulty":<Long>}`,
/// or an empty string if no peer is reachable or the request times out (~5 s).
///
/// MiningWorker calls this as the second tier in the tip priority chain:
///   1. `fetchTip()`           — local cache (instant)
///   2. `queryLightnodeTip()`  — P2P lightnode RR (this)
///   3. HTTP `/api/chain/status` — last resort
///
/// Kotlin declaration:
/// ```kotlin
/// external fun queryLightnodeTip(): String
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_queryLightnodeTip(
    env: JNIEnv,
    _obj: JObject,
) -> jstring {
    let json = p2p_runtime::query_lightnode_tip();
    env.new_string(&json)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// Request a full block body from a connected peer by hash via the sync RR protocol.
/// Also checks the local block ring first to avoid a network round-trip.
/// Returns the block JSON string, or an empty string on failure / timeout.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun querySyncBlock(hash: String): String
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_querySyncBlock(
    mut env: JNIEnv,
    _obj:    JObject,
    hash:    JString,
) -> jstring {
    let Ok(hash_str) = env.get_string(&hash) else {
        return std::ptr::null_mut();
    };
    let json = p2p_runtime::query_sync_block(hash_str.to_str().unwrap_or_default());
    env.new_string(&json)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// Publish a full block body JSON string to connected peers via Gossipsub.
/// Also stores the body in the local block ring so peers can fetch it via sync RR.
/// Returns JNI_TRUE if the body was queued for sending successfully.
///
/// MiningWorker calls this after a successful HTTP block submit so other phones
/// can store the accepted block without needing their own HTTP node.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun gossipBlockBody(bodyJson: String): Boolean
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_gossipBlockBody(
    mut env:   JNIEnv,
    _obj:      JObject,
    body_json: JString,
) -> jboolean {
    let Ok(json_str) = env.get_string(&body_json) else { return JNI_FALSE; };
    if p2p_runtime::gossip_block_body(json_str.to_str().unwrap_or_default()) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

/// Push a block body JSON string into the local ring buffer without gossiping.
/// Call this after accepting a block from any source (HTTP sync, RR fetch) so
/// the phone can serve it to other peers via the sync RR protocol.
///
/// Unlike `gossipBlockBody`, this does NOT publish to Gossipsub — use it when
/// the phone already learned about the block through another channel and only
/// wants to make it available for peer-to-peer sync serving.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun pushBlockBody(bodyJson: String)
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_pushBlockBody(
    mut env:   JNIEnv,
    _obj:      JObject,
    body_json: JString,
) {
    let Ok(json_str) = env.get_string(&body_json) else { return; };
    p2p_runtime::push_block_body(json_str.to_str().unwrap_or_default());
}

/// Return the number of currently established peer connections.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun getConnectedPeerCount(): Int
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_getConnectedPeerCount(
    _env: JNIEnv,
    _obj: JObject,
) -> jint {
    p2p_runtime::get_connected_peer_count() as jint
}

/// Ask a connected peer for a range of block bodies via the sync RR protocol.
/// Returns a JSON string `{"blocks":[...]}` containing all available blocks
/// in the height range [fromHeight, toHeight], or an empty string on failure.
///
/// MiningWorker can call this during initial sync to fill the local block ring
/// from a peer without requiring HTTP access to the API server.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun querySyncBlocks(fromHeight: Long, toHeight: Long): String
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_querySyncBlocks(
    env:         JNIEnv,
    _obj:        JObject,
    from_height: jlong,
    to_height:   jlong,
) -> jstring {
    let json = p2p_runtime::query_sync_blocks(
        from_height.max(0) as u64,
        to_height.max(0) as u64,
    );
    env.new_string(&json)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

// ── Mobile Validator JNI bridge ─────────────────────────────────────────────
//
// Exposes com.equilibrium.P2PNode.startValidator / submitBlockForValidation /
// getValidationResult / shouldValidateNow / stopValidator to the JVM.
//
// These make the "fully mobile blockchain" claim real: phones are full
// validators that independently verify residuals, Merkle roots, timestamps,
// and signatures — not light clients that blindly trust gossip.

use std::sync::OnceLock;
use crate::mobile_validator::{MobileValidator, ValidationResult};

/// Global validator instance. Initialized on first startValidator() call.
static VALIDATOR: OnceLock<MobileValidator> = OnceLock::new();

/// Start the background mobile validation thread.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun startValidator(): Boolean
/// ```
/// Returns true if the validator was started (or was already running).
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_startValidator(
    _env: JNIEnv,
    _obj: JObject,
) -> jboolean {
    if VALIDATOR.get().is_some() {
        return JNI_TRUE; // Already running — idempotent
    }
    let validator = MobileValidator::start();
    match VALIDATOR.set(validator) {
        Ok(_) => JNI_TRUE,
        Err(_) => JNI_TRUE, // Race — another thread beat us, still running
    }
}

/// Stop the background mobile validation thread.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun stopValidator(): Boolean
/// ```
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_stopValidator(
    _env: JNIEnv,
    _obj: JObject,
) -> jboolean {
    if let Some(v) = VALIDATOR.get() {
        v.shutdown();
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

/// Submit a block JSON string for background validation (fire-and-forget).
///
/// Kotlin declaration:
/// ```kotlin
/// external fun submitBlockForValidation(blockJson: String, fromPeer: Boolean): Boolean
/// ```
///
/// The block is asynchronously:
///   1. Parsed from JSON into a GossipedBlock
///   2. Chain-continuity checked (prev_hash, height)
///   3. Timestamp-sanity checked (±2 hours)
///   4. Lagrangian residual re-verified via StationarySolver
///   5. Merkle root recomputed from tx hashes
///
/// Use getValidationResult() to poll for the outcome.
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_submitBlockForValidation(
    mut env: JNIEnv,
    _obj: JObject,
    block_json: JString,
    from_peer: jboolean,
) -> jboolean {
    let Ok(json_str) = env.get_string(&block_json) else {
        return JNI_FALSE;
    };
    let Some(validator) = VALIDATOR.get() else {
        return JNI_FALSE;
    };
    validator.submit_json(json_str.to_string_lossy().to_string(), from_peer == JNI_TRUE);
    JNI_TRUE
}

/// Poll for the most recent validation result.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun getValidationResult(): String
/// ```
///
/// Returns a JSON string:
/// ```json
/// {"status":"accept","hash":"abc...","height":123}
/// {"status":"reject","hash":"abc...","reason":"residual mismatch","banPeer":true}
/// {"status":"deferred","hash":"abc...","reason":"battery low","banPeer":false}
/// ```
/// Returns an empty string if no validation has completed yet (polling API).
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_getValidationResult(
    env: JNIEnv,
    _obj: JObject,
) -> jstring {
    let Some(validator) = VALIDATOR.get() else {
        return env.new_string("").map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut());
    };

    let json = match validator.poll_result() {
        Some(ValidationResult::Accept { hash, height }) => {
            format!(r#"{{"status":"accept","hash":"{}","height":{}}}"#, hash, height)
        }
        Some(ValidationResult::Reject { hash, reason, ban_peer }) => {
            format!(
                r#"{{"status":"reject","hash":"{}","reason":"{}","banPeer":{}}}"#,
                hash, reason.replace('"', "'"), ban_peer
            )
        }
        Some(ValidationResult::Deferred { hash, reason }) => {
            format!(
                r#"{{"status":"deferred","hash":"{}","reason":"{}","banPeer":false}}"#,
                hash, reason.replace('"', "'")
            )
        }
        None => String::new(),
    };

    env.new_string(&json)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// Check whether device conditions allow validation right now.
///
/// Kotlin declaration:
/// ```kotlin
/// external fun shouldValidateNow(): Boolean
/// ```
///
/// Returns true if the device is charging OR battery > 50% at nominal thermals.
/// The Rust side always returns true; the actual battery/thermal gate lives in
/// Kotlin (ThermalGuard.kt) which decides whether to call submitBlockForValidation.
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_shouldValidateNow(
    _env: JNIEnv,
    _obj: JObject,
) -> jboolean {
    // Thermal/battery check is delegated to Kotlin — see ThermalGuard.kt.
    JNI_TRUE
}
