use std::slice;
use crate::chain_state::{BlockHeader, ChainState, residual_to_fixed};
use crate::stationary_solver::search_canonical;
use crate::p2p_runtime;

/// Start the embedded dual TCP/QUIC libp2p node. This is intentionally
/// independent from `solve_block`, so mobile hosts can run a light node
/// without an HTTP/Express process.
#[no_mangle]
pub extern "C" fn start_p2p_runtime(listen_tcp: u16, listen_quic: u16) -> bool {
    p2p_runtime::start(listen_tcp, listen_quic)
}

#[no_mangle]
pub extern "C" fn stop_p2p_runtime() {
    p2p_runtime::stop();
}

#[no_mangle]
pub extern "C" fn p2p_runtime_running() -> bool {
    p2p_runtime::is_running()
}

/// Connect to a QR/NFC bootstrap invite's multiaddr.
///
/// # Safety
/// `addr` must point to `len` initialized UTF-8 bytes for the duration of
/// this call.
#[no_mangle]
pub unsafe extern "C" fn connect_p2p_peer(addr: *const u8, len: usize) -> bool {
    if addr.is_null() {
        return false;
    }
    let bytes = slice::from_raw_parts(addr, len);
    let Ok(address) = std::str::from_utf8(bytes) else { return false; };
    p2p_runtime::connect(address)
}

/// # Safety
///
/// - `prev_hash` must be a valid pointer to at least 32 bytes of initialized memory.
/// - `merkle_root` must be a valid pointer to at least 32 bytes of initialized memory.
/// - `out_nonce` and `out_residual` must be valid, non-null, aligned, writable pointers.
/// - All pointers must remain valid for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn solve_block(
    prev_hash: *const u8,
    merkle_root: *const u8,
    timestamp: u64,
    difficulty: u64,
    recursion_depth: u32,
    mempool_pressure: f64,
    cum_work: u64,
    max_attempts: u64,
    out_nonce: *mut u64,
    out_residual: *mut i64,
) -> bool {
    let prev = slice::from_raw_parts(prev_hash, 32);
    let merkle = slice::from_raw_parts(merkle_root, 32);

    let header = BlockHeader {
        prev_hash: prev.try_into().unwrap(),
        merkle_root: merkle.try_into().unwrap(),
        timestamp,
        nonce: 0,
        difficulty,
        recursion_depth,
        residual: 0,
        state_root: [0u8; 32], // default empty root for FFI callers
    };

    let state = ChainState {
        cumulative_work: cum_work,
        mempool_pressure,
        validator_count: 1,
        last_quality: 1.0,
        height: 0,
    };

    let (nonce, residual) = search_canonical(&header, &[], &state, max_attempts.max(1), 2e-3);
    *out_nonce = nonce;
    *out_residual = residual_to_fixed(residual);
    residual.is_finite() && residual >= 0.0 && residual < 2e-3
}
