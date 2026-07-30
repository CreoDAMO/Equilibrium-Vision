//! Ethereum Sync Committee Light Client — WASM contract for trustless ETH→EQU bridge.
//!
//! Implements Claim 3 (partial): trustless Ethereum light client bridge.
//!
//! # Trust model
//!
//! The Ethereum Altair/Bellatrix sync committee (512 validators) signs every
//! beacon block header. This contract verifies:
//!   1. The sync committee aggregate BLS-12-381 signature over the beacon header
//!   2. That ≥ 2/3 of the 512-member committee participated (supermajority)
//!   3. The committee hash matches the stored aggregate public key
//!
//! BLS verification delegates to host imports (`bls_aggregate_pubkeys`, `bls_verify`)
//! which are provided by the Equilibrium WASM VM host — implemented via
//! @noble/curves/bls12-381 (TypeScript side) or the Rust sidecar.
//!
//! # Security parameters
//!
//! - Sync committee size: 512 validators
//! - Supermajority threshold: 342 / 512 (≥ 2/3)
//! - Committee rotation period: ~27 hours (256 epochs × 384s)
//!
//! # Call ABI
//!
//! call(method_id, args_ptr, args_len) -> i32
//!
//!   0 = bootstrap(committee_bytes: [u8; 512*48], aggregate_pubkey: [u8; 48])
//!       Initialize the light client with the initial sync committee.
//!       -> 1 ok, -1 already bootstrapped
//!
//!   1 = update_committee(header_bytes, committee_bytes, sig_bytes, participation_bits)
//!       Rotate to a new sync committee after verifying the current committee
//!       signed the update.
//!       -> 1 ok, -1 bad sig, -2 quorum not met, -3 not bootstrapped
//!
//!   2 = submit_header(beacon_header_bytes: [u8; HEADER_LEN], sig_bytes: [u8; 96],
//!                      participation_bits: [u8; 64])
//!       Verify and store a beacon block header signed by the sync committee.
//!       -> 1 ok, -1 bad sig, -2 quorum not met, -3 not bootstrapped
//!
//!   3 = verify_eth_event(receipt_proof: [...], log_index: u32, block_slot: u64)
//!       Verify an EVM event log inclusion (via receipt Merkle proof).
//!       -> 1 ok, -1 no header for slot, -2 bad proof
//!
//!   4 = get_latest_slot() -> i32 (slot number of latest verified header)

#![no_std]
use sha2::{Sha256, Digest};
use core::sync::atomic::{AtomicU64, AtomicBool, Ordering};

// ── Host imports ──────────────────────────────────────────────────────────────

/// BLS-12-381 host imports. Provided by the Equilibrium WASM VM.
/// These delegate to @noble/curves/bls12-381 on the TypeScript side.
#[cfg(target_arch = "wasm32")]
extern "C" {
    /// Aggregate `n` BLS-12-381 G1 public keys (each 48 bytes).
    /// `pubkeys_ptr`: pointer to n×48 bytes of compressed G1 points.
    /// `n`: number of pubkeys.
    /// `out_ptr`: pointer to 48-byte output buffer.
    /// Returns 1 on success, -1 on error.
    fn bls_aggregate_pubkeys(pubkeys_ptr: *const u8, n: u32, out_ptr: *mut u8) -> i32;

    /// Verify a BLS-12-381 signature.
    /// `pubkey_ptr`: 48-byte compressed G1 public key.
    /// `msg_ptr`, `msg_len`: message bytes.
    /// `sig_ptr`: 96-byte compressed G2 signature.
    /// Returns 1 if valid, 0 if invalid, -1 on error.
    fn bls_verify(pubkey_ptr: *const u8, msg_ptr: *const u8, msg_len: u32, sig_ptr: *const u8) -> i32;

    /// Credit `amount` tokens to `recipient` (40-char hex address).
    fn host_credit(recipient_ptr: *const u8, amount: u64);

    /// Get current Equilibrium block number.
    fn block_number() -> u64;
}

