//! ModelRegistry — on-chain optimistic oracle for verified ML models.
//!
//! Lifecycle (per model):
//!   Proposed (0) --[challenge window elapses, no successful challenge]--> Verified (1)
//!   Proposed (0) --[challenge() proves the residual claim false]-------> Slashed (2)
//!
//! Design notes (deliberately simpler than a naive reading of the original
//! design brief, which sketched a mid-flight commit/reveal scheme with
//! `static mut` counters and placeholder proposer strings — neither of which
//! is a real contract implementation):
//!   - `propose()` commits to a SHA-256 hash of the support set rather than
//!     posting the (potentially large) raw data on-chain — the full data is
//!     only required later, when a challenger disputes the claim.
//!   - `verify_model()` is a permissionless, argument-free "finalize" call:
//!     once the challenge window has elapsed with no successful challenge,
//!     anyone can flip the model to Verified. This is the standard
//!     optimistic-oracle pattern and needs no re-computation in the honest
//!     path — verification cost is only paid when a claim is actually
//!     disputed.
//!   - `challenge()` requires the disputer to reveal support data that
//!     hashes to the committed value, bonds their own stake, and forwards
//!     the claim to the `verify_residual` host import (which shells out to
//!     the deterministic `variational-ai-cli` solver). A false claim slashes
//!     the proposer's bond and rewards the challenger from the slashed
//!     amount; a defended claim forfeits the challenger's bond instead.
//!   - Bonds are real EQU, escrowed via the `bond`/`payout` host imports
//!     (contract's own address acts as the escrow account) — not simulated
//!     bookkeeping, so a slash has real economic weight.
//!
//! Call ABI: call(methodId, argsPtr, argsLen) -> i32
//!   0 = propose(residualFp: i64, supportHash: [u8;32], inputDim: i32,
//!               hiddenDim: i32, lambdaFp: i32, seed: i32, uriLen: i32,
//!               uriBytes: [u8; uriLen])
//!       -> model id (>= 0), or:
//!          -1 insufficient balance for minimum_bond
//!          -2 proposer already at max_models_per_proposer
//!          -3 uri too long (> 256 bytes)
//!   1 = verify_model(modelId: i32)
//!       -> 1 verified (now or already), 0 slashed/invalid,
//!          -1 unknown model, -2 challenge window still open
//!   2 = challenge(modelId: i32, nSupport: i32,
//!                 supportDataFp: [i64; nSupport * inputDim],
//!                 supportLabelsFp: [i64; nSupport],
//!                 tolFp: i32 /* 0 = solver default */,
//!                 maxIter: i32 /* 0 = solver default */)
//!       -> 2 challenge succeeded, model slashed
//!          1 challenge failed, model unaffected, challenger bond forfeited
//!          -1 unknown model     -2 not in Proposed state
//!          -3 challenge window closed
//!          -4 support data does not match the committed hash
//!          -5 insufficient balance for challenge_bond
//!   3 = get_model_status(modelId: i32)
//!       -> 0 proposed, 1 verified, 2 slashed, -1 unknown
//!   4 = get_verified_at(modelId: i32)
//!       -> block height verified at (>= 0), -1 unknown model, -2 not verified
//!          (used by other contracts via call_contract, e.g. Arbitrage's
//!          model_update_delay maturity check)
//!   5 = submit_inference_attestation(modelId: i32, inputHash: [u8;32],
//!                 outputHash: [u8;32], sig: [u8;64], pubkey: [u8;32],
//!                 attestorAddrLen: i32 /* must be 40 */, attestorAddr: [u8;40])
//!       -> 1 attestation recorded, -1 unknown model, -2 invalid signature,
//!          -3 attestorAddrLen != 40
//!
//!       This is deliberately an Ed25519-attested inference *receipt*, not a
//!       zero-knowledge proof of correct computation. It verifies (via the
//!       same `verify_owner_sig` host import the multisig contract uses —
//!       no new crypto primitive) that whoever holds the attestor keypair
//!       signed this exact (input_hash, output_hash, model_id) triple. It
//!       does NOT prove the output was actually produced by running the
//!       registered model. A real zkML verifier (Groth16 over a per-model
//!       inference circuit, à la the original ERC-7992 / DeepProve draft)
//!       would need a witness generator per model architecture, which is a
//!       substantial separate effort with no existing circuit in this repo
//!       — see LIMITATIONS.md. This method instead extends the registry's
//!       existing optimistic-oracle philosophy (bond-and-challenge for
//!       training claims) to inference claims: an attestation is evidence a
//!       disputer or off-chain reputation system can act on, not an
//!       unconditional cryptographic guarantee.
//!   6 = get_inference_status(modelId: i32)
//!       -> 1 attested, 0 no attestation yet, -1 unknown model
//!   7 = get_capabilities(_unused: i32)
//!       -> bitmask: bit0 (1) = training oracle (propose/verify/challenge),
//!          bit1 (2) = inference attestation. A numeric capability bitmask
//!          fits this contract's flat method-id ABI far better than porting
//!          Solidity's EIP-165 `supportsInterface(bytes4)` string-hash
//!          scheme, which has no natural equivalent here.
//!
//! Full model fields are readable off-chain via the flat KV storage exposed
//! by GET /api/contracts/:address/storage — see `model_*` keys below —
//! rather than through a WASM return value (a fresh WASM instance/memory is
//! created per call, so there is nowhere for a caller to read a complex
//! result from after the call returns).

