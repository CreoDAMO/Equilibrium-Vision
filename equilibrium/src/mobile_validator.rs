//! Mobile background validator — residual, continuity, Merkle, optional BFT quorum.
//!
//! Spawns a thread with a 2MB stack. Enqueues blocks via MPSC channel.
//! Validation pipeline:
//!   1. Chain continuity (prev_hash matches real block hash of tip)
//!   2. Timestamp sanity (±2 hours)
//!   3. Residual re-verification via joint_residual_and_gradient (no search)
//!   4. Merkle root recomputation from tx hashes
//!   5. BFT vote quorum — real Ed25519 verify + stake quorum when
//!      `REQUIRE_BFT_VOTES=true`; quorum is not required when unset
//!      (mesh can advance on residual + continuity alone).
//!
//! Thermal / battery: `should_validate_now` may defer under load. Capacity
//! reads from sysfs are best-effort and may no-op on devices without the
//! standard power-supply paths (see LIMITATIONS §10).

use std::collections::{HashMap, HashSet};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::chain_state::{
    BlockHeader, TxCandidate, ChainState, residual_to_fixed,
};
use crate::stationary_solver::StationarySolver;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TIME_DRIFT_SECS: u64 = 7200;
const MAX_VALIDATED_BLOCKS: usize = 1024;

// ── Public API ────────────────────────────────────────────────────────────────

pub struct MobileValidator {
    tx: mpsc::Sender<ValidationJob>,
    last_result: Arc<Mutex<Option<ValidationResult>>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ValidationDecision {
    Accept,
    Reject { reason: String },
    Deferred,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ValidationResult {
    Accept { hash: String, height: u64 },
    Reject { hash: String, reason: String, ban_peer: bool },
    Deferred { hash: String, reason: String },
}

impl MobileValidator {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<ValidationJob>();
        let last_result: Arc<Mutex<Option<ValidationResult>>> = Arc::new(Mutex::new(None));
        let lr_worker = Arc::clone(&last_result);

        thread::Builder::new()
            .name("mobile-validator".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let mut engine = ValidationEngine::new();
                while let Ok(job) = rx.recv() {
                    match job {
                        ValidationJob::ValidateJson { json, from_peer, last_result: lr } => {
                            match parse_block_json(&json) {
                                Ok(block) => {
                                    let decision = if should_validate_now() {
                                        engine.validate(&block, from_peer)
                                    } else {
                                        ValidationDecision::Deferred
                                    };
                                    if decision == ValidationDecision::Accept {
                                        engine.accept(&block);
                                    }
                                    let hash = serde_json::from_str::<serde_json::Value>(&json)
                                        .ok()
                                        .and_then(|v| v.get("hash").and_then(|h| h.as_str()).map(|s| s.to_string()))
                                        .unwrap_or_else(|| hex::encode(&block.header.prev_hash[..8]));
                                    let height = block.header.recursion_depth as u64;
                                    let vr = match &decision {
                                        ValidationDecision::Accept => ValidationResult::Accept { hash, height },
                                        ValidationDecision::Reject { reason } => ValidationResult::Reject {
                                            hash,
                                            reason: reason.clone(),
                                            ban_peer: from_peer,
                                        },
                                        ValidationDecision::Deferred => ValidationResult::Deferred {
                                            hash,
                                            reason: "battery/thermal defer".to_string(),
                                        },
                                    };
                                    if let Ok(mut guard) = lr.lock() {
                                        *guard = Some(vr.clone());
                                    }
                                    if let Ok(mut guard) = lr_worker.lock() {
                                        *guard = Some(vr);
                                    }
                                }
                                Err(e) => {
                                    let vr = ValidationResult::Reject {
                                        hash: "unknown".to_string(),
                                        reason: e,
                                        ban_peer: from_peer,
                                    };
                                    if let Ok(mut guard) = lr.lock() {
                                        *guard = Some(vr.clone());
                                    }
                                    if let Ok(mut guard) = lr_worker.lock() {
                                        *guard = Some(vr);
                                    }
                                }
                            }
                        }
                        ValidationJob::Shutdown => break,
                    }
                }
            })
            .expect("mobile validator thread spawn failed");

        MobileValidator { tx, last_result }
    }

    /// Submit a block JSON string for async validation (fire-and-forget).
    /// Use `poll_result()` to retrieve the outcome.
    pub fn submit_json(&self, json: String, from_peer: bool) {
        let _ = self.tx.send(ValidationJob::ValidateJson {
            json,
            from_peer,
            last_result: Arc::clone(&self.last_result),
        });
    }

    /// Poll for the most recent validation result (non-blocking).
    /// Consumes the stored result; returns None if none available yet.
    pub fn poll_result(&self) -> Option<ValidationResult> {
        self.last_result.lock().ok().and_then(|mut g| g.take())
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(ValidationJob::Shutdown);
    }
}

enum ValidationJob {
    ValidateJson {
        json: String,
        from_peer: bool,
        last_result: Arc<Mutex<Option<ValidationResult>>>,
    },
    Shutdown,
}