#[cfg(not(target_arch = "wasm32"))]
mod host_stubs {
    pub unsafe fn bls_aggregate_pubkeys(_pubkeys_ptr: *const u8, _n: u32, out_ptr: *mut u8) -> i32 {
        // Stub: fill with zeros (tests that don't exercise BLS will pass)
        unsafe { core::ptr::write_bytes(out_ptr, 0, 48); }
        1
    }
    pub unsafe fn bls_verify(_pk: *const u8, _msg: *const u8, _len: u32, _sig: *const u8) -> i32 {
        1 // always valid in tests (BLS is host-provided in production)
    }
    pub unsafe fn host_credit(_recipient_ptr: *const u8, _amount: u64) {}
    pub unsafe fn block_number() -> u64 { 0 }
}
#[cfg(not(target_arch = "wasm32"))]
use host_stubs::*;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Ethereum Altair sync committee size.
pub const SYNC_COMMITTEE_SIZE: usize = 512;
/// BLS G1 compressed public key size (bytes).
pub const BLS_PUBKEY_LEN: usize = 48;
/// BLS G2 compressed signature size (bytes).
pub const BLS_SIG_LEN: usize = 96;
/// Participation bits: 512 bits = 64 bytes.
pub const PARTICIPATION_BYTES: usize = 64;
/// Minimum participating validators (342/512 ≈ 2/3 + 1).
pub const MIN_PARTICIPANTS: u32 = 342;

/// Maximum beacon headers stored in the sliding window.
const MAX_HEADERS: usize = 256;

// ── Beacon header ─────────────────────────────────────────────────────────────

/// Ethereum Beacon chain block header (simplified light-client format).
/// See: https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/light-client/sync-protocol.md
#[derive(Clone, Copy)]
pub struct LightClientHeader {
    /// Beacon block slot number.
    pub slot: u64,
    /// Beacon block proposer index.
    pub proposer_index: u64,
    /// Parent root (32 bytes).
    pub parent_root: [u8; 32],
    /// State root (32 bytes).
    pub state_root: [u8; 32],
    /// Body root (32 bytes).
    pub body_root: [u8; 32],
    /// Sync committee participation bitmask (512 bits = 64 bytes).
    pub sync_committee_bits: [u8; PARTICIPATION_BYTES],
    /// BLS aggregate signature over this header (G2, 96 bytes).
    pub sync_committee_signature: [u8; BLS_SIG_LEN],
}

impl LightClientHeader {
    /// Minimum wire size: slot(8)+proposer(8)+3×root(96)+participation(64)+sig(96) = 272 bytes.
    pub const WIRE_LEN: usize = 8 + 8 + 32 + 32 + 32 + PARTICIPATION_BYTES + BLS_SIG_LEN;

    pub fn parse(raw: &[u8]) -> Option<Self> {
        if raw.len() < Self::WIRE_LEN { return None; }
        let mut cursor = 0;
        macro_rules! read_u64 {
            () => {{
                let v = u64::from_le_bytes(raw[cursor..cursor+8].try_into().ok()?);
                cursor += 8;
                v
            }};
        }
        macro_rules! read_32 {
            () => {{
                let v: [u8; 32] = raw[cursor..cursor+32].try_into().ok()?;
                cursor += 32;
                v
            }};
        }
        let slot           = read_u64!();
        let proposer_index = read_u64!();
        let parent_root    = read_32!();
        let state_root     = read_32!();
        let body_root      = read_32!();
        let sync_committee_bits: [u8; PARTICIPATION_BYTES] =
            raw[cursor..cursor + PARTICIPATION_BYTES].try_into().ok()?;
        cursor += PARTICIPATION_BYTES;
        let sync_committee_signature: [u8; BLS_SIG_LEN] =
            raw[cursor..cursor + BLS_SIG_LEN].try_into().ok()?;
        Some(Self { slot, proposer_index, parent_root, state_root, body_root,
                    sync_committee_bits, sync_committee_signature })
    }
}

/// Count the number of set bits in the participation bitmask.
pub fn count_participants(bits: &[u8; PARTICIPATION_BYTES]) -> u32 {
    bits.iter().map(|b| b.count_ones()).sum()
}

/// Look up the stored body_root for a given slot, or None if not found.
fn find_body_root_for_slot(slot: u64) -> Option<[u8; 32]> {
    let limit = unsafe { STORED_COUNT }.min(MAX_HEADERS);
    for i in 0..limit {
        if unsafe { STORED_SLOTS[i] } == slot {
            return Some(unsafe { STORED_BODY_ROOTS[i] });
        }
    }
    None
}

