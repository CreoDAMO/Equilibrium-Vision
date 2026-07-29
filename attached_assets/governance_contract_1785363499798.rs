#![no_std]
extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::slice;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── allocator ────────────────────────────────────────────────────────────────
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

// ── host imports ─────────────────────────────────────────────────────────────
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
    fn call_contract(addr_ptr: *const u8, addr_len: u32, method_id: i32,
                     args_ptr: *const u8, args_len: u32,
                     caller_ptr: *const u8, caller_len: u32) -> i32;
}

// ── constants ────────────────────────────────────────────────────────────────
const SCALE: i64 = 1_000_000_000_000_000_000; // 10^18
const READ_BUF_LEN: usize = 2048;

// Proposal statuses
const STATUS_PROPOSED: i64 = 0;
const STATUS_VOTING: i64 = 1;
const STATUS_PASSED: i64 = 2;
const STATUS_FAILED: i64 = 3;
const STATUS_EXECUTED: i64 = 4;
const STATUS_CANCELLED: i64 = 5;

// Vote options
const VOTE_YES: u8 = 1;
const VOTE_NO: u8 = 2;
const VOTE_ABSTAIN: u8 = 3;

// Message types
const MSG_GOV_PARAM: u8 = 0;
const MSG_TREASURY_SPEND: u8 = 1;
const MSG_CONTRACT_CALL: u8 = 2;

// ── helpers ──────────────────────────────────────────────────────────────────
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
fn set_i64(key: &str, val: i64) {
    storage_write(key, &val.to_string());
}

fn key(prefix: &str, id: i64) -> String {
    format!("{}:{}", prefix, id)
}

fn read_i32_word(ptr: u32, idx: u32) -> i32 {
    unsafe { core::ptr::read_unaligned((ptr as usize + (idx as usize) * 4) as *const i32) }
}

fn read_i64_word(ptr: u32, idx: u32) -> i64 {
    unsafe {
        let base = (ptr as usize + (idx as usize) * 4) as *const i32;
        let lo = core::ptr::read_unaligned(base) as u32;
        let hi = core::ptr::read_unaligned(base.add(1)) as i32;
        ((hi as i64) << 32) | (lo as i64)
    }
}

