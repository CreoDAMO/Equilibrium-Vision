//! CrossChainRelay — Federated Cross-Chain Attestation Protocol.
//!
//! Trust model: m-of-n bonded relayers. Each relayer stakes EQU to join the
//! set. Inbound attestations require `threshold` distinct relayer signatures
//! over the canonical message `attest:{chain_id}:{seq}:{commitment_hex}`.
//! Fraudulent attestations can be challenged by admin; if upheld, each signer
//! is slashed a governance-controlled fraction of their bond, with a portion
//! going to the challenger.
//!
//! This is deliberately NOT IBC — it is a federated bridge with distributed
//! economic security. It requires trusting the relayer set rather than a
//! light-client proof. See LIMITATIONS.md for a full comparison.
//!
//! Call ABI: call(methodId, argsPtr, argsLen) -> i32
//!
//!   0 = register_relayer(amount_lo: i32, amount_hi: i32)
//!       Caller bonds `amount` EQU into the contract escrow and joins the
//!       relayer set. Called by the relayer themselves.
//!       -> 1 ok, 0 below min bond, -1 already registered, -2 bond failed
//!
//!   1 = revoke_relayer(addr_words x10)
//!       Remove a relayer and return their bond. Admin-protected at route level.
//!       -> 1 ok, 0 not found
//!
//!   2 = set_threshold(m: i32)
//!       Set the m-of-n threshold. Admin-protected at route level.
//!       -> 1 ok, 0 invalid (zero or exceeds relayer count)
//!
//!   3 = submit_inbound_attestation(
//!         chain_id_len: i32, chain_id_bytes: [u8; chain_id_len] (packed 4/word),
//!         seq_lo: i32, seq_hi: i32,
//!         commitment: [u8; 32] (8 words),
//!         n_sigs: i32,
//!         [sig: [u8; 64] (16 words), pubkey: [u8; 32] (8 words),
//!          addr: [u8; 40] (10 words)] × n_sigs)
//!       Verify m-of-n signatures and record the inbound attestation.
//!       -> 1 ok
//!          -1 unknown chain_id (empty)   -2 invalid signature
//!          -3 no signatures provided     -4 bad sequence number
//!          -5 already attested           -6 no relayers registered
//!          -7 signer not a relayer       -8 duplicate signer
//!          -9 threshold not met
//!
//!   4 = challenge_inbound(chain_id_len, chain_id_bytes, seq_lo, seq_hi)
//!       Mark an attestation as challenged and slash all signers.
//!       Admin-protected at route level.
//!       -> 1 ok, -1 not found, -2 already finalized, -3 already challenged
//!
//!   5 = finalize_inbound(chain_id_len, chain_id_bytes, seq_lo, seq_hi)
//!       Mark an attestation as finalized after the challenge window passes.
//!       Permissionless — anyone can call once the window elapses.
//!       -> 1 ok, -1 not found, -2 already finalized, -3 window still open
//!
//!   6 = publish_outbound(chain_id_len, chain_id_bytes, commitment x8)
//!       Record an outbound commitment (a local event to share cross-chain).
//!       -> outbound seq (>= 1), 0 on error
//!
//!   7 = get_inbound_status(chain_id_len, chain_id_bytes, seq_lo, seq_hi)
//!       -> 0 pending, 1 finalized, 2 challenged, -1 not found
//!
//!   8 = get_outbound_seq(chain_id_len, chain_id_bytes)
//!       -> current outbound sequence for that chain (0 if none published)
//!
//!   9  = get_threshold()  -> current threshold value (default 2)
//!   10 = get_relayer_count() -> number of registered relayers

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
#[link(wasm_import_module = "env")]
extern "C" {
    fn storage_get(key_ptr: *const u8, key_len: u32, result_ptr: *mut u8) -> u32;
    fn storage_set(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    #[link_name = "log"]
    fn host_log_raw(msg_ptr: *const u8, msg_len: u32);
    fn block_number() -> u32;
    fn caller_address(out_ptr: *mut u8) -> u32;
    fn gov_param(name_ptr: *const u8, name_len: u32) -> i64;
    fn bond(amount: i64) -> i32;
    fn payout(to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
    fn verify_owner_sig(
        msg_ptr: *const u8, msg_len: u32,
        sig_ptr: *const u8, sig_len: u32,
        pubkey_ptr: *const u8, pubkey_len: u32,
        addr_ptr: *const u8, addr_len: u32,
    ) -> i32;
}

const READ_BUF_LEN: usize = 2048;

// ── low-level helpers ────────────────────────────────────────────────────────

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
    if n == 0 { return None; }
    Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

fn storage_write(key: &str, val: &str) {
    unsafe { storage_set(key.as_ptr(), key.len() as u32, val.as_ptr(), val.len() as u32) }
}

fn get_i64(key: &str) -> i64 {
    storage_read(key).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0)
}
fn set_i64(key: &str, val: i64) { storage_write(key, &val.to_string()); }

fn get_u64(key: &str) -> u64 {
    storage_read(key).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0)
}
fn set_u64(key: &str, val: u64) { storage_write(key, &val.to_string()); }