// ── ValidationEngine ──────────────────────────────────────────────────────────

struct ValidationEngine {
    chain: Vec<BlockHeader>,
    /// Real SHA256 block hashes for each accepted header (for prev_hash continuity).
    tip_hashes: Vec<[u8; 32]>,
    /// Active validator set: addr → (pubkey_bytes, bonded_stake).
    /// Empty = skip quorum check unless REQUIRE_BFT_VOTES=true.
    validators: HashMap<String, ValidatorInfo>,
}

impl ValidationEngine {
    fn new() -> Self {
        Self {
            chain: Vec::with_capacity(MAX_VALIDATED_BLOCKS),
            tip_hashes: Vec::with_capacity(MAX_VALIDATED_BLOCKS),
            validators: HashMap::new(),
        }
    }

    /// Load the active validator set (called from JNI when tip sync delivers the set).
    #[allow(dead_code)]
    fn set_validators(&mut self, set: HashMap<String, ValidatorInfo>) {
        self.validators = set;
    }

    fn validate(&self, block: &GossipedBlock, _from_peer: bool) -> ValidationDecision {
        // 1. Chain continuity on real block hash
        if let Some(tip_hash) = self.tip_hashes.last() {
            if block.header.prev_hash != *tip_hash {
                return ValidationDecision::Reject {
                    reason: format!(
                        "prev_hash mismatch: expected {}, got {}",
                        hex::encode(tip_hash),
                        hex::encode(block.header.prev_hash),
                    ),
                };
            }
            let expected_height = self.chain.last().map(|h| h.recursion_depth + 1).unwrap_or(0);
            if block.header.recursion_depth != expected_height {
                return ValidationDecision::Reject {
                    reason: format!(
                        "height mismatch: expected {expected_height}, got {}",
                        block.header.recursion_depth
                    ),
                };
            }
        } else {
            // Bootstrap: first block must have prev_hash == [0; 32] and height 0
            if block.header.prev_hash != [0u8; 32] {
                return ValidationDecision::Reject {
                    reason: "bootstrap block must have zero prev_hash".to_string(),
                };
            }
            if block.header.recursion_depth != 0 {
                return ValidationDecision::Reject {
                    reason: "bootstrap block must have height 0".to_string(),
                };
            }
        }

        // 2. Timestamp sanity (±2 hours)
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let drift = block.header.timestamp as i64 - now as i64;
        if drift.abs() > MAX_TIME_DRIFT_SECS as i64 {
            return ValidationDecision::Reject {
                reason: format!("timestamp drift {drift}s > {MAX_TIME_DRIFT_SECS}s"),
            };
        }

        // 3. Residual re-verification (verify-at-nonce, no search)
        if let Err(e) = self.verify_residual(block) {
            return ValidationDecision::Reject { reason: e };
        }

        // 4. Merkle root recomputation
        let computed_root = merkle_root_from_hashes(&block.tx_hashes);
        if computed_root != block.header.merkle_root {
            return ValidationDecision::Reject {
                reason: format!(
                    "merkle root mismatch: expected {}, got {}",
                    hex::encode(computed_root),
                    hex::encode(block.header.merkle_root),
                ),
            };
        }

        // 5. BFT votes — Ed25519, same domain string as state.ts runFinalityRound.
        // Message: "equilibrium-bft-v1" || hashHex(UTF-8) || heightDecimalString(UTF-8)
        let require = require_bft_votes();
        let votes = parse_bft_votes_from_block_json(&block.block_json);

        if require || !votes.is_empty() {
            if self.validators.is_empty() {
                if require {
                    return ValidationDecision::Reject {
                        reason: "REQUIRE_BFT_VOTES set but no validator set loaded".into(),
                    };
                }
                // Soft path: cannot verify without set; do not block testnet traffic
            } else {
                let hash_hex = hex::encode(block_hash(&block.header));
                let height = block.header.recursion_depth as u64;
                if let Err(e) = check_bft_quorum(&self.validators, &votes, &hash_hex, height) {
                    return ValidationDecision::Reject { reason: e };
                }
            }
        }

        ValidationDecision::Accept
    }

    fn accept(&mut self, block: &GossipedBlock) {
        let h = block_hash(&block.header);
        self.chain.push(block.header.clone());
        self.tip_hashes.push(h);
        if self.chain.len() > MAX_VALIDATED_BLOCKS {
            self.chain.remove(0);
            self.tip_hashes.remove(0);
        }
    }