fn read_addr(ptr: u32, word_offset: u32) -> String {
    let mut bytes = [0u8; 40];
    for i in 0..10u32 {
        let w = read_i32_word(ptr, word_offset + i);
        bytes[(i * 4) as usize..(i * 4 + 4) as usize].copy_from_slice(&w.to_le_bytes());
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn write_addr_to_words(addr: &str) -> Vec<i32> {
    let bytes = addr.as_bytes();
    let mut words = Vec::new();
    for i in (0..40).step_by(4) {
        let mut w = 0i32;
        for b in 0..4 {
            w |= (bytes.get(i + b).copied().unwrap_or(0) as i32) << (b * 8);
        }
        words.push(w);
    }
    words
}

fn fp_mul(a: i64, b: i64) -> i64 {
    ((a as i128 * b as i128) / SCALE as i128) as i64
}

fn fp_div(a: i64, b: i64) -> i64 {
    if b == 0 { return 0; }
    ((a as i128 * SCALE as i128) / b as i128) as i64
}

fn min_i64(a: i64, b: i64) -> i64 { if a < b { a } else { b } }
fn max_i64(a: i64, b: i64) -> i64 { if a > b { a } else { b } }

// ── proposal registry ────────────────────────────────────────────────────────
fn next_proposal_id() -> i64 {
    let id = get_i64("meta_next_proposal_id");
    set_i64("meta_next_proposal_id", id + 1);
    id
}

fn proposal_exists(id: i64) -> bool {
    storage_read(&key("proposal_status", id)).is_some()
}

// ── voting power (bonded governance tokens) ──────────────────────────────────
fn get_voting_power(addr: &str, _snapshot_block: i64) -> i64 {
    // Simplified: voting power = current bonded amount.
    // Future: snapshot at proposal creation block by reading historical stake.
    get_i64(&format!("gov_bond:{}", addr))
}

fn bond_gov_tokens(addr: &str, amount: i64) -> bool {
    if unsafe { bond(amount) } != 1 { return false; }
    let key = format!("gov_bond:{}", addr);
    set_i64(&key, get_i64(&key) + amount);
    true
}

fn unbond_gov_tokens(addr: &str, amount: i64) -> bool {
    let key = format!("gov_bond:{}", addr);
    let current = get_i64(&key);
    if current < amount { return false; }
    set_i64(&key, current - amount);
    if unsafe { payout(addr.as_ptr(), addr.len() as u32, amount) } != 1 {
        // If payout fails, restore bond (shouldn't happen in practice)
        set_i64(&key, current);
        return false;
    }
    true
}

// ── proposal message encoding ────────────────────────────────────────────────
// Messages are stored as comma-separated strings for simplicity:
// "type,param_name,value" for gov_param
// "type,recipient,value" for treasury
// "type,contract_addr,method_id,arg1,arg2,..." for contract call

fn encode_message(msg_type: u8, fields: &[&str]) -> String {
    let mut s = format!("{}", msg_type);
    for f in fields {
        s.push(',');
        s.push_str(f);
    }
    s
}

fn decode_message(msg: &str) -> Option<(u8, Vec<&str>)> {
    let parts: Vec<&str> = msg.split(',').collect();
    if parts.is_empty() { return None; }
    let msg_type = parts[0].parse::<u8>().ok()?;
    Some((msg_type, parts[1..].to_vec()))
}

// ── execute message ──────────────────────────────────────────────────────────
fn execute_message(msg: &str, _proposal_id: i64) -> bool {
    let (msg_type, fields) = match decode_message(msg) {
        Some(x) => x,
        None => return false,
    };

    match msg_type {
        MSG_GOV_PARAM => {
            if fields.len() < 2 { return false; }
            let param_name = fields[0];
            let value = match fields[1].parse::<i64>() {
                Ok(v) => v,
                Err(_) => return false,
            };
            // Store as a pending parameter change. The TypeScript governance
            // module reads these keys at processBlock() time and applies them.
            storage_write(&format!("gov_pending_param:{}", param_name), &value.to_string());
            host_log(&format!("GovParamSet {}={}", param_name, value));
            true
        }
        MSG_TREASURY_SPEND => {
            if fields.len() < 2 { return false; }
            let recipient = fields[0];
            let amount = match fields[1].parse::<i64>() {
                Ok(v) => v,
                Err(_) => return false,
            };
            let treasury = get_i64("gov_treasury");
            if treasury < amount { return false; }
            set_i64("gov_treasury", treasury - amount);
            let ok = unsafe { payout(recipient.as_ptr(), recipient.len() as u32, amount) } == 1;
            if ok {
                host_log(&format!("TreasurySpend {} to {}", amount, recipient));
            }
            ok
        }
        MSG_CONTRACT_CALL => {
            if fields.len() < 3 { return false; }
            let contract_addr = fields[0];
            let method_id = match fields[1].parse::<i32>() {
                Ok(v) => v,
                Err(_) => return false,
            };
            // Remaining fields are i32 args
            let mut arg_words: Vec<i32> = Vec::new();
            for f in &fields[2..] {
                match f.parse::<i32>() {
                    Ok(v) => arg_words.push(v),
                    Err(_) => return false,
                }
            }
            let addr_words = write_addr_to_words(contract_addr);
            let caller = host_caller(); // governance contract is the caller
            let caller_words = write_addr_to_words(&caller);

            // Flatten args into a byte buffer (i32 LE words)
            let mut arg_bytes: Vec<u8> = Vec::with_capacity(arg_words.len() * 4);
            for w in &arg_words {
                arg_bytes.extend_from_slice(&w.to_le_bytes());
            }

            let result = unsafe {
                call_contract(
                    addr_words.as_ptr() as *const u8, addr_words.len() as u32 * 4,
                    method_id,
                    arg_bytes.as_ptr(), arg_bytes.len() as u32,
                    caller_words.as_ptr() as *const u8, caller_words.len() as u32 * 4,
                )
            };
            host_log(&format!("ContractCall {}::{} -> {}", contract_addr, method_id, result));
            result >= 0
        }
        _ => false,
    }
}

// ── methods ──────────────────────────────────────────────────────────────────

/// 0: submit_proposal(title_len, title, desc_len, desc, deposit_fp,
///                    msg_count: u32, messages...)
fn method_submit_proposal(args_ptr: u32) -> i32 {
    let mut off: u32 = 0;

    let title_len = read_i32_word(args_ptr, off) as u32; off += 1;
    let title = unsafe { read_mem_str(args_ptr + off * 4, title_len) }; off += (title_len + 3) / 4;

    let desc_len = read_i32_word(args_ptr, off) as u32; off += 1;
    let desc = unsafe { read_mem_str(args_ptr + off * 4, desc_len) }; off += (desc_len + 3) / 4;

    let deposit = read_i64_word(args_ptr, off); off += 2;

    let msg_count = read_i32_word(args_ptr, off) as u32; off += 1;
    if msg_count > 16 { return -4; } // too many messages

    let caller = host_caller();
    let min_deposit = host_gov_param("govMinDeposit");
    if deposit < min_deposit { return -1; }

    if !bond_gov_tokens(&caller, deposit) { return -2; }

    let voting_period = host_gov_param("govVotingPeriod");
    let now = unsafe { block_number() } as i64;

    let id = next_proposal_id();
    set_i64(&key("proposal_status", id), STATUS_PROPOSED);
    set_i64(&key("proposal_proposer", id), 0);
    storage_write(&key("proposal_proposer", id), &caller);
    storage_write(&key("proposal_title", id), &title);
    storage_write(&key("proposal_desc", id), &desc);
    set_i64(&key("proposal_deposit", id), deposit);
    set_i64(&key("proposal_voting_start", id), now);
    set_i64(&key("proposal_voting_end", id), now + voting_period);
    set_i64(&key("proposal_yes_votes", id), 0);
    set_i64(&key("proposal_no_votes", id), 0);
    set_i64(&key("proposal_abstain_votes", id), 0);
    set_i64(&key("proposal_executed", id), 0);
    set_i64(&key("proposal_msg_count", id), msg_count as i64);

    for i in 0..msg_count {
        let msg_len = read_i32_word(args_ptr, off) as u32; off += 1;
        let msg = unsafe { read_mem_str(args_ptr + off * 4, msg_len) }; off += (msg_len + 3) / 4;
        storage_write(&format!("proposal_msg:{}:{}", id, i), &msg);
    }

    // Transition to voting immediately (or could have a delay)
    set_i64(&key("proposal_status", id), STATUS_VOTING);

    host_log(&format!("ProposalSubmitted id={} proposer={} deposit={}", id, caller, deposit));
    id as i32
}

/// 1: vote(proposal_id: i64, option: u8)
fn method_vote(args_ptr: u32) -> i32 {
    let proposal_id = read_i64_word(args_ptr, 0);
    let option = read_i32_word(args_ptr, 2) as u8;

    if !proposal_exists(proposal_id) { return -1; }

    let status = get_i64(&key("proposal_status", proposal_id));
    if status != STATUS_VOTING { return -2; }

    let now = unsafe { block_number() } as i64;
    let voting_end = get_i64(&key("proposal_voting_end", proposal_id));
    if now > voting_end { return -2; }

    let caller = host_caller();
    let vote_key = format!("vote:{}:{}", proposal_id, caller);
    if storage_read(&vote_key).is_some() { return 0; } // already voted

    let power = get_voting_power(&caller, 0);
    if power <= 0 { return -3; }

    match option {
        VOTE_YES => {
            let current = get_i64(&key("proposal_yes_votes", proposal_id));
            set_i64(&key("proposal_yes_votes", proposal_id), current + power);
        }
        VOTE_NO => {
            let current = get_i64(&key("proposal_no_votes", proposal_id));
            set_i64(&key("proposal_no_votes", proposal_id), current + power);
        }
        VOTE_ABSTAIN => {
            let current = get_i64(&key("proposal_abstain_votes", proposal_id));
            set_i64(&key("proposal_abstain_votes", proposal_id), current + power);
        }
        _ => return -4,
    }

    storage_write(&vote_key, &format!("{}", option));
    host_log(&format!("VoteCast proposal={} voter={} option={} power={}", proposal_id, caller, option, power));
    1
}

/// 2: end_voting(proposal_id: i64)
fn method_end_voting(args_ptr: u32) -> i32 {
    let proposal_id = read_i64_word(args_ptr, 0);
    if !proposal_exists(proposal_id) { return -1; }

    let status = get_i64(&key("proposal_status", proposal_id));
    if status != STATUS_VOTING { return 0; }

    let now = unsafe { block_number() } as i64;
    let voting_end = get_i64(&key("proposal_voting_end", proposal_id));
    if now <= voting_end { return 0; } // voting still open

    let yes = get_i64(&key("proposal_yes_votes", proposal_id));
    let no = get_i64(&key("proposal_no_votes", proposal_id));
    let abstain = get_i64(&key("proposal_abstain_votes", proposal_id));
    let total = yes + no + abstain;

    let quorum_threshold = host_gov_param("govQuorumThreshold");
    let pass_threshold = host_gov_param("govPassThreshold");

    // Quorum: total votes must exceed threshold
    if total < quorum_threshold {
        set_i64(&key("proposal_status", proposal_id), STATUS_FAILED);
        host_log(&format!("ProposalFailed id={} reason=quorum", proposal_id));
        return 1;
    }

    // Pass: yes votes must exceed pass_threshold % of total votes
    if fp_mul(yes, SCALE) > fp_mul(pass_threshold, total) {
        set_i64(&key("proposal_status", proposal_id), STATUS_PASSED);
        host_log(&format!("ProposalPassed id={} yes={} no={} abstain={}", proposal_id, yes, no, abstain));
        return 2;
    } else {
        set_i64(&key("proposal_status", proposal_id), STATUS_FAILED);
        host_log(&format!("ProposalFailed id={} reason=threshold", proposal_id));
        return 1;
    }
}

/// 3: execute_proposal(proposal_id: i64)
fn method_execute_proposal(args_ptr: u32) -> i32 {
    let proposal_id = read_i64_word(args_ptr, 0);
    if !proposal_exists(proposal_id) { return -1; }

    let status = get_i64(&key("proposal_status", proposal_id));
    if status == STATUS_EXECUTED { return -2; }
    if status != STATUS_PASSED { return 0; }

    let msg_count = get_i64(&key("proposal_msg_count", proposal_id)) as u32;
    let mut all_ok = true;

    for i in 0..msg_count {
        let msg = storage_read(&format!("proposal_msg:{}:{}", proposal_id, i)).unwrap_or_default();
        if !execute_message(&msg, proposal_id) {
            all_ok = false;
            host_log(&format!("ProposalExecFail id={} msg={}", proposal_id, i));
            // Continue executing remaining messages even if one fails
        }
    }

    set_i64(&key("proposal_status", proposal_id), STATUS_EXECUTED);
    set_i64(&key("proposal_executed", proposal_id), unsafe { block_number() } as i64);

    // Return deposit to proposer
    let proposer = storage_read(&key("proposal_proposer", proposal_id)).unwrap_or_default();
    let deposit = get_i64(&key("proposal_deposit", proposal_id));
    if !proposer.is_empty() && deposit > 0 {
        let _ = unsafe { payout(proposer.as_ptr(), proposer.len() as u32, deposit) };
    }

    host_log(&format!("ProposalExecuted id={} all_ok={}", proposal_id, all_ok));
    if all_ok { 1 } else { -3 }
}

/// 4: deposit(proposal_id: i64, amount_fp: i64)
fn method_deposit(args_ptr: u32) -> i32 {
    let proposal_id = read_i64_word(args_ptr, 0);
    let amount = read_i64_word(args_ptr, 2);

    if !proposal_exists(proposal_id) { return -1; }

    let min_deposit = host_gov_param("govMinDeposit");
    if amount < min_deposit { return -2; }

    let caller = host_caller();
    if !bond_gov_tokens(&caller, amount) { return -2; }

    let current = get_i64(&key("proposal_deposit", proposal_id));
    set_i64(&key("proposal_deposit", proposal_id), current + amount);

    host_log(&format!("ProposalDeposit id={} addr={} amount={}", proposal_id, caller, amount));
    1
}

/// 5: cancel_proposal(proposal_id: i64)
fn method_cancel_proposal(args_ptr: u32) -> i32 {
    let proposal_id = read_i64_word(args_ptr, 0);
    if !proposal_exists(proposal_id) { return -1; }

    let status = get_i64(&key("proposal_status", proposal_id));
    if status != STATUS_PROPOSED && status != STATUS_VOTING {
        return -2; // already active (passed/failed/executed)
    }

    let caller = host_caller();
    let proposer = storage_read(&key("proposal_proposer", proposal_id)).unwrap_or_default();
    if proposer != caller { return 0; }

    set_i64(&key("proposal_status", proposal_id), STATUS_CANCELLED);

    // Return deposit
    let deposit = get_i64(&key("proposal_deposit", proposal_id));
    if deposit > 0 {
        let _ = unsafe { payout(caller.as_ptr(), caller.len() as u32, deposit) };
    }

    host_log(&format!("ProposalCancelled id={} by={}", proposal_id, caller));
    1
}

/// 6: get_proposal(proposal_id: i64)
fn method_get_proposal(args_ptr: u32) -> i32 {
    let id = read_i64_word(args_ptr, 0);
    if !proposal_exists(id) { return -1; }

    let proposer = storage_read(&key("proposal_proposer", id)).unwrap_or_default();
    let title = storage_read(&key("proposal_title", id)).unwrap_or_default();
    let desc = storage_read(&key("proposal_desc", id)).unwrap_or_default();
    let status = get_i64(&key("proposal_status", id));
    let deposit = get_i64(&key("proposal_deposit", id));
    let voting_start = get_i64(&key("proposal_voting_start", id));
    let voting_end = get_i64(&key("proposal_voting_end", id));
    let yes = get_i64(&key("proposal_yes_votes", id));
    let no = get_i64(&key("proposal_no_votes", id));
    let abstain = get_i64(&key("proposal_abstain_votes", id));
    let executed = get_i64(&key("proposal_executed", id));
    let msg_count = get_i64(&key("proposal_msg_count", id));

    let json = format!(
        "{{\"id\":{},\"proposer\":\"{}\",\"title\":\"{}\",\"desc\":\"{}\",\"status\":{},\"deposit\":{},\"voting_start\":{},\"voting_end\":{},\"yes\":{},\"no\":{},\"abstain\":{},\"executed\":{},\"msg_count\":{}}}",
        id, proposer, title, desc, status, deposit, voting_start, voting_end, yes, no, abstain, executed, msg_count
    );
    storage_write("query_result", &json);
    1
}

/// 7: get_vote(proposal_id: i64, voter_addr_len: u32, voter_addr[10 words])
fn method_get_vote(args_ptr: u32) -> i32 {
    let proposal_id = read_i64_word(args_ptr, 0);
    let voter = read_addr(args_ptr, 2);

    let vote_key = format!("vote:{}:{}", proposal_id, voter);
    let vote_opt = storage_read(&vote_key).unwrap_or_default();
    let power = get_voting_power(&voter, 0);

    let json = format!(
        "{{\"proposal_id\":{},\"voter\":\"{}\",\"option\":{},\"power\":{}}}",
        proposal_id, voter,
        if vote_opt.is_empty() { 0 } else { vote_opt.parse::<i64>().unwrap_or(0) },
        power
    );
    storage_write("query_result", &json);
    1
}

/// 8: get_capabilities()
fn method_get_capabilities(_args_ptr: u32) -> i32 {
    0x1FF // bits 0-8: all methods
}

// ── exports ──────────────────────────────────────────────────────────────────
#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let layout = core::alloc::Layout::from_size_align(size.max(1) as usize, 8).unwrap();
    let ptr = unsafe { alloc::alloc::alloc(layout) };
    ptr as u32
}

#[no_mangle]
pub extern "C" fn call(method_id: i32, args_ptr: u32, _args_len: u32) -> i32 {
    match method_id {
        0 => method_submit_proposal(args_ptr),
        1 => method_vote(args_ptr),
        2 => method_end_voting(args_ptr),
        3 => method_execute_proposal(args_ptr),
        4 => method_deposit(args_ptr),
        5 => method_cancel_proposal(args_ptr),
        6 => method_get_proposal(args_ptr),
        7 => method_get_vote(args_ptr),
        8 => method_get_capabilities(args_ptr),
        _ => -99,
    }
}