// ── arg reading helpers ──────────────────────────────────────────────────────
// Args are passed as i32 words: 4 bytes per word, little-endian, packed.
// All byte data (strings, byte arrays) occupies ceil(len/4) words.

fn read_i32_word(args_ptr: u32, idx: u32) -> i32 {
    unsafe { core::ptr::read_unaligned((args_ptr as usize + (idx as usize) * 4) as *const i32) }
}

/// Read `byte_len` raw bytes starting at word offset `word_off` in the args buffer.
unsafe fn read_bytes_at(args_ptr: u32, word_off: u32, byte_len: usize) -> &'static [u8] {
    let ptr = (args_ptr as usize + (word_off as usize) * 4) as *const u8;
    slice::from_raw_parts(ptr, byte_len)
}

/// Read a UTF-8 string of `byte_len` bytes starting at word offset `word_off`.
fn read_str_at(args_ptr: u32, word_off: u32, byte_len: u32) -> String {
    if byte_len == 0 { return String::new(); }
    unsafe { read_mem_str(args_ptr + word_off * 4, byte_len) }
}

/// Words needed to hold `byte_len` bytes (packed 4 per word).
fn words_for(byte_len: u32) -> u32 {
    (byte_len + 3) / 4
}

// ── hex helpers ──────────────────────────────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn sha256_str(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}

// ── governance parameters ────────────────────────────────────────────────────

fn relay_min_bond() -> i64 {
    let v = host_gov_param("relayerMinBond");
    // Default 1_000_000_000 (1B base units) — calibrated to chain's integer scale
    // where genesis allocations are O(10^7) and test accounts are funded to O(10^9–10^10).
    if v <= 0 { 1_000_000_000 } else { v }
}

fn relay_slash_bp() -> i64 {
    let v = host_gov_param("relayerSlashBp");
    if v <= 0 { 2000 } else { v } // 20% default (basis points)
}

fn relay_challenger_reward_bp() -> i64 {
    let v = host_gov_param("relayerChallengerRewardBp");
    if v <= 0 { 5000 } else { v } // 50% of slashed default
}

fn challenge_window() -> u64 {
    let v = host_gov_param("relayerChallengeWindow");
    if v <= 0 { 100 } else { v as u64 }
}

// ── relayer set storage ──────────────────────────────────────────────────────

fn get_relayer_set() -> Vec<String> {
    let val = storage_read("relay:set").unwrap_or_default();
    if val.is_empty() {
        return Vec::new();
    }
    val.split(',').filter(|a| !a.is_empty()).map(|a| a.to_string()).collect()
}

fn set_relayer_set(relayers: &[String]) {
    storage_write("relay:set", &relayers.join(","));
}

fn get_relayer_bond(addr: &str) -> i64 {
    get_i64(&format!("relay:bond:{}", addr))
}

fn set_relayer_bond(addr: &str, amount: i64) {
    set_i64(&format!("relay:bond:{}", addr), amount);
}

fn get_threshold() -> i64 {
    let v = get_i64("relay:threshold");
    if v <= 0 { 2 } else { v }
}

// ── sequence helpers ─────────────────────────────────────────────────────────

fn get_inbound_seq(chain_id: &str) -> u64 {
    get_u64(&format!("relay:in_seq:{}", chain_id))
}

fn set_inbound_seq(chain_id: &str, seq: u64) {
    set_u64(&format!("relay:in_seq:{}", chain_id), seq);
}

fn get_outbound_seq(chain_id: &str) -> u64 {
    get_u64(&format!("relay:out_seq:{}", chain_id))
}

fn set_outbound_seq(chain_id: &str, seq: u64) {
    set_u64(&format!("relay:out_seq:{}", chain_id), seq);
}

// ── attestation storage helpers ──────────────────────────────────────────────