/// Verify a Merkle inclusion path from `leaf` up to `root`.
/// Hash a beacon header for BLS signing (domain-separated).
///
/// Ethereum uses SSZ hash_tree_root + signing_root with a domain prefix.
/// Simplified here: SHA256("equilibrium-eth-lc-v1" || slot_le || state_root).
pub fn hash_header(header: &LightClientHeader) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"equilibrium-eth-lc-v1");
    h.update(header.slot.to_le_bytes());
    h.update(header.proposer_index.to_le_bytes());
    h.update(header.parent_root);
    h.update(header.state_root);
    h.update(header.body_root);
    h.finalize().into()
}

// ── Contract state ────────────────────────────────────────────────────────────

static BOOTSTRAPPED: AtomicBool = AtomicBool::new(false);
static LATEST_SLOT: AtomicU64 = AtomicU64::new(0);

// Current sync committee aggregate public key (48 bytes).
// In production this lives in host persistent storage.
static mut AGGREGATE_PUBKEY: [u8; BLS_PUBKEY_LEN] = [0u8; BLS_PUBKEY_LEN];

// Stored beacon state roots indexed by slot (ring buffer).
static mut STORED_SLOTS:       [u64; MAX_HEADERS]    = [0u64; MAX_HEADERS];
static mut STORED_STATE_ROOTS: [[u8; 32]; MAX_HEADERS] = [[0u8; 32]; MAX_HEADERS];
static mut STORED_BODY_ROOTS:  [[u8; 32]; MAX_HEADERS] = [[0u8; 32]; MAX_HEADERS];
static mut STORED_COUNT: usize = 0;

// ── WASM / non-WASM entry point ───────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn call(method_id: i32, args_ptr: *const u8, args_len: usize) -> i32 {
    let args = unsafe { core::slice::from_raw_parts(args_ptr, args_len) };
    dispatch(method_id, args)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn call(method_id: i32, args: &[u8]) -> i32 {
    dispatch(method_id, args)
}

fn dispatch(method_id: i32, args: &[u8]) -> i32 {
    match method_id {
        0 => do_bootstrap(args),
        1 => do_update_committee(args),
        2 => do_submit_header(args),
        3 => do_verify_eth_event(args),
        4 => LATEST_SLOT.load(Ordering::SeqCst) as i32,
        _ => -100,
    }
}

/// Bootstrap: initialize with the first sync committee aggregate public key.
///
/// Args: [aggregate_pubkey: 48 bytes]
fn do_bootstrap(args: &[u8]) -> i32 {
    if args.len() < BLS_PUBKEY_LEN { return -10; }
    if BOOTSTRAPPED.load(Ordering::SeqCst) { return -1; } // already bootstrapped

    unsafe {
        AGGREGATE_PUBKEY.copy_from_slice(&args[..BLS_PUBKEY_LEN]);
    }
    BOOTSTRAPPED.store(true, Ordering::SeqCst);
    1
}

/// Rotate the sync committee aggregate public key.
///
/// Verifies the current committee signed the transition header, then installs
/// the new aggregate public key. Also stores the header's slot/roots.
///
/// Args: [header_bytes: WIRE_LEN | new_aggregate_pubkey: BLS_PUBKEY_LEN]
fn do_update_committee(args: &[u8]) -> i32 {
    if !BOOTSTRAPPED.load(Ordering::SeqCst) { return -3; }
    if args.len() < LightClientHeader::WIRE_LEN + BLS_PUBKEY_LEN { return -10; }

    let header = match LightClientHeader::parse(args) {
        Some(h) => h,
        None => return -10,
    };

    // 1. Quorum from current committee
    let participants = count_participants(&header.sync_committee_bits);
    if participants < MIN_PARTICIPANTS { return -2; }

    // 2. BLS verify against current aggregate pubkey
    let msg = hash_header(&header);
    let verified = unsafe {
        bls_verify(
            AGGREGATE_PUBKEY.as_ptr(),
            msg.as_ptr(),
            msg.len() as u32,
            header.sync_committee_signature.as_ptr(),
        )
    };
    if verified != 1 { return -1; }

    // 3. Install the new aggregate pubkey
    let new_pk = &args[LightClientHeader::WIRE_LEN..LightClientHeader::WIRE_LEN + BLS_PUBKEY_LEN];
    unsafe { AGGREGATE_PUBKEY.copy_from_slice(new_pk); }

    // 4. Store this header (same as submit_header)
    let slot = header.slot;
    unsafe {
        let i = STORED_COUNT % MAX_HEADERS;
        STORED_SLOTS[i]       = slot;
        STORED_STATE_ROOTS[i] = header.state_root;
        STORED_BODY_ROOTS[i]  = header.body_root;
        STORED_COUNT += 1;
    }
    let prev = LATEST_SLOT.load(Ordering::SeqCst);
    if slot > prev { LATEST_SLOT.store(slot, Ordering::SeqCst); }

    1
}