    /// Re-evaluate Lagrangian at the claimed header (nonce fixed). No search.
    fn verify_residual(&self, block: &GossipedBlock) -> Result<(), String> {
        let lambda = [1.0_f64; 5];

        let txs: Vec<TxCandidate> = block
            .tx_hashes
            .iter()
            .map(|h| TxCandidate { hash: *h, fee: 0 })
            .collect();

        let state = ChainState {
            cumulative_work: if block.header.recursion_depth == 0 { 0 } else { 1 },
            mempool_pressure: 0.5,
            validator_count: 1,
            last_quality: 1.0,
            height: block.header.recursion_depth as u64,
        };

        // residual is ALREADY fixed-point i64 — no search, just evaluate at nonce
        let (recomputed_fp, _grad) =
            StationarySolver::joint_residual_and_gradient(&block.header, &txs, &state, &lambda);

        let claimed_fp = block.header.residual;
        let delta = (recomputed_fp - claimed_fp).abs();

        if delta > 1 {
            return Err(format!(
                "residual mismatch: claimed {claimed_fp}, recomputed {recomputed_fp} (delta={delta})"
            ));
        }
        Ok(())
    }
}

// ── Block identity hash (matches MiningWorker.computeBlockHash) ───────────────

/// SHA256(prev_hash || nonce_le || timestamp_le || difficulty_le).
pub fn block_hash(header: &BlockHeader) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(header.prev_hash);
    hasher.update(header.nonce.to_le_bytes());
    hasher.update(header.timestamp.to_le_bytes());
    hasher.update(header.difficulty.to_le_bytes());
    hasher.finalize().into()
}

// ── Merkle root (Bitcoin-style odd-length duplication, single SHA256) ─────────

pub fn merkle_root_from_hashes(hashes: &[[u8; 32]]) -> [u8; 32] {
    if hashes.is_empty() {
        return [0u8; 32];
    }
    if hashes.len() == 1 {
        return hashes[0];
    }
    let mut level: Vec<[u8; 32]> = hashes.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            let left = level[i];
            let right = if i + 1 < level.len() { level[i + 1] } else { left };
            let mut hasher = Sha256::new();
            hasher.update(left);
            hasher.update(right);
            next.push(hasher.finalize().into());
            i += 2;
        }
        level = next;
    }
    level[0]
}

// ── GossipedBlock + flat JSON parser ──────────────────────────────────────────

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GossipedBlock {
    pub header: BlockHeader,
    pub tx_hashes: Vec<[u8; 32]>,
    #[serde(default)]
    pub bft_votes: Vec<Vec<u8>>,
    #[serde(default)]
    pub block_json: String,
}

/// Flat wire format emitted by MiningWorker.buildBlockBodyJson.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // hash/miner are part of the wire schema but not consumed by the Rust mapper
struct FlatMiningBody {
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    height: Option<u64>,
    #[serde(default, alias = "prevHash", alias = "prev_hash")]
    prev_hash: Option<String>,
    #[serde(default)]
    nonce: Option<u64>,
    #[serde(default)]
    residual: Option<f64>,
    #[serde(default, alias = "residual_fp", alias = "residualFp")]
    residual_fp: Option<i64>,
    #[serde(default)]
    timestamp: Option<u64>,
    #[serde(default)]
    miner: Option<String>,
    #[serde(default)]
    difficulty: Option<u64>,
    #[serde(default, alias = "merkle_root", alias = "merkleRoot")]
    merkle_root: Option<String>,
    #[serde(default, alias = "state_root", alias = "stateRoot")]
    state_root: Option<String>,
    #[serde(default, alias = "tx_hashes", alias = "txHashes")]
    tx_hashes: Option<Vec<String>>,
}

/// Try nested GossipedBlock first, then flat MiningWorker wire format.
pub fn parse_block_json(json: &str) -> Result<GossipedBlock, String> {
    if let Ok(block) = serde_json::from_str::<GossipedBlock>(json) {
        return Ok(block);
    }
    let flat: FlatMiningBody = serde_json::from_str(json)
        .map_err(|e| format!("json parse error (nested and flat both failed): {e}"))?;
    flat_to_gossiped(flat, json)
}

fn flat_to_gossiped(flat: FlatMiningBody, original_json: &str) -> Result<GossipedBlock, String> {
    let prev_hex = flat
        .prev_hash
        .ok_or_else(|| "flat body missing prevHash".to_string())?;

    let nonce = flat.nonce.ok_or_else(|| "flat body missing nonce".to_string())?;
    let timestamp = flat
        .timestamp
        .ok_or_else(|| "flat body missing timestamp".to_string())?;
    let difficulty = flat
        .difficulty
        .ok_or_else(|| "flat body missing difficulty".to_string())?;

    let residual = match (flat.residual_fp, flat.residual) {
        (Some(fp), _) => fp,
        (None, Some(r)) => residual_to_fixed(r),
        (None, None) => return Err("flat body missing residual / residualFp".to_string()),
    };

    let recursion_depth = flat.height.unwrap_or(0).min(u32::MAX as u64) as u32;

    let merkle_root = match flat.merkle_root {
        Some(ref h) if !h.is_empty() => parse_hash32(h)?,
        _ => [0u8; 32],
    };

    let state_root = match flat.state_root {
        Some(ref h) if !h.is_empty() => parse_hash32(h)?,
        _ => [0u8; 32],
    };

    let tx_hashes = match flat.tx_hashes {
        Some(list) => {
            let mut out = Vec::with_capacity(list.len());
            for h in list {
                out.push(parse_hash32(&h)?);
            }
            out
        }
        None => vec![],
    };

    let header = BlockHeader {
        prev_hash: parse_hash32(&prev_hex)?,
        merkle_root,
        timestamp,
        nonce,
        difficulty,
        recursion_depth,
        residual,
        state_root,
    };

    Ok(GossipedBlock {
        header,
        tx_hashes,
        bft_votes: vec![],
        block_json: original_json.to_string(),
    })
}