fn att_key(chain_id: &str, seq: u64, field: &str) -> String {
    format!("att:{}:{}:{}", chain_id, seq, field)
}

fn get_att_field(chain_id: &str, seq: u64, field: &str) -> Option<String> {
    storage_read(&att_key(chain_id, seq, field))
}

fn set_att_field(chain_id: &str, seq: u64, field: &str, val: &str) {
    storage_write(&att_key(chain_id, seq, field), val);
}

// ── arg parsing: chain_id + seq layout ──────────────────────────────────────
//
// Many methods share: [chain_id_len, chain_id_bytes(ceil(len/4) words), seq_lo, seq_hi]
// Returns (chain_id, seq, next_word_offset) or None on invalid input.

fn parse_chain_seq(args_ptr: u32) -> Option<(String, u64, u32)> {
    let chain_id_len = read_i32_word(args_ptr, 0) as u32;
    if chain_id_len == 0 || chain_id_len > 64 { return None; }
    let chain_id_words = words_for(chain_id_len);
    let chain_id = read_str_at(args_ptr, 1, chain_id_len);
    let off = 1 + chain_id_words;
    let seq_lo = read_i32_word(args_ptr, off) as u32;
    let seq_hi = read_i32_word(args_ptr, off + 1) as u32;
    let seq = ((seq_hi as u64) << 32) | (seq_lo as u64);
    Some((chain_id, seq, off + 2))
}

// ── method implementations ───────────────────────────────────────────────────

/// 0 = register_relayer(amount_lo, amount_hi)
fn method_register_relayer(args_ptr: u32) -> i32 {
    let amount_lo = read_i32_word(args_ptr, 0) as u32;
    let amount_hi = read_i32_word(args_ptr, 1) as i32;
    let amount = ((amount_hi as i64) << 32) | (amount_lo as i64);

    let min_bond = relay_min_bond();
    if amount < min_bond { return 0; }

    let caller = host_caller();
    if caller.is_empty() { return -2; }

    let relayers = get_relayer_set();
    if relayers.contains(&caller) { return -1; }

    if unsafe { bond(amount) } != 1 { return -2; }

    let mut relayers = relayers;
    relayers.push(caller.clone());
    set_relayer_set(&relayers);
    set_relayer_bond(&caller, amount);

    host_log(&format!("RelayerRegistered addr={} bond={}", caller, amount));
    1
}

/// 1 = revoke_relayer(addr_words x10)
fn method_revoke_relayer(args_ptr: u32) -> i32 {
    let addr = read_str_at(args_ptr, 0, 40);
    if addr.len() != 40 { return 0; }

    let mut relayers = get_relayer_set();
    if !relayers.contains(&addr) { return 0; }

    let bond_amt = get_relayer_bond(&addr);
    if bond_amt > 0 {
        unsafe { payout(addr.as_ptr(), addr.len() as u32, bond_amt) };
        set_relayer_bond(&addr, 0);
    }

    relayers.retain(|a| a != &addr);
    set_relayer_set(&relayers);

    host_log(&format!("RelayerRevoked addr={} bond_returned={}", addr, bond_amt));
    1
}

/// 2 = set_threshold(m)
fn method_set_threshold(args_ptr: u32) -> i32 {
    let m = read_i32_word(args_ptr, 0);
    if m <= 0 { return 0; }
    set_i64("relay:threshold", m as i64);
    host_log(&format!("ThresholdSet m={}", m));
    1
}