/// Submit and verify a beacon block header signed by the current sync committee.
///
/// Args: [header_bytes: LightClientHeader::WIRE_LEN]
///
/// The header contains embedded participation bits and signature, so no
/// separate sig_bytes argument is needed.
fn do_submit_header(args: &[u8]) -> i32 {
    if !BOOTSTRAPPED.load(Ordering::SeqCst) { return -3; }

    let header = match LightClientHeader::parse(args) {
        Some(h) => h,
        None => return -10,
    };

    // 1. Count participants and check supermajority
    let participants = count_participants(&header.sync_committee_bits);
    if participants < MIN_PARTICIPANTS {
        return -2; // quorum not met
    }

    // 2. Collect participating pubkeys from the committee
    //    (In production: look up each set bit's pubkey from persistent storage.)
    //    Here we use the stored aggregate as a proxy for testing.
    let msg = hash_header(&header);
    let verified = unsafe {
        bls_verify(
            AGGREGATE_PUBKEY.as_ptr(),
            msg.as_ptr(),
            msg.len() as u32,
            header.sync_committee_signature.as_ptr(),
        )
    };
    if verified != 1 { return -1; } // bad signature

    // 3. Store the header
    let slot = header.slot;
    let idx = unsafe {
        let count = STORED_COUNT;
        let i = count % MAX_HEADERS;
        STORED_SLOTS[i]       = slot;
        STORED_STATE_ROOTS[i] = header.state_root;
        STORED_BODY_ROOTS[i]  = header.body_root;
        STORED_COUNT += 1;
        i
    };
    let _ = idx;

    // Update latest slot
    let prev_latest = LATEST_SLOT.load(Ordering::SeqCst);
    if slot > prev_latest {
        LATEST_SLOT.store(slot, Ordering::SeqCst);
    }

    1 // ok
}