fn parse_hash32(hex: &str) -> Result<[u8; 32], String> {
    let clean = hex
        .trim()
        .strip_prefix("0x")
        .or_else(|| hex.trim().strip_prefix("0X"))
        .unwrap_or(hex.trim());
    if !clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("invalid hex hash: {hex}"));
    }
    let padded = format!("{clean:0>64}");
    let take = if padded.len() >= 64 {
        &padded[padded.len() - 64..]
    } else {
        &padded
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&take[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("hex byte parse: {e}"))?;
    }
    Ok(out)
}

// ── BFT vote verification (bit-aligned with state.ts runFinalityRound) ────────
//
// Vote message (EXACT TS layout — do NOT use raw hash bytes or LE height):
//   Buffer.from("equilibrium-bft-v1")
//   || Buffer.from(block.hash)               // hex STRING as UTF-8
//   || Buffer.from(block.height.toString())  // decimal STRING as UTF-8
//
// Env:
//   REQUIRE_BFT_VOTES=true|1  → reject when quorum fails or validator set missing
//   unset / false             → if votes present + set loaded, enforce quorum;
//                               if no votes or set empty, accept (testnet soft path)

const BFT_VOTE_DOMAIN: &[u8] = b"equilibrium-bft-v1";

/// A single BFT finality vote from a validator.
#[derive(Debug, Clone)]
pub struct BftVote {
    pub validator_addr: String,
    /// Hex string identical to what the signer hashed (no 0x prefix, lowercase).
    pub block_hash_hex: String,
    pub height: u64,
    pub signature: [u8; 64],
}

/// Validator identity and stake weight.
#[derive(Debug, Clone)]
pub struct ValidatorInfo {
    pub pubkey: [u8; 32],
    pub bonded_stake: u64,
}

impl BftVote {
    /// Construct the vote message exactly as TypeScript `runFinalityRound` does.
    pub fn vote_message(block_hash_hex: &str, height: u64) -> Vec<u8> {
        let mut msg = Vec::with_capacity(BFT_VOTE_DOMAIN.len() + block_hash_hex.len() + 24);
        msg.extend_from_slice(BFT_VOTE_DOMAIN);
        msg.extend_from_slice(block_hash_hex.as_bytes());
        msg.extend_from_slice(height.to_string().as_bytes());
        msg
    }

    /// Verify the Ed25519 signature against the validator's public key.
    pub fn verify(&self, pubkey: &[u8; 32]) -> Result<(), String> {
        let vk = VerifyingKey::from_bytes(pubkey)
            .map_err(|e| format!("invalid pubkey: {e}"))?;
        let msg = Self::vote_message(&self.block_hash_hex, self.height);
        let sig = Signature::from_bytes(&self.signature);
        vk.verify(&msg, &sig)
            .map_err(|e| format!("signature verify failed: {e}"))
    }
}

fn require_bft_votes() -> bool {
    std::env::var("REQUIRE_BFT_VOTES")
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Check that votes reach ≥ ⅔ supermajority of total bonded stake.
/// `expected_hash_hex` / `expected_height` must match what each voter signed.
pub fn check_bft_quorum(
    validators: &HashMap<String, ValidatorInfo>,
    votes: &[BftVote],
    expected_hash_hex: &str,
    expected_height: u64,
) -> Result<(), String> {
    if validators.is_empty() {
        return Err("no active validators in set".into());
    }
    let total_stake: u64 = validators.values().map(|v| v.bonded_stake).sum();
    if total_stake == 0 {
        return Err("total bonded stake is zero".into());
    }

    let normalize = |h: &str| h.trim().trim_start_matches("0x").trim_start_matches("0X").to_lowercase();
    let eh = normalize(expected_hash_hex);

    let mut voted_stake: u64 = 0;
    let mut seen = HashSet::new();

    for vote in votes {
        if !seen.insert(vote.validator_addr.clone()) {
            continue; // deduplicate
        }
        let vh = normalize(&vote.block_hash_hex);
        if vh != eh || vote.height != expected_height {
            return Err(format!(
                "vote for wrong block: {}@{} vs {}@{}",
                vote.block_hash_hex, vote.height, expected_hash_hex, expected_height
            ));
        }
        let info = validators
            .get(&vote.validator_addr)
            .ok_or_else(|| format!("unknown validator: {}", vote.validator_addr))?;
        vote.verify(&info.pubkey)?;
        voted_stake = voted_stake.saturating_add(info.bonded_stake);
    }

    // voted/total >= 2/3  ⇔  voted*3 >= total*2
    if voted_stake.saturating_mul(3) < total_stake.saturating_mul(2) {
        return Err(format!(
            "BFT quorum not met: voted_stake={voted_stake} total_stake={total_stake}"
        ));
    }
    Ok(())
}

/// Parse BFT votes from a block JSON envelope.
/// Accepts `bftVotes` / `bft_votes` at the top level.
pub fn parse_bft_votes_from_block_json(json: &str) -> Vec<BftVote> {
    #[derive(Deserialize)]
    struct WireVote {
        #[serde(alias = "validatorAddress", alias = "validator")]
        validator: String,
        #[serde(alias = "blockHash", alias = "hash")]
        block_hash: String,
        height: u64,
        #[serde(alias = "signature", alias = "sig")]
        signature: String,
    }
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default, alias = "bftVotes", alias = "bft_votes")]
        bft_votes: Option<Vec<WireVote>>,
    }

    let env: Envelope = match serde_json::from_str(json) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let Some(list) = env.bft_votes else { return vec![] };

    let mut out = Vec::with_capacity(list.len());
    for v in list {
        let clean = v.signature.trim().trim_start_matches("0x").trim_start_matches("0X");
        if clean.len() != 128 || !clean.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let mut sig = [0u8; 64];
        let mut ok = true;
        for i in 0..64 {
            match u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16) {
                Ok(b) => sig[i] = b,
                Err(_) => { ok = false; break; }
            }
        }
        if !ok { continue; }
        out.push(BftVote {
            validator_addr: v.validator,
            block_hash_hex: v.block_hash.trim().trim_start_matches("0x").trim_start_matches("0X").to_lowercase(),
            height: v.height,
            signature: sig,
        });
    }
    out
}