/// 3 = submit_inbound_attestation(chain_id_len, chain_id_words, seq_lo, seq_hi,
///       commitment x8, n_sigs, [sig x16, pubkey x8, addr x10] x n_sigs)
fn method_submit_inbound(args_ptr: u32) -> i32 {
    let chain_id_len = read_i32_word(args_ptr, 0) as u32;
    if chain_id_len == 0 || chain_id_len > 64 { return -1; }
    let chain_id_words = words_for(chain_id_len);
    let chain_id = read_str_at(args_ptr, 1, chain_id_len);

    let off = 1 + chain_id_words;
    let seq_lo = read_i32_word(args_ptr, off) as u32;
    let seq_hi = read_i32_word(args_ptr, off + 1) as u32;
    let seq: u64 = ((seq_hi as u64) << 32) | (seq_lo as u64);

    // commitment: 32 bytes at word offset (off+2)
    let commitment: [u8; 32] = unsafe {
        let p = (args_ptr as usize + ((off + 2) as usize) * 4) as *const u8;
        core::slice::from_raw_parts(p, 32)
            .try_into()
            .unwrap_or([0u8; 32])
    };
    let commitment_hex = hex_encode(&commitment);

    let n_sigs = read_i32_word(args_ptr, off + 10) as u32;
    if n_sigs == 0 { return -3; }

    // Reject duplicate attestation first (before the sequence check so the
    // caller gets a precise "already exists" error rather than "bad seq").
    if get_att_field(&chain_id, seq, "commitment").is_some() { return -5; }

    // Sequence must advance by exactly 1
    let last_seq = get_inbound_seq(&chain_id);
    if seq != last_seq + 1 { return -4; }

    let relayers = get_relayer_set();
    if relayers.is_empty() { return -6; }

    let threshold = get_threshold() as u32;
    let msg_str = format!("attest:{}:{}:{}", chain_id, seq, commitment_hex);

    let mut valid_signers: Vec<String> = Vec::new();

    // Each signer block: sig(16 words) + pubkey(8 words) + addr(10 words) = 34 words
    let sigs_base = off + 11;
    for i in 0..n_sigs {
        let base = sigs_base + i * 34;
        let sig_ptr = (args_ptr as usize + (base as usize) * 4) as *const u8;
        let pubkey_ptr = (args_ptr as usize + ((base + 16) as usize) * 4) as *const u8;
        let addr_ptr = (args_ptr as usize + ((base + 24) as usize) * 4) as *const u8;
        let addr = unsafe { read_mem_str(addr_ptr as u32, 40) };

        if !relayers.contains(&addr) { return -7; }
        if valid_signers.contains(&addr) { return -8; }

        let ok = unsafe {
            verify_owner_sig(
                msg_str.as_ptr(), msg_str.len() as u32,
                sig_ptr, 64,
                pubkey_ptr, 32,
                addr_ptr, 40,
            )
        } == 1;
        if !ok { return -2; }

        valid_signers.push(addr);
    }

    if (valid_signers.len() as u32) < threshold { return -9; }

    // Store attestation
    set_att_field(&chain_id, seq, "commitment", &commitment_hex);
    set_att_field(&chain_id, seq, "signers", &valid_signers.join(","));
    set_u64(&att_key(&chain_id, seq, "block"), unsafe { block_number() } as u64);
    set_att_field(&chain_id, seq, "finalized", "0");
    set_att_field(&chain_id, seq, "challenged", "0");
    set_inbound_seq(&chain_id, seq);

    host_log(&format!("InboundAttested chain={} seq={} signers={}", chain_id, seq, valid_signers.len()));
    1
}

/// 4 = challenge_inbound(chain_id_len, chain_id_words, seq_lo, seq_hi)
/// Admin-protected at route level. Slashes all signers of the attestation.
fn method_challenge_inbound(args_ptr: u32) -> i32 {
    let (chain_id, seq, _) = match parse_chain_seq(args_ptr) {
        None => return -1,
        Some(t) => t,
    };

    if get_att_field(&chain_id, seq, "commitment").is_none() { return -1; }

    if get_att_field(&chain_id, seq, "finalized").map_or(false, |v| v == "1") { return -2; }
    if get_att_field(&chain_id, seq, "challenged").map_or(false, |v| v == "1") { return -3; }

    set_att_field(&chain_id, seq, "challenged", "1");
    set_u64(&att_key(&chain_id, seq, "challenge_block"), unsafe { block_number() } as u64);

    let slash_bp = relay_slash_bp();
    let reward_bp = relay_challenger_reward_bp();
    let challenger = host_caller();

    if let Some(signers_str) = get_att_field(&chain_id, seq, "signers") {
        for signer in signers_str.split(',').filter(|s| !s.is_empty()) {
            let bond_amt = get_relayer_bond(signer);
            if bond_amt <= 0 { continue; }
            let slash = bond_amt * slash_bp / 10_000;
            if slash <= 0 { continue; }

            let new_bond = bond_amt - slash;
            set_relayer_bond(signer, new_bond);

            let reward = slash * reward_bp / 10_000;
            if reward > 0 && !challenger.is_empty() {
                unsafe { payout(challenger.as_ptr(), challenger.len() as u32, reward) };
            }
            host_log(&format!("RelayerSlashed signer={} slash={} reward={}", signer, slash, reward));
        }
    }

    host_log(&format!("InboundChallenged chain={} seq={}", chain_id, seq));
    1
}

