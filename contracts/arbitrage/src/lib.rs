//! Arbitrage — on-chain executor for cross-pool trades gated by a
//! ModelRegistry-verified model and a set of hard safety rails.
//!
//! This is deliberately narrower than a naive reading of the original design
//! brief (which sketched `execute_arbitrage` running its own ML inference
//! inline): ModelRegistry verifies a *residual claim* about a model, not a
//! committed weight vector, so there is nothing on-chain yet for this
//! contract to run inference against without inventing a second, unrelated
//! commitment scheme. Rather than bolt on a fake "prediction" step with no
//! real cryptographic teeth, this contract's actual safety gate is:
//!   1. an owner-controlled pause switch,
//!   2. the configured model must be Verified in ModelRegistry (checked live
//!      via `call_contract`, not cached), and mature — at least
//!      `arbitrage_model_update_delay` blocks past its verification height,
//!   3. a hard cap on notional traded per call (`arbitrage_max_trade_amount`),
//!   4. a rolling-window circuit breaker: more than `MAX_EXECS_PER_WINDOW`
//!      executions within `arbitrage_window` blocks auto-pauses the
//!      contract until the owner clears it.
//!
//! Trade execution itself is a single atomic host call
//! (`dex_multi_swap`), so there is no reentrancy window between quoting and
//! settling. Note this contract does NOT roll back a swap that clears but
//! undershoots the caller's minimum-profit target — see LIMITATIONS.md.
//!
//! Call ABI: call(methodId, argsPtr, argsLen) -> i32
//!   0 = init(owner: 40 ASCII bytes)                    -> 1 ok, -1 already initialized
//!   1 = set_model(registry: 40 ASCII bytes, modelId: i32)
//!       -> 1 ok, -1 not owner, -2 not initialized
//!   2 = pause()                                        -> 1 ok, -1 not owner
//!   3 = unpause()                                       -> 1 ok, -1 not owner (also clears a tripped circuit breaker)
//!   4 = execute_arbitrage(poolIdsLen: i32, poolIdsBytes: [u8],
//!                          tokenInLen: i32, tokenInBytes: [u8],
//!                          amountIn: i64, minProfitFp: i64)
//!       -> profit (i64 encoded as i32 — see note) on success (>= 0, may be
//!          below minProfitFp; check event log / return value),
//!          -1 paused / circuit breaker tripped
//!          -2 no model configured
//!          -3 model not verified, or not yet past model_update_delay
//!          -4 amountIn exceeds arbitrage_max_trade_amount
//!          -5 swap failed (bad pool chain / insufficient liquidity/funds)
//!          -6 caller is not the contract owner
//!       Profit is logged in full i64 precision via `log()`; the i32 return
//!       value saturates at i32::MAX/MIN for very large profits/losses since
//!       the call ABI's return slot is a single i32 (base-unit profit values
//!       from a single arbitrage leg realistically fit within i32 range, but
//!       the log is the authoritative source of truth for large runs).