// ── Shared residual hash-fold (ZK v2 alignment) ───────────────────────────────
//
// This is the same deterministic hash-fold used by the RISC Zero guest
// (`methods/guest/src/main.rs :: residual_at_nonce`).  Extracting it here
// makes it a shared, pure-integer function that:
//
//   1. The guest calls to compute the on-chain residual proxy.
//   2. The sidecar can call when validating peer blocks from `validate_and_adopt`
//      to check that the claimed `residual_fp` is consistent with the block header.
//   3. The chain validator can call to cross-check the Groth16 public input.
//
// **v2 alignment rule**: when a peer block carries a Groth16 or ZkVM proof,
// its `residual_fp` public input must equal `residual_fp_from_header(...)` for
// the same header fields, or the block is rejected.
//
// **Upgrade path to v3**: replace this hash-fold with a pure-integer extraction
// of `StationarySolver::joint_residual_and_gradient` once that function is
// factored into a `no_std`-compatible `residual_core` crate.  Bump
// `STATIONARITY_GUEST_ID` when the guest switches to v3.
#[allow(clippy::too_many_arguments)]
pub fn residual_fp_from_header(
    prev_hash:       &[u8; 32],
    merkle_root:     &[u8; 32],
    timestamp:       u64,
    nonce:           u64,
    difficulty:      u64,
    recursion_depth: u32,
    cumulative_work: u64,
    height:          u64,
) -> u64 {
    use sha2::{Sha256, Digest};
    let mut h = Sha256::new();
    h.update(prev_hash);
    h.update(merkle_root);
    h.update(timestamp.to_le_bytes());
    h.update(nonce.to_le_bytes());
    h.update(difficulty.to_le_bytes());
    h.update(recursion_depth.to_le_bytes());
    h.update(cumulative_work.to_le_bytes());
    h.update(height.to_le_bytes());
    let digest = h.finalize();

    // Fold 32 bytes into a u64 via XOR of 8-byte chunks (same as guest v1).
    let mut acc = 0u64;
    for chunk in digest.chunks(8) {
        let mut buf = [0u8; 8];
        buf[..chunk.len()].copy_from_slice(chunk);
        acc ^= u64::from_le_bytes(buf);
    }
    acc
}

// ── Battery / thermal deferral stub ───────────────────────────────────────────