/// 5 = finalize_inbound(chain_id_len, chain_id_words, seq_lo, seq_hi)
fn method_finalize_inbound(args_ptr: u32) -> i32 {
    let (chain_id, seq, _) = match parse_chain_seq(args_ptr) {
        None => return -1,
        Some(t) => t,
    };

    if get_att_field(&chain_id, seq, "commitment").is_none() { return -1; }
    if get_att_field(&chain_id, seq, "finalized").map_or(false, |v| v == "1") { return -2; }

    // Cannot finalize a challenged attestation
    if get_att_field(&chain_id, seq, "challenged").map_or(false, |v| v == "1") {
        return -4;
    }

    let block = get_u64(&att_key(&chain_id, seq, "block"));
    let now = unsafe { block_number() } as u64;
    let window = challenge_window();
    if now < block + window { return -3; }

    set_att_field(&chain_id, seq, "finalized", "1");
    host_log(&format!("InboundFinalized chain={} seq={}", chain_id, seq));
    1
}

/// 6 = publish_outbound(chain_id_len, chain_id_words, commitment x8)
fn method_publish_outbound(args_ptr: u32) -> i32 {
    let chain_id_len = read_i32_word(args_ptr, 0) as u32;
    if chain_id_len == 0 || chain_id_len > 64 { return 0; }
    let chain_id_words = words_for(chain_id_len);
    let chain_id = read_str_at(args_ptr, 1, chain_id_len);

    let off = 1 + chain_id_words;
    let commitment: [u8; 32] = unsafe {
        let p = (args_ptr as usize + (off as usize) * 4) as *const u8;
        core::slice::from_raw_parts(p, 32)
            .try_into()
            .unwrap_or([0u8; 32])
    };
    let commitment_hex = hex_encode(&commitment);

    let seq = get_outbound_seq(&chain_id) + 1;
    storage_write(&format!("out:{}:{}:commitment", chain_id, seq), &commitment_hex);
    set_u64(&format!("out:{}:{}:block", chain_id, seq), unsafe { block_number() } as u64);
    set_outbound_seq(&chain_id, seq);

    host_log(&format!("OutboundPublished chain={} seq={}", chain_id, seq));
    seq as i32
}

/// 7 = get_inbound_status(chain_id_len, chain_id_words, seq_lo, seq_hi)
/// Returns: 0=pending, 1=finalized, 2=challenged, -1=not found
fn method_get_inbound_status(args_ptr: u32) -> i32 {
    let (chain_id, seq, _) = match parse_chain_seq(args_ptr) {
        None => return -1,
        Some(t) => t,
    };
    if get_att_field(&chain_id, seq, "commitment").is_none() { return -1; }
    if get_att_field(&chain_id, seq, "challenged").map_or(false, |v| v == "1") { return 2; }
    if get_att_field(&chain_id, seq, "finalized").map_or(false, |v| v == "1") { return 1; }
    0
}

/// 8 = get_outbound_seq(chain_id_len, chain_id_words)
fn method_get_outbound_seq(args_ptr: u32) -> i32 {
    let chain_id_len = read_i32_word(args_ptr, 0) as u32;
    if chain_id_len == 0 || chain_id_len > 64 { return 0; }
    let chain_id = read_str_at(args_ptr, 1, chain_id_len);
    get_outbound_seq(&chain_id) as i32
}

/// 9 = get_threshold()
fn method_get_threshold(_args_ptr: u32) -> i32 {
    get_threshold() as i32
}

/// 10 = get_relayer_count()
fn method_get_relayer_count(_args_ptr: u32) -> i32 {
    get_relayer_set().len() as i32
}

// ── exports ──────────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let layout = core::alloc::Layout::from_size_align(size.max(1) as usize, 8).unwrap();
    let ptr = unsafe { alloc::alloc::alloc(layout) };
    ptr as u32
}

#[no_mangle]
pub extern "C" fn call(method_id: u32, args_ptr: u32, _args_len: u32) -> i32 {
    match method_id {
        0  => method_register_relayer(args_ptr),
        1  => method_revoke_relayer(args_ptr),
        2  => method_set_threshold(args_ptr),
        3  => method_submit_inbound(args_ptr),
        4  => method_challenge_inbound(args_ptr),
        5  => method_finalize_inbound(args_ptr),
        6  => method_publish_outbound(args_ptr),
        7  => method_get_inbound_status(args_ptr),
        8  => method_get_outbound_seq(args_ptr),
        9  => method_get_threshold(args_ptr),
        10 => method_get_relayer_count(args_ptr),
        _  => -1,
    }
}