#![no_std]
extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use core::slice;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// `#[link(wasm_import_module = "env")]` is required on wasm32-unknown-unknown
// or these are left as unresolved native symbols. `log` is renamed via
// `#[link_name]` to avoid colliding with compiler_builtins' libm `log`.
#[link(wasm_import_module = "env")]
extern "C" {
    fn storage_get(key_ptr: *const u8, key_len: u32, result_ptr: *mut u8) -> u32;
    fn storage_set(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    #[link_name = "log"]
    fn host_log_raw(msg_ptr: *const u8, msg_len: u32);
    fn block_number() -> u32;
    fn caller_address(out_ptr: *mut u8) -> u32;
    fn gov_param(name_ptr: *const u8, name_len: u32) -> i64;
    fn dex_multi_swap(pool_ids_ptr: *const u8, pool_ids_len: u32, token_in_ptr: *const u8, token_in_len: u32, amount_in: i64) -> i64;
    fn call_contract(addr_ptr: *const u8, addr_len: u32, method_id: i32, args_ptr: u32, arg_word_count: u32) -> i32;
}

const READ_BUF_LEN: usize = 256;
// Max executions allowed within one `arbitrage_window` before the circuit
// breaker auto-pauses the contract. Deliberately small: this contract moves
// real escrowed funds, so a runaway or compromised off-chain bot should trip
// it quickly rather than drain the pool.
const MAX_EXECS_PER_WINDOW: i64 = 5;

unsafe fn read_mem_str(ptr: u32, len: u32) -> String {
    let bytes = slice::from_raw_parts(ptr as *const u8, len as usize);
    String::from_utf8_lossy(bytes).into_owned()
}
fn host_log(msg: &str) {
    unsafe { host_log_raw(msg.as_ptr(), msg.len() as u32) }
}
fn host_caller() -> String {
    let mut buf = [0u8; 64];
    let n = unsafe { caller_address(buf.as_mut_ptr()) };
    unsafe { read_mem_str(buf.as_ptr() as u32, n) }
}
fn host_gov_param(name: &str) -> i64 {
    unsafe { gov_param(name.as_ptr(), name.len() as u32) }
}
fn storage_read(key: &str) -> Option<String> {
    let mut buf = [0u8; READ_BUF_LEN];
    let n = unsafe { storage_get(key.as_ptr(), key.len() as u32, buf.as_mut_ptr()) };
    if n == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}
fn storage_write(key: &str, val: &str) {
    unsafe { storage_set(key.as_ptr(), key.len() as u32, val.as_ptr(), val.len() as u32) }
}
fn get_i64(key: &str) -> i64 {
    storage_read(key).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0)
}
fn set_i64(key: &str, val: i64) {
    storage_write(key, &val.to_string());
}

fn read_i64_word(ptr: u32, idx: u32) -> i64 {
    unsafe {
        let base = (ptr as usize + (idx as usize) * 4) as *const i32;
        let lo = core::ptr::read_unaligned(base) as u32;
        let hi = core::ptr::read_unaligned(base.add(1)) as i32;
        ((hi as i64) << 32) | (lo as i64)
    }
}
fn read_i32_word(ptr: u32, idx: u32) -> i32 {
    unsafe { core::ptr::read_unaligned((ptr as usize + (idx as usize) * 4) as *const i32) }
}

fn is_owner(caller: &str) -> bool {
    storage_read("owner").map(|o| o == caller).unwrap_or(false)
}

fn method_init(args_ptr: u32) -> i32 {
    if storage_read("owner").is_some() {
        return -1;
    }
    let owner = unsafe { read_mem_str(args_ptr, 40) };
    storage_write("owner", &owner);
    set_i64("paused", 0);
    host_log(&format!("ArbitrageInitialized owner={}", owner));
    1
}

/// args: [registry: 40 ASCII bytes / 10 words, modelId: i32]
fn method_set_model(args_ptr: u32) -> i32 {
    if storage_read("owner").is_none() {
        return -2;
    }
    let caller = host_caller();
    if !is_owner(&caller) {
        return -1;
    }
    let registry = unsafe { read_mem_str(args_ptr, 40) };
    let model_id = read_i32_word(args_ptr, 10);
    storage_write("registry", &registry);
    set_i64("model_id", model_id as i64);
    host_log(&format!("ModelConfigured registry={} modelId={}", registry, model_id));
    1
}

fn method_pause() -> i32 {
    let caller = host_caller();
    if !is_owner(&caller) {
        return -1;
    }
    set_i64("paused", 1);
    host_log("ArbitragePaused");
    1
}

fn method_unpause() -> i32 {
    let caller = host_caller();
    if !is_owner(&caller) {
        return -1;
    }
    set_i64("paused", 0);
    set_i64("circuit_tripped", 0);
    host_log("ArbitrageUnpaused");
    1
}