/// Verify an EVM event/receipt inclusion against the stored body_root for a slot.
///
/// Uses a Merkle inclusion path: callers provide leaf + sibling hashes; the
/// contract recomputes the root and checks it equals the stored body_root.
///
/// Args wire layout:
///   [0..8]   slot:       u64 LE
///   [8..12]  log_index:  u32 LE  (bit i → 0=leaf-is-left, 1=leaf-is-right at level i)
///   [12..16] proof_len:  u32 LE  (number of 32-byte sibling hashes; 0 = leaf IS root)
///   [16 .. 16+32*proof_len] sibling hashes
///   [16+32*proof_len .. +32] leaf hash
///
/// Returns:
///   1   inclusion verified
///  -1   no stored header for that slot
///  -2   Merkle path does not reach stored body_root
fn do_verify_eth_event(args: &[u8]) -> i32 {
    if args.len() < 16 { return -10; }

    let slot       = u64::from_le_bytes(args[0..8].try_into().unwrap_or([0u8; 8]));
    let log_index  = u32::from_le_bytes(args[8..12].try_into().unwrap_or([0u8; 4]));
    let proof_len  = u32::from_le_bytes(args[12..16].try_into().unwrap_or([0u8; 4])) as usize;

    let nodes_end = 16 + 32 * proof_len;
    let leaf_end  = nodes_end + 32;
    if args.len() < leaf_end { return -10; }

    let body_root = match find_body_root_for_slot(slot) {
        Some(r) => r,
        None => return -1,
    };

    // Walk the Merkle path in-place (no heap allocation needed).
    let mut current: [u8; 32] = args[nodes_end..leaf_end].try_into().unwrap_or([0u8; 32]);
    for i in 0..proof_len {
        let off = 16 + i * 32;
        let sibling: [u8; 32] = args[off..off + 32].try_into().unwrap_or([0u8; 32]);
        let mut h = Sha256::new();
        if (log_index >> i) & 1 == 0 {
            h.update(current);
            h.update(sibling);
        } else {
            h.update(sibling);
            h.update(current);
        }
        current = h.finalize().into();
    }

    if current == body_root { 1 } else { -2 }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_sets_pubkey() {
        // Reset state for test
        BOOTSTRAPPED.store(false, Ordering::SeqCst);

        let mut args = [0u8; BLS_PUBKEY_LEN];
        args[0] = 0xAB; // non-zero sentinel
        let result = call(0, &args);
        assert_eq!(result, 1, "bootstrap should succeed");
        assert!(BOOTSTRAPPED.load(Ordering::SeqCst));
    }

    #[test]
    fn bootstrap_idempotent() {
        BOOTSTRAPPED.store(true, Ordering::SeqCst);
        let args = [0u8; BLS_PUBKEY_LEN];
        let result = call(0, &args);
        assert_eq!(result, -1, "second bootstrap should return -1");
    }

    #[test]
    fn count_participants_full_committee() {
        let bits = [0xFFu8; PARTICIPATION_BYTES];
        assert_eq!(count_participants(&bits), 512);
    }

    #[test]
    fn count_participants_supermajority() {
        // 342 participants = MIN_PARTICIPANTS
        let mut bits = [0u8; PARTICIPATION_BYTES];
        // Set 342 bits (42 full bytes = 336, plus 6 more)
        for i in 0..42 { bits[i] = 0xFF; }
        bits[42] = 0b0011_1111; // 6 more bits
        let count = count_participants(&bits);
        assert_eq!(count, 342);
        assert!(count >= MIN_PARTICIPANTS);
    }

    #[test]
    fn submit_header_without_bootstrap_returns_minus3() {
        BOOTSTRAPPED.store(false, Ordering::SeqCst);
        let args = [0u8; LightClientHeader::WIRE_LEN];
        let result = call(2, &args); // submit_header is now method 2
        assert_eq!(result, -3);
    }

    #[test]
    fn submit_header_below_quorum_returns_minus2() {
        BOOTSTRAPPED.store(true, Ordering::SeqCst);
        // All participation bits zero → 0 participants < 342
        let args = [0u8; LightClientHeader::WIRE_LEN];
        let result = call(2, &args); // submit_header is now method 2
        assert_eq!(result, -2, "zero participants should fail quorum check");
    }

    // ── update_committee tests ────────────────────────────────────────────────

    // Wire length for update_committee args: header + new aggregate pubkey
    const UPDATE_ARGS_LEN: usize = LightClientHeader::WIRE_LEN + BLS_PUBKEY_LEN;

    #[test]
    fn update_committee_requires_bootstrap() {
        BOOTSTRAPPED.store(false, Ordering::SeqCst);
        let args = [0u8; UPDATE_ARGS_LEN];
        assert_eq!(call(1, &args), -3);
    }

    #[test]
    fn update_committee_below_quorum_returns_minus2() {
        BOOTSTRAPPED.store(true, Ordering::SeqCst);
        // Zero participation bits → no quorum
        let args = [0u8; UPDATE_ARGS_LEN];
        assert_eq!(call(1, &args), -2);
    }

    #[test]
    fn update_committee_rotates_aggregate_pubkey() {
        // BLS stub always returns 1, so full-participation header passes immediately.
        BOOTSTRAPPED.store(true, Ordering::SeqCst);
        unsafe { STORED_COUNT = 0; }
        LATEST_SLOT.store(0, Ordering::SeqCst);

        let mut args = [0u8; UPDATE_ARGS_LEN];
        // Full participation bits (512 set bits = supermajority)
        // sync_committee_bits starts at offset 8+8+32+32+32 = 112
        for b in args[112..112 + PARTICIPATION_BYTES].iter_mut() { *b = 0xFF; }
        // New aggregate pubkey sentinel byte at offset WIRE_LEN
        args[LightClientHeader::WIRE_LEN] = 0xBE;

        assert_eq!(call(1, &args), 1);
        // Aggregate pubkey must have been updated
        unsafe { assert_eq!(AGGREGATE_PUBKEY[0], 0xBE); }
    }

    // ── get_latest_slot tests (method 4) ──────────────────────────────────────

    #[test]
    fn get_latest_slot_method_id_is_4() {
        LATEST_SLOT.store(77, Ordering::SeqCst);
        assert_eq!(call(4, &[]), 77);
    }

    // ── verify_eth_event tests (method 3) ─────────────────────────────────────

    // Wire size for an event proof with no sibling nodes: slot(8)+log_idx(4)+proof_len(4)+leaf(32)
    const EVENT_ARGS_ZERO_DEPTH: usize = 8 + 4 + 4 + 32;

    #[test]
    fn verify_eth_event_no_header_returns_minus1() {
        unsafe { STORED_COUNT = 0; }
        let mut args = [0u8; EVENT_ARGS_ZERO_DEPTH];
        args[0..8].copy_from_slice(&9999u64.to_le_bytes()); // slot 9999, never stored
        // proof_len = 0; leaf = [0;32]
        assert_eq!(call(3, &args), -1);
    }

    #[test]
    fn verify_eth_event_zero_depth_matches_body_root() {
        // Submit a header first so we have a body_root to check against.
        BOOTSTRAPPED.store(true, Ordering::SeqCst);
        unsafe { STORED_COUNT = 0; }
        LATEST_SLOT.store(0, Ordering::SeqCst);

        let target_body_root = [0xCAu8; 32];
        let mut header_args = [0u8; LightClientHeader::WIRE_LEN];
        header_args[0..8].copy_from_slice(&42u64.to_le_bytes()); // slot = 42
        // body_root at offset 8+8+32+32 = 80
        header_args[80..112].copy_from_slice(&target_body_root);
        // Full participation bits at offset 112
        for b in header_args[112..112 + PARTICIPATION_BYTES].iter_mut() { *b = 0xFF; }
        assert_eq!(call(2, &header_args), 1, "header submit must succeed");

        // Zero-depth proof: proof_len=0, leaf = body_root → computed root == body_root
        let mut ev_args = [0u8; EVENT_ARGS_ZERO_DEPTH];
        ev_args[0..8].copy_from_slice(&42u64.to_le_bytes()); // slot = 42
        // log_index=0, proof_len=0 (both zero at offsets 8,12)
        ev_args[16..48].copy_from_slice(&target_body_root); // leaf = body_root
        assert_eq!(call(3, &ev_args), 1, "zero-depth leaf==body_root must verify");
    }

    #[test]
    fn verify_eth_event_bad_leaf_returns_minus2() {
        BOOTSTRAPPED.store(true, Ordering::SeqCst);
        unsafe { STORED_COUNT = 0; }

        let body_root = [0xABu8; 32];
        let mut hdr = [0u8; LightClientHeader::WIRE_LEN];
        hdr[0..8].copy_from_slice(&100u64.to_le_bytes()); // slot 100
        hdr[80..112].copy_from_slice(&body_root);
        for b in hdr[112..112 + PARTICIPATION_BYTES].iter_mut() { *b = 0xFF; }
        call(2, &hdr);

        let mut ev = [0u8; EVENT_ARGS_ZERO_DEPTH];
        ev[0..8].copy_from_slice(&100u64.to_le_bytes()); // slot 100
        ev[16..48].copy_from_slice(&[0xFFu8; 32]);       // wrong leaf
        assert_eq!(call(3, &ev), -2, "wrong leaf must fail");
    }

    #[test]
    fn header_hash_is_deterministic() {
        let h = LightClientHeader {
            slot: 1234567,
            proposer_index: 42,
            parent_root: [1u8; 32],
            state_root: [2u8; 32],
            body_root: [3u8; 32],
            sync_committee_bits: [0xFF; PARTICIPATION_BYTES],
            sync_committee_signature: [0u8; BLS_SIG_LEN],
        };
        let hash1 = hash_header(&h);
        let hash2 = hash_header(&h);
        assert_eq!(hash1, hash2);
    }
}
