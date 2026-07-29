//! Mobile background validator.
//!
//! Spawns a thread with a 2MB stack. Enqueues blocks via MPSC channel.
//! Validation pipeline:
//!   1. Chain continuity (prev_hash matches real block hash of tip)
//!   2. Timestamp sanity (±2 hours)
//!   3. Residual re-verification via joint_residual_and_gradient (no search)
//!   4. Merkle root recomputation from tx hashes
//!   5. BFT vote verification (stubbed)

use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

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
}

impl ValidationEngine {
    fn new() -> Self {
        Self {
            chain: Vec::with_capacity(MAX_VALIDATED_BLOCKS),
            tip_hashes: Vec::with_capacity(MAX_VALIDATED_BLOCKS),
        }
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

        // 5. BFT vote verification (stubbed — needs BLS host imports)
        // if block.bft_votes.len() < supermajority { return Reject { reason: "quorum" } }

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
    let padded = format!("{:0>64}", clean);
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
}