#![no_std]
extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::slice;
use sha2::{Digest, Sha256};

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── global allocator ──────────────────────────────────────────────────────────
// Required for `extern crate alloc` on wasm32-unknown-unknown (Rust ≥ 1.73
// removed the implicit dlmalloc allocator from the target's std libs).
// WASM is single-threaded, so UnsafeCell + Sync is sound.
mod bump_alloc {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    struct Bump { buf: UnsafeCell<[u8; 65536]>, pos: UnsafeCell<usize> }
    unsafe impl Sync for Bump {}
    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let pos = &mut *self.pos.get();
            let start = (*pos + layout.align() - 1) & !(layout.align() - 1);
            if start + layout.size() > 65536 { return core::ptr::null_mut(); }
            *pos = start + layout.size();
            (*self.buf.get()).as_mut_ptr().add(start)
        }
        unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
    }
    #[global_allocator]
    pub static ALLOC: Bump = Bump {
        buf: UnsafeCell::new([0u8; 65536]),
        pos: UnsafeCell::new(0),
    };
}

// ── host imports (module "env", matching artifacts/api-server/src/chain/wasm.ts) ──
// `#[link(wasm_import_module = "env")]` is required on wasm32-unknown-unknown —
// without it these are left as unresolved native symbols instead of wasm
// imports. The host's `log` import is renamed on the Rust side (`host_log_raw`)
// via `#[link_name]` because `log` collides with compiler_builtins' libm
// `log` (natural logarithm) intrinsic and silently corrupts codegen otherwise.
#[link(wasm_import_module = "env")]
extern "C" {
    fn storage_get(key_ptr: *const u8, key_len: u32, result_ptr: *mut u8) -> u32;
    fn storage_set(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    #[link_name = "log"]
    fn host_log_raw(msg_ptr: *const u8, msg_len: u32);
    fn block_number() -> u32;
    fn caller_address(out_ptr: *mut u8) -> u32;
    fn bond(amount: i64) -> i32;
    fn payout(to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
    fn gov_param(name_ptr: *const u8, name_len: u32) -> i64;
    fn verify_residual(req_ptr: *const u8, req_len: u32) -> i32;
    fn verify_owner_sig(
        msg_ptr: *const u8, msg_len: u32,
        sig_ptr: *const u8, sig_len: u32,
        pubkey_ptr: *const u8, pubkey_len: u32,
        addr_ptr: *const u8, addr_len: u32,
    ) -> i32;
}

// Generous scratch buffer for storage_get reads — every value this contract
// stores (hex hashes, decimal numbers, short URIs, addresses) fits well
// within this.
const READ_BUF_LEN: usize = 1024;

// ── low-level helpers ───────────────────────────────────────────────────────

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

// ── i64 fixed-point helpers ─────────────────────────────────────────────────

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

// ── model id / storage key helpers ──────────────────────────────────────────

fn next_model_id() -> i64 {
    let id = get_i64("meta_next_id");
    set_i64("meta_next_id", id + 1);
    id
}

fn key(prefix: &str, id: i64) -> String {
    format!("{}:{}", prefix, id)
}

const STATUS_PROPOSED: i64 = 0;
const STATUS_VERIFIED: i64 = 1;
const STATUS_SLASHED: i64 = 2;

// ── methods ──────────────────────────────────────────────────────────────────

/// args: [residualFp_lo, residualFp_hi, supportHash x8, inputDim, hiddenDim,
///        lambdaFp, seed, uriLen, uriBytes...]
fn method_propose(args_ptr: u32) -> i32 {
    let claimed_residual_fp = read_i64_word(args_ptr, 0);
    let support_hash_words: Vec<i32> = (2..10).map(|i| read_i32_word(args_ptr, i)).collect();
    let mut support_hash = [0u8; 32];
    for (i, w) in support_hash_words.iter().enumerate() {
        support_hash[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    let input_dim = read_i32_word(args_ptr, 10);
    let hidden_dim = read_i32_word(args_ptr, 11);
    let lambda_fp = read_i32_word(args_ptr, 12);
    let seed = read_i32_word(args_ptr, 13);
    let uri_len = read_i32_word(args_ptr, 14) as u32;

    const MAX_URI_LEN: u32 = 256;
    if uri_len > MAX_URI_LEN {
        return -3;
    }
    let uri_ptr = args_ptr + 15 * 4;
    let uri = unsafe { read_mem_str(uri_ptr, uri_len) };

    let proposer = host_caller();
    let max_models = host_gov_param("modelRegistryMaxModelsPerProposer").max(1);
    let count_key = format!("proposer_count:{}", proposer);
    let count = get_i64(&count_key);
    if count >= max_models {
        return -2;
    }

    let minimum_bond = host_gov_param("modelRegistryMinimumBond").max(0);
    if unsafe { bond(minimum_bond) } != 1 {
        return -1;
    }

    let id = next_model_id();
    set_i64(&key("model_status", id), STATUS_PROPOSED);
    set_i64(&key("model_residual_fp", id), claimed_residual_fp);
    set_i64(&key("model_input_dim", id), input_dim as i64);
    set_i64(&key("model_hidden_dim", id), hidden_dim as i64);
    set_i64(&key("model_lambda_fp", id), lambda_fp as i64);
    set_i64(&key("model_seed", id), seed as i64);
    set_i64(&key("model_proposed_at", id), unsafe { block_number() } as i64);
    set_i64(&key("model_bond", id), minimum_bond);
    storage_write(&key("model_support_hash", id), &hex_encode(&support_hash));
    storage_write(&key("model_uri", id), &uri);
    storage_write(&key("model_proposer", id), &proposer);
    set_i64(&count_key, count + 1);

    host_log(&format!("ModelProposed id={} proposer={} bond={}", id, proposer, minimum_bond));
    id as i32
}

fn method_verify_model(args_ptr: u32) -> i32 {
    let id = read_i32_word(args_ptr, 0) as i64;
    let status_key = key("model_status", id);
    let status = match storage_read(&status_key) {
        None => return -1,
        Some(s) => s.parse::<i64>().unwrap_or(-1),
    };
    if status == STATUS_VERIFIED {
        return 1;
    }
    if status == STATUS_SLASHED {
        return 0;
    }
    let proposed_at = get_i64(&key("model_proposed_at", id));
    let challenge_period = host_gov_param("modelRegistryChallengePeriod").max(1);
    let now = unsafe { block_number() } as i64;
    if now - proposed_at < challenge_period {
        return -2;
    }
    set_i64(&status_key, STATUS_VERIFIED);
    set_i64(&key("model_verified_at", id), now);
    host_log(&format!("ModelVerified id={}", id));
    1
}

/// Returns the block height at which `modelId` was verified, or a negative
/// sentinel if it doesn't exist / isn't verified yet. Used by other
/// contracts (e.g. Arbitrage) via `call_contract` to gate on model maturity
/// without needing to read this contract's raw KV storage.
fn method_get_verified_at(args_ptr: u32) -> i32 {
    let id = read_i32_word(args_ptr, 0) as i64;
    match storage_read(&key("model_status", id)) {
        None => -1,
        Some(s) if s.parse::<i64>().unwrap_or(-1) != STATUS_VERIFIED => -2,
        _ => get_i64(&key("model_verified_at", id)) as i32,
    }
}

/// args: [modelId, nSupport, supportDataFp x (nSupport*inputDim*2 words),
///        supportLabelsFp x (nSupport*2 words), tolFp, maxIter]
fn method_challenge(args_ptr: u32) -> i32 {
    let id = read_i32_word(args_ptr, 0) as i64;
    let n_support = read_i32_word(args_ptr, 1);
    if n_support <= 0 {
        return -4;
    }

    let status_key = key("model_status", id);
    let status = match storage_read(&status_key) {
        None => return -1,
        Some(s) => s.parse::<i64>().unwrap_or(-1),
    };
    if status != STATUS_PROPOSED {
        return -2;
    }
    let proposed_at = get_i64(&key("model_proposed_at", id));
    let challenge_period = host_gov_param("modelRegistryChallengePeriod").max(1);
    let now = unsafe { block_number() } as i64;
    if now - proposed_at >= challenge_period {
        return -3;
    }

    let input_dim = get_i64(&key("model_input_dim", id)) as usize;
    let n = n_support as usize;
    let data_words_base = 2u32; // after modelId, nSupport
    let n_data_words = (n * input_dim * 2) as u32;
    let labels_words_base = data_words_base + n_data_words;
    let n_label_words = (n * 2) as u32;
    let tol_word = labels_words_base + n_label_words;
    let max_iter_word = tol_word + 1;

    // Reconstruct support data / labels as f64 (fixed-point ×1e6 on the wire)
    // and verify the committed hash over the raw fixed-point bytes (so the
    // commitment is exact / integer, not float-comparison-fragile).
    let mut hasher = Sha256::new();
    let mut support_data: Vec<f64> = Vec::with_capacity(n * input_dim);
    for i in 0..(n * input_dim) as u32 {
        let fp = read_i64_word(args_ptr, data_words_base + i * 2);
        hasher.update(fp.to_le_bytes());
        support_data.push(fp as f64 / 1_000_000.0);
    }
    let mut support_labels: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n as u32 {
        let fp = read_i64_word(args_ptr, labels_words_base + i * 2);
        hasher.update(fp.to_le_bytes());
        support_labels.push(fp as f64 / 1_000_000.0);
    }
    let computed_hash = hasher.finalize();
    let stored_hash = storage_read(&key("model_support_hash", id)).unwrap_or_default();
    if hex_encode(&computed_hash) != stored_hash {
        return -4;
    }

    let challenger = host_caller();
    let challenge_bond = host_gov_param("modelRegistryChallengeBond").max(0);
    if unsafe { bond(challenge_bond) } != 1 {
        return -5;
    }

    let tol_fp = read_i32_word(args_ptr, tol_word);
    let max_iter = read_i32_word(args_ptr, max_iter_word);
    let hidden_dim = get_i64(&key("model_hidden_dim", id));
    let lambda_fp = get_i64(&key("model_lambda_fp", id));
    let seed = get_i64(&key("model_seed", id));
    let claimed_residual_fp = get_i64(&key("model_residual_fp", id));
    let epsilon = host_gov_param("modelRegistryResidualEpsilonScaled").max(0);

    let mut req = String::new();
    req.push_str("{\"support_data\":[");
    for (i, v) in support_data.iter().enumerate() {
        if i > 0 {
            req.push(',');
        }
        req.push_str(&format!("{}", v));
    }
    req.push_str("],\"support_labels\":[");
    for (i, v) in support_labels.iter().enumerate() {
        if i > 0 {
            req.push(',');
        }
        req.push_str(&format!("{}", v));
    }
    req.push_str(&format!(
        "],\"input_dim\":{},\"hidden_dim\":{},\"lambda\":{},\"seed\":{},\"claimed_residual\":{},\"epsilon\":{}",
        input_dim,
        hidden_dim,
        lambda_fp as f64 / 1_000_000.0,
        seed,
        claimed_residual_fp,
        epsilon,
    ));
    if tol_fp > 0 {
        req.push_str(&format!(",\"tol\":{}", tol_fp as f64 / 1_000_000.0));
    }
    if max_iter > 0 {
        req.push_str(&format!(",\"max_iter\":{}", max_iter));
    }
    req.push('}');

    let valid = unsafe { verify_residual(req.as_ptr(), req.len() as u32) } == 1;
    let proposer_bond = get_i64(&key("model_bond", id));

    if !valid {
        // Successful challenge: slash the proposer's bond, reward the
        // challenger from the slashed amount, refund the challenger's own
        // bond, and mark the model invalid.
        set_i64(&status_key, STATUS_SLASHED);
        let slashing_fraction_bp = host_gov_param("modelRegistrySlashingFractionBp").max(0);
        let reward_fraction_bp = host_gov_param("modelRegistryChallengerRewardFractionBp").max(0);
        let slashed = proposer_bond * slashing_fraction_bp / 10_000;
        let reward = slashed * reward_fraction_bp / 10_000;
        if reward > 0 {
            unsafe { payout(challenger.as_ptr(), challenger.len() as u32, reward) };
        }
        unsafe { payout(challenger.as_ptr(), challenger.len() as u32, challenge_bond) };
        host_log(&format!("ModelSlashed id={} challenger={} reward={}", id, challenger, reward));
        2
    } else {
        // Challenge failed: challenger's bond is forfeited to the contract
        // (kept as protocol reserve / compensation for the wasted
        // verification work), model remains Proposed and can still be
        // finalized once the window elapses.
        host_log(&format!("ChallengeFailed id={} challenger={}", id, challenger));
        1
    }
}

fn method_get_status(args_ptr: u32) -> i32 {
    let id = read_i32_word(args_ptr, 0) as i64;
    match storage_read(&key("model_status", id)) {
        None => -1,
        Some(s) => s.parse::<i64>().unwrap_or(-1) as i32,
    }
}

const CAP_TRAINING_ORACLE: i32 = 1;
const CAP_INFERENCE_ATTESTATION: i32 = 2;

/// args: [modelId, inputHash x8 words (32 bytes), outputHash x8 words
///        (32 bytes), sig x16 words (64 bytes), pubkey x8 words (32 bytes),
///        attestorAddrLen, attestorAddrBytes x 10 words (40 ASCII chars)]
///
/// See the module doc comment (method 5) for what this does and does not
/// prove. The signed message is inputHash || outputHash || modelId (i32 LE)
/// — binding the attestation to a specific model prevents replaying the
/// same signed receipt against a different modelId.
fn method_submit_inference_attestation(args_ptr: u32) -> i32 {
    let id = read_i32_word(args_ptr, 0) as i64;
    if storage_read(&key("model_status", id)).is_none() {
        return -1;
    }

    let mut input_hash = [0u8; 32];
    for i in 0..8u32 {
        let w = read_i32_word(args_ptr, 1 + i);
        input_hash[(i * 4) as usize..(i * 4 + 4) as usize].copy_from_slice(&w.to_le_bytes());
    }
    let mut output_hash = [0u8; 32];
    for i in 0..8u32 {
        let w = read_i32_word(args_ptr, 9 + i);
        output_hash[(i * 4) as usize..(i * 4 + 4) as usize].copy_from_slice(&w.to_le_bytes());
    }
    let mut sig = [0u8; 64];
    for i in 0..16u32 {
        let w = read_i32_word(args_ptr, 17 + i);
        sig[(i * 4) as usize..(i * 4 + 4) as usize].copy_from_slice(&w.to_le_bytes());
    }
    let mut pubkey = [0u8; 32];
    for i in 0..8u32 {
        let w = read_i32_word(args_ptr, 33 + i);
        pubkey[(i * 4) as usize..(i * 4 + 4) as usize].copy_from_slice(&w.to_le_bytes());
    }
    let addr_len = read_i32_word(args_ptr, 41) as u32;
    if addr_len != 40 {
        return -3;
    }
    let attestor_addr = unsafe { read_mem_str(args_ptr + 42 * 4, addr_len) };

    let mut msg = [0u8; 68];
    msg[0..32].copy_from_slice(&input_hash);
    msg[32..64].copy_from_slice(&output_hash);
    msg[64..68].copy_from_slice(&(id as i32).to_le_bytes());

    let valid = unsafe {
        verify_owner_sig(
            msg.as_ptr(), msg.len() as u32,
            sig.as_ptr(), sig.len() as u32,
            pubkey.as_ptr(), pubkey.len() as u32,
            attestor_addr.as_ptr(), attestor_addr.len() as u32,
        )
    } == 1;
    if !valid {
        return -2;
    }

    storage_write(&key("model_inference_input", id), &hex_encode(&input_hash));
    storage_write(&key("model_inference_output", id), &hex_encode(&output_hash));
    storage_write(&key("model_inference_attestor", id), &attestor_addr);
    set_i64(&key("model_inference_at", id), unsafe { block_number() } as i64);
    host_log(&format!("InferenceAttested id={} attestor={}", id, attestor_addr));
    1
}

fn method_get_inference_status(args_ptr: u32) -> i32 {
    let id = read_i32_word(args_ptr, 0) as i64;
    if storage_read(&key("model_status", id)).is_none() {
        return -1;
    }
    match storage_read(&key("model_inference_attestor", id)) {
        Some(_) => 1,
        None => 0,
    }
}

fn method_get_capabilities(_args_ptr: u32) -> i32 {
    CAP_TRAINING_ORACLE | CAP_INFERENCE_ATTESTATION
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

// ── exports ──────────────────────────────────────────────────────────────────

/// Bump-allocates `size` bytes for the host to write incoming call args into.
/// Leaked intentionally: each call runs in a fresh WASM instance/memory
/// (see WasmVM.execCall), so there's nothing to free.
#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let layout = core::alloc::Layout::from_size_align(size.max(1) as usize, 8).unwrap();
    let ptr = unsafe { alloc::alloc::alloc(layout) };
    ptr as u32
}

#[no_mangle]
pub extern "C" fn call(method_id: i32, args_ptr: u32, _args_len: u32) -> i32 {
    match method_id {
        0 => method_propose(args_ptr),
        1 => method_verify_model(args_ptr),
        2 => method_challenge(args_ptr),
        3 => method_get_status(args_ptr),
        4 => method_get_verified_at(args_ptr),
        5 => method_submit_inference_attestation(args_ptr),
        6 => method_get_inference_status(args_ptr),
        7 => method_get_capabilities(args_ptr),
        _ => -99,
    }
}