/// args: [poolIdsLen, poolIdsBytes..., tokenInLen, tokenInBytes...,
///        amountIn (i64, 2 words), minProfitFp (i64, 2 words)]
fn method_execute(args_ptr: u32) -> i32 {
    // Only the contract owner may trigger execution. This prevents griefing
    // (burning the circuit-breaker window) and unauthorized fund movement.
    // The caller identity is authenticated at the API route layer via Ed25519
    // signature before host_caller() is populated — this check is not theater.
    let caller = host_caller();
    if !is_owner(&caller) {
        return -6;
    }

    if get_i64("paused") != 0 || get_i64("circuit_tripped") != 0 {
        return -1;
    }

    let pool_ids_len = read_i32_word(args_ptr, 0) as u32;
    let pool_ids_ptr = args_ptr + 4;
    let token_in_word = 1 + (pool_ids_len + 3) / 4;
    let token_in_len = read_i32_word(args_ptr, token_in_word) as u32;
    let token_in_ptr = args_ptr + (token_in_word + 1) * 4;
    let amount_word = token_in_word + 1 + (token_in_len + 3) / 4;
    let amount_in = read_i64_word(args_ptr, amount_word);
    let min_profit_fp = read_i64_word(args_ptr, amount_word + 2);

    let registry = match storage_read("registry") {
        None => return -2,
        Some(r) => r,
    };
    let model_id = get_i64("model_id") as i32;

    // Live check against ModelRegistry — not cached, so a slash after
    // set_model() immediately blocks further execution.
    let mut model_args = [model_id, 0i32];
    let verified_at = unsafe {
        call_contract(
            registry.as_ptr(), registry.len() as u32,
            4, // get_verified_at
            model_args.as_mut_ptr() as u32, 1,
        )
    };
    if verified_at < 0 {
        return -3;
    }
    let update_delay = host_gov_param("arbitrageModelUpdateDelay").max(0);
    let now = unsafe { block_number() } as i64;
    if now - (verified_at as i64) < update_delay {
        return -3;
    }

    let max_amount = host_gov_param("arbitrageMaxTradeAmount").max(0);
    if amount_in > max_amount {
        return -4;
    }

    // Rolling-window circuit breaker.
    let window = host_gov_param("arbitrageWindowBlocks").max(1);
    let window_start = get_i64("window_start");
    let mut exec_count = get_i64("exec_count");
    if now - window_start >= window {
        set_i64("window_start", now);
        exec_count = 0;
    }
    exec_count += 1;
    set_i64("exec_count", exec_count);
    if exec_count > MAX_EXECS_PER_WINDOW {
        set_i64("circuit_tripped", 1);
        host_log("CircuitBreakerTripped: too many executions in window, contract auto-paused");
        return -1;
    }

    let amount_out = unsafe {
        dex_multi_swap(
            pool_ids_ptr as *const u8, pool_ids_len,
            token_in_ptr as *const u8, token_in_len,
            amount_in,
        )
    };
    if amount_out < 0 {
        return -5;
    }

    let profit = amount_out - amount_in;
    host_log(&format!(
        "ArbitrageExecuted amountIn={} amountOut={} profit={} minProfitTarget={}",
        amount_in, amount_out, profit, min_profit_fp
    ));
    if profit < min_profit_fp {
        host_log("ArbitrageUnderTarget: trade executed but profit missed target (see LIMITATIONS.md — no rollback)");
    }

    // Saturate to i32 range for the return slot; the log above carries full precision.
    if profit > i32::MAX as i64 {
        i32::MAX
    } else if profit < i32::MIN as i64 {
        i32::MIN
    } else {
        profit as i32
    }
}

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let layout = core::alloc::Layout::from_size_align(size.max(1) as usize, 8).unwrap();
    let ptr = unsafe { alloc::alloc::alloc(layout) };
    ptr as u32
}

#[no_mangle]
pub extern "C" fn call(method_id: i32, args_ptr: u32, _args_len: u32) -> i32 {
    match method_id {
        0 => method_init(args_ptr),
        1 => method_set_model(args_ptr),
        2 => method_pause(),
        3 => method_unpause(),
        4 => method_execute(args_ptr),
        _ => -99,
    }
}
