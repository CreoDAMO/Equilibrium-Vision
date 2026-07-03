use std::slice;
use crate::chain_state::{BlockHeader, ChainState};
use crate::stationary_solver::StationarySolver;

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
    out_residual: *mut f64,
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
        residual: 0.0,
    };

    let state = ChainState {
        cumulative_work: cum_work,
        mempool_pressure,
        validator_count: 1,
        last_quality: 1.0,
        height: 0,
    };

    let solver = StationarySolver::new(max_attempts, 1e-8, 0.01, recursion_depth);
    // Use empty transaction set for simple FFI; production would pass txs too
    if let Some((solution, _)) = solver.optimize_full(header, vec![], &state) {
        *out_nonce = solution.nonce;
        *out_residual = solution.residual;
        true
    } else {
        false
    }
}