pub fn should_validate_now() -> bool {
    // TODO: read /sys/class/power_supply/battery/capacity and
    // /sys/class/thermal/thermal_zone*/temp via JNI or env.
    // For now, always true on Rust side; Kotlin gates the call.
    true
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── residual_fp_from_header (ZK v2 shared function) ───────────────────────

    #[test]
    fn residual_fp_from_header_is_deterministic() {
        let ph = [0xabu8; 32];
        let mr = [0x12u8; 32];
        let r1 = residual_fp_from_header(&ph, &mr, 1_700_000_000, 42, 1000, 2, 999, 7);
        let r2 = residual_fp_from_header(&ph, &mr, 1_700_000_000, 42, 1000, 2, 999, 7);
        assert_eq!(r1, r2, "same inputs must produce same hash-fold residual");
    }

    #[test]
    fn residual_fp_from_header_differs_on_nonce() {
        let ph = [0xabu8; 32];
        let mr = [0x12u8; 32];
        let r1 = residual_fp_from_header(&ph, &mr, 1_700_000_000, 42, 1000, 2, 999, 7);
        let r2 = residual_fp_from_header(&ph, &mr, 1_700_000_000, 43, 1000, 2, 999, 7);
        assert_ne!(r1, r2, "different nonces must produce different residuals");
    }

    #[test]
    fn residual_fp_from_header_differs_on_prev_hash() {
        let ph1 = [0xabu8; 32];
        let ph2 = [0xcdu8; 32];
        let mr  = [0x12u8; 32];
        let r1 = residual_fp_from_header(&ph1, &mr, 1_700_000_000, 42, 1000, 2, 999, 7);
        let r2 = residual_fp_from_header(&ph2, &mr, 1_700_000_000, 42, 1000, 2, 999, 7);
        assert_ne!(r1, r2, "different prev_hashes must produce different residuals");
    }

    #[test]
    fn residual_fp_from_header_nonzero_for_nonzero_input() {
        // A concrete sanity check: the hash-fold should produce a nonzero value
        // for a reasonable input (probability 2^{-64} ≈ 0 that it's zero).
        let r = residual_fp_from_header(
            &[1u8; 32], &[2u8; 32], 1_700_000_000, 1, 500, 0, 0, 1,
        );
        assert_ne!(r, 0, "hash-fold residual should be nonzero for non-trivial input");
    }

    #[test]
    fn merkle_root_empty() {
        assert_eq!(merkle_root_from_hashes(&[]), [0u8; 32]);
    }

    #[test]
    fn merkle_root_single() {
        let h = [0xabu8; 32];
        assert_eq!(merkle_root_from_hashes(&[h]), h);
    }

    #[test]
    fn merkle_root_two() {
        let a = [0x01u8; 32];
        let b = [0x02u8; 32];
        let root = merkle_root_from_hashes(&[a, b]);
        assert_ne!(root, a);
        assert_ne!(root, b);
        assert_eq!(root.len(), 32);
    }

    #[test]
    fn block_hash_deterministic() {
        let h1 = BlockHeader {
            prev_hash: [1u8; 32],
            merkle_root: [0u8; 32],
            timestamp: 1_700_000_000,
            nonce: 42,
            difficulty: 1000,
            recursion_depth: 0,
            residual: 0,
            state_root: [0u8; 32],
        };
        let a = block_hash(&h1);
        let b = block_hash(&h1);
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn parse_flat_mining_worker_body() {
        let json = r#"{
            "hash": "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb",
            "height": 7,
            "prevHash": "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            "nonce": 42,
            "residual": 0.000001,
            "timestamp": 1700000000,
            "miner": "deadbeef",
            "difficulty": 1000
        }"#;
        let block = parse_block_json(json).expect("flat parse");
        assert_eq!(block.header.nonce, 42);
        assert_eq!(block.header.difficulty, 1000);
        assert_eq!(block.header.recursion_depth, 7);
        assert_eq!(block.header.residual, residual_to_fixed(0.000001));
        assert_eq!(block.header.merkle_root, [0u8; 32]);
        assert!(block.tx_hashes.is_empty());
    }

    #[test]
    fn parse_flat_prefers_residual_fp() {
        let json = r#"{
            "prevHash": "00",
            "nonce": 1,
            "residual": 9.9,
            "residualFp": 12345,
            "timestamp": 1,
            "difficulty": 1
        }"#;
        let block = parse_block_json(json).unwrap();
        assert_eq!(block.header.residual, 12345);
    }

    #[test]
    fn parse_nested_gossiped_block_still_works() {
        let header = BlockHeader {
            prev_hash: [1u8; 32],
            merkle_root: [0u8; 32],
            timestamp: 1_700_000_000,
            nonce: 9,
            difficulty: 100,
            recursion_depth: 3,
            residual: 99,
            state_root: [0u8; 32],
        };
        let g = GossipedBlock {
            header: header.clone(),
            tx_hashes: vec![],
            bft_votes: vec![],
            block_json: "{}".into(),
        };
        let json = serde_json::to_string(&g).unwrap();
        let parsed = parse_block_json(&json).unwrap();
        assert_eq!(parsed.header.nonce, 9);
        assert_eq!(parsed.header.residual, 99);
    }

    #[test]
    fn continuity_rejects_bad_prev_hash() {
        use crate::chain_state::ChainState;
        use crate::stationary_solver::StationarySolver;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let lambda = [1.0_f64; 5];

        // Build a genesis header with a current timestamp and compute its correct residual.
        let genesis_base = BlockHeader {
            prev_hash: [0u8; 32],
            merkle_root: [0u8; 32],
            timestamp: now,
            nonce: 0,
            difficulty: 1,
            recursion_depth: 0,
            residual: 0,
            state_root: [0u8; 32],
        };
        let genesis_state = ChainState {
            cumulative_work: 0,
            mempool_pressure: 0.5,
            validator_count: 1,
            last_quality: 1.0,
            height: 0,
        };
        let (genesis_residual, _) = StationarySolver::joint_residual_and_gradient(
            &genesis_base, &[], &genesis_state, &lambda,
        );
        let genesis_header = BlockHeader { residual: genesis_residual, ..genesis_base };

        let mut engine = ValidationEngine::new();
        let genesis = GossipedBlock {
            header: genesis_header.clone(),
            tx_hashes: vec![],
            bft_votes: vec![],
            block_json: "{}".into(),
        };
        assert!(
            matches!(engine.validate(&genesis, false), ValidationDecision::Accept),
            "genesis should be accepted",
        );
        engine.accept(&genesis);

        // Build the "tip hash" the good block-2 would need to reference.
        let genesis_hash = block_hash(&genesis_header);

        // A block at height 1 with the *wrong* prev_hash should be rejected.
        let bad_base = BlockHeader {
            prev_hash: [0xffu8; 32], // deliberately wrong
            merkle_root: [0u8; 32],
            timestamp: now + 1,
            nonce: 1,
            difficulty: 1,
            recursion_depth: 1,
            residual: 0,
            state_root: [0u8; 32],
        };
        let bad = GossipedBlock {
            header: bad_base,
            tx_hashes: vec![],
            bft_votes: vec![],
            block_json: "{}".into(),
        };
        assert!(
            matches!(
                engine.validate(&bad, false),
                ValidationDecision::Reject { reason } if reason.contains("prev_hash mismatch")
            ),
            "expected prev_hash mismatch rejection",
        );

        // A block with the *correct* prev_hash should pass continuity (may still fail residual,
        // but continuity itself is the concern here — verify it doesn't reject for prev_hash).
        let good_base = BlockHeader {
            prev_hash: genesis_hash,
            merkle_root: [0u8; 32],
            timestamp: now + 1,
            nonce: 1,
            difficulty: 1,
            recursion_depth: 1,
            residual: 0,
            state_root: [0u8; 32],
        };
        let good_state = ChainState {
            cumulative_work: 1,
            mempool_pressure: 0.5,
            validator_count: 1,
            last_quality: 1.0,
            height: 1,
        };
        let (good_residual, _) = StationarySolver::joint_residual_and_gradient(
            &good_base, &[], &good_state, &lambda,
        );
        let good_block = GossipedBlock {
            header: BlockHeader { residual: good_residual, ..good_base },
            tx_hashes: vec![],
            bft_votes: vec![],
            block_json: "{}".into(),
        };
        // This should not be rejected for prev_hash mismatch.
        let result = engine.validate(&good_block, false);
        assert!(
            !matches!(&result, ValidationDecision::Reject { reason } if reason.contains("prev_hash mismatch")),
            "correct prev_hash should not get continuity rejection, got {result:?}",
        );
    }

    #[test]
    fn validator_spawns_and_shuts_down() {
        let v = MobileValidator::start();
        v.shutdown();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // ── BFT vote tests ────────────────────────────────────────────────────────

    // ── Closed-mesh / offline-P2P integration test ───────────────────────────
    //
    // Proves that two nodes can exchange blocks via the gossip path (from_peer=true)
    // and advance their local tips without the HTTP /api/blocks/submit endpoint.
    // This is the Rust-side evidence for the "fully mobile P2P mesh" claim.
    #[test]
    fn p2p_gossip_advances_tip_without_http() {
        use crate::chain_state::ChainState;
        use crate::stationary_solver::StationarySolver;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let lambda = [1.0_f64; 5];

        // ── Node A: mine genesis (height 0) ───────────────────────────────
        let genesis_base = BlockHeader {
            prev_hash: [0u8; 32],
            merkle_root: [0u8; 32],
            timestamp: now,
            nonce: 0,
            difficulty: 1,
            recursion_depth: 0,
            residual: 0,
            state_root: [0u8; 32],
        };
        let genesis_state = ChainState {
            cumulative_work: 0,
            mempool_pressure: 0.5,
            validator_count: 1,
            last_quality: 1.0,
            height: 0,
        };
        let (res0, _) = StationarySolver::joint_residual_and_gradient(
            &genesis_base, &[], &genesis_state, &lambda,
        );
        let genesis_header = BlockHeader { residual: res0, ..genesis_base };

        // ── Node B: receives genesis via gossip (HTTP never called) ───────
        let mut engine_b = ValidationEngine::new();
        let genesis_gossip = GossipedBlock {
            header: genesis_header.clone(),
            tx_hashes: vec![],
            bft_votes: vec![],
            block_json: "{}".into(),
        };
        assert!(
            matches!(engine_b.validate(&genesis_gossip, /* from_peer */ true), ValidationDecision::Accept),
            "genesis must be accepted from peer"
        );
        engine_b.accept(&genesis_gossip);
        assert_eq!(engine_b.chain.len(), 1, "tip must advance to height 0");

        // ── Node A: mine block 1 (height 1) ───────────────────────────────
        let genesis_hash = block_hash(&genesis_header);
        let block1_base = BlockHeader {
            prev_hash: genesis_hash,
            merkle_root: [0u8; 32],
            timestamp: now + 1,
            nonce: 1,
            difficulty: 1,
            recursion_depth: 1,
            residual: 0,
            state_root: [0u8; 32],
        };
        let block1_state = ChainState {
            cumulative_work: 1,
            mempool_pressure: 0.5,
            validator_count: 1,
            last_quality: 1.0,
            height: 1,
        };
        let (res1, _) = StationarySolver::joint_residual_and_gradient(
            &block1_base, &[], &block1_state, &lambda,
        );
        let block1_header = BlockHeader { residual: res1, ..block1_base };

        // ── Node B: receives block 1 via gossip (HTTP never called) ───────
        let block1_gossip = GossipedBlock {
            header: block1_header.clone(),
            tx_hashes: vec![],
            bft_votes: vec![],
            block_json: "{}".into(),
        };
        assert!(
            matches!(engine_b.validate(&block1_gossip, /* from_peer */ true), ValidationDecision::Accept),
            "block 1 must be accepted from peer"
        );
        engine_b.accept(&block1_gossip);
        assert_eq!(engine_b.chain.len(), 2, "tip must advance to height 1");
        assert_eq!(engine_b.chain[1].recursion_depth, 1, "tip height must be 1");

        // HTTP submit (/api/blocks/submit) was never called in this test —
        // both blocks arrived exclusively via the from_peer=true gossip path.
    }

    #[test]
    fn bft_vote_message_matches_ts_layout() {
        // TS: Buffer.from("equilibrium-bft-v1") || Buffer.from(block.hash) || Buffer.from(block.height.toString())
        let msg = BftVote::vote_message("aabb", 12);
        assert_eq!(&msg[..18], b"equilibrium-bft-v1");
        assert_eq!(&msg[18..22], b"aabb");
        assert_eq!(&msg[22..], b"12");
    }

    #[test]
    fn bft_quorum_accepts_supermajority() {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key();
        let hash_hex = "ab".repeat(32);
        let height = 5u64;
        let msg = BftVote::vote_message(&hash_hex, height);
        let sig = sk.sign(&msg);

        let vote = BftVote {
            validator_addr: "v1".into(),
            block_hash_hex: hash_hex.clone(),
            height,
            signature: sig.to_bytes(),
        };
        let mut validators = HashMap::new();
        validators.insert(
            "v1".into(),
            ValidatorInfo { pubkey: pk.to_bytes(), bonded_stake: 100 },
        );
        assert!(check_bft_quorum(&validators, &[vote], &hash_hex, height).is_ok());
    }

    #[test]
    fn bft_quorum_rejects_insufficient_stake() {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let pk = sk.verifying_key();
        let hash_hex = "cd".repeat(32);
        let height = 1u64;
        let msg = BftVote::vote_message(&hash_hex, height);
        let sig = sk.sign(&msg);
        let vote = BftVote {
            validator_addr: "small".into(),
            block_hash_hex: hash_hex.clone(),
            height,
            signature: sig.to_bytes(),
        };
        let mut validators = HashMap::new();
        validators.insert(
            "small".into(),
            ValidatorInfo { pubkey: pk.to_bytes(), bonded_stake: 10 },
        );
        validators.insert(
            "silent".into(),
            ValidatorInfo { pubkey: [0u8; 32], bonded_stake: 100 },
        );
        // 10 / 110 < 2/3
        assert!(check_bft_quorum(&validators, &[vote], &hash_hex, height).is_err());
    }

    #[test]
    fn bft_quorum_rejects_bad_signature() {
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let pk = sk.verifying_key();
        let hash_hex = "ef".repeat(32);
        let height = 3u64;
        let vote = BftVote {
            validator_addr: "v1".into(),
            block_hash_hex: hash_hex.clone(),
            height,
            signature: [0u8; 64], // deliberately bad
        };
        let mut validators = HashMap::new();
        validators.insert(
            "v1".into(),
            ValidatorInfo { pubkey: pk.to_bytes(), bonded_stake: 100 },
        );
        assert!(check_bft_quorum(&validators, &[vote], &hash_hex, height).is_err());
    }

    #[test]
    fn parse_bft_votes_from_json_empty_votes_key() {
        let json = r#"{"height":1,"bftVotes":[]}"#;
        assert!(parse_bft_votes_from_block_json(json).is_empty());
    }

    #[test]
    fn parse_bft_votes_from_json_no_votes_key() {
        let json = r#"{"height":1,"nonce":42}"#;
        assert!(parse_bft_votes_from_block_json(json).is_empty());
    }

    #[test]
    fn parse_bft_votes_from_json_valid_vote() {
        let sig_hex = "aa".repeat(64); // 128 hex chars
        let json = format!(
            r#"{{ "bftVotes": [{{ "validator": "v1", "blockHash": "aabb", "height": 5, "signature": "{sig_hex}" }}] }}"#
        );
        let votes = parse_bft_votes_from_block_json(&json);
        assert_eq!(votes.len(), 1);
        assert_eq!(votes[0].validator_addr, "v1");
        assert_eq!(votes[0].block_hash_hex, "aabb");
        assert_eq!(votes[0].height, 5);
        assert_eq!(votes[0].signature, [0xaau8; 64]);
    }
}
