//! Transaction, stake, wasm, bitcoin, model, and settlement steps.
//! Ethereum header signatures are not executed here.
//! A caller-supplied wasm map is not an argument.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use super::{sha256_hex, AccountSnap, OmegaSnap, PoolSnap, TxSnap};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EvidenceBody {
    pub v: i64,
    pub chain_id: i64,
    pub wasm_code: String,
    #[serde(default)]
    pub btc: Vec<BtcEv>,
    #[serde(default)]
    pub eth: Vec<serde_json::Value>,
    #[serde(default)]
    pub wasm: Vec<WasmEv>,
    #[serde(default)]
    pub stake: Vec<StakeOp>,
    #[serde(default)]
    pub cognition: Vec<Cognition>,
    #[serde(default)]
    pub settle: Vec<SettleOp>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BtcEv {
    pub header_hex: String,
    pub height: i64,
}

#[derive(Clone, Deserialize)]
pub(super) struct WasmEv {
    pub method: String,
    pub caller: String,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "op")]
pub(super) enum StakeOp {
    #[serde(rename = "delegate")]
    Delegate {
        delegator: String,
        validator: String,
        amount: f64,
    },
    #[serde(rename = "claim")]
    Claim { address: String },
    #[serde(rename = "slash")]
    Slash { validator: String, reason: String },
    #[serde(rename = "propose")]
    Propose {
        proposer: String,
        title: String,
        deposit: f64,
        id: i64,
        #[serde(default)]
        #[serde(rename = "couplingKey")]
        coupling_key: Option<String>,
        #[serde(default)]
        #[serde(rename = "couplingValue")]
        coupling_value: Option<f64>,
    },
    #[serde(rename = "vote")]
    Vote { voter: String, id: i64, option: String },
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind")]
pub(super) enum Cognition {
    #[serde(rename = "bind")]
    Bind {
        #[serde(rename = "residualFp")]
        residual_fp: f64,
        proof: String,
    },
    #[serde(rename = "model")]
    Model {
        id: i64,
        uri: String,
        #[serde(rename = "residualFp")]
        residual_fp: f64,
        #[serde(rename = "supportHash")]
        support_hash: String,
        proof: String,
    },
    #[serde(rename = "challenge")]
    Challenge {
        id: i64,
        #[serde(rename = "supportHash")]
        support_hash: String,
        proof: String,
    },
}

#[derive(Clone, Deserialize)]
#[serde(tag = "op")]
pub(super) enum SettleOp {
    #[serde(rename = "lock")]
    Lock {
        id: i64,
        asset: String,
        #[serde(rename = "foreignRef")]
        foreign_ref: String,
        from: String,
        to: String,
        amount: f64,
    },
    #[serde(rename = "release")]
    Release { id: i64 },
}

use serde::Deserialize;

const SAFE: f64 = 9_007_199_254_740_991.0;

fn safe_int(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE
}

fn safe_non_negative(n: f64) -> bool {
    safe_int(n) && n >= 0.0
}

fn safe_positive(n: f64) -> bool {
    safe_int(n) && n > 0.0
}

pub(super) fn wasm_code() -> Result<String, String> {
    let bytes = wasm_bytes()?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn wasm_bytes() -> Result<Vec<u8>, String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../site/src/protocol/arbitrage.wasm"
    );
    std::fs::read(path).map_err(|err| err.to_string())
}

pub(super) fn blank_code(chain_id: i64, evidence: &str) -> Result<(), String> {
    let prefix = format!("v1|{chain_id}|");
    let rest = evidence
        .strip_prefix(&prefix)
        .ok_or("not this surface")?;
    let code = rest.strip_suffix("||||").ok_or("not this surface")?;
    if code != wasm_code()? {
        return Err("not this surface".into());
    }
    Ok(())
}

pub(super) fn canonical_evidence(body: &EvidenceBody) -> Result<String, String> {
    if !body.eth.is_empty() {
        return Err("eth signature is not this execution".into());
    }
    if body.wasm_code != wasm_code()? {
        return Err("wasm code is not this constitution".into());
    }
    let btc = body
        .btc
        .iter()
        .map(|b| format!("{}:{}", b.height, b.header_hex))
        .collect::<Vec<_>>()
        .join(";");
    let wasm = body
        .wasm
        .iter()
        .map(|w| format!("{}:{}", w.method, w.caller))
        .collect::<Vec<_>>()
        .join(";");
    let stake = body
        .stake
        .iter()
        .map(stake_line)
        .collect::<Vec<_>>()
        .join(";");
    let cognition = body
        .cognition
        .iter()
        .map(cognition_line)
        .collect::<Vec<_>>()
        .join(";");
    let settle = body
        .settle
        .iter()
        .map(settle_line)
        .collect::<Vec<_>>()
        .join(";");
    let encoded = format!(
        "v1|{}|{}|{btc}||{wasm}|{stake}",
        body.chain_id, body.wasm_code
    );
    if cognition.is_empty() && settle.is_empty() {
        return Ok(encoded);
    }
    Ok(format!("{encoded}|{cognition}|{settle}"))
}

fn stake_line(op: &StakeOp) -> String {
    match op {
        StakeOp::Delegate {
            delegator,
            validator,
            amount,
        } => format!("d:{delegator}:{validator}:{}", super::js_num(*amount)),
        StakeOp::Claim { address } => format!("c:{address}"),
        StakeOp::Slash { validator, reason } => format!("s:{validator}:{reason}"),
        StakeOp::Vote { voter, id, option } => format!("v:{voter}:{id}:{option}"),
        StakeOp::Propose {
            proposer,
            title,
            deposit,
            id,
            coupling_key,
            coupling_value,
        } => {
            let proposed = format!(
                "p:{id}:{proposer}:{}:{}",
                super::js_num(*deposit),
                super::encode_uri_component(title)
            );
            match (coupling_key, coupling_value) {
                (Some(key), Some(value)) if !key.is_empty() => {
                    format!("{proposed}:{key}:{}", super::js_num(*value))
                }
                _ => proposed,
            }
        }
    }
}

fn cognition_line(item: &Cognition) -> String {
    match item {
        Cognition::Bind { residual_fp, proof } => {
            format!("b:{}:{proof}", super::js_num(*residual_fp))
        }
        Cognition::Challenge {
            id,
            support_hash,
            proof,
        } => format!("x:{id}:{support_hash}:{proof}"),
        Cognition::Model {
            id,
            uri,
            residual_fp,
            support_hash,
            proof,
        } => format!(
            "m:{id}:{}:{support_hash}:{proof}:{}",
            super::js_num(*residual_fp),
            super::encode_uri_component(uri)
        ),
    }
}

fn settle_line(op: &SettleOp) -> String {
    match op {
        SettleOp::Lock {
            id,
            asset,
            foreign_ref,
            from,
            to,
            amount,
        } => format!(
            "l:{id}:{asset}:{foreign_ref}:{from}:{to}:{}",
            super::js_num(*amount)
        ),
        SettleOp::Release { id } => format!("r:{id}"),
    }
}

pub(super) fn verify_order(pre: &OmegaSnap, txs: &[TxSnap]) -> Result<Vec<usize>, String> {
    for tx in txs {
        verify_tx(pre.chain_id, tx)?;
    }
    if txs.len() > 50 {
        return Err("transactions are not the canonical selection".into());
    }
    Ok(select(pre, txs))
}

pub(super) fn selection_is(order: &[usize], len: usize, strict_length: bool) -> Result<(), String> {
    let same = order.len() == len && order.iter().enumerate().all(|(i, idx)| *idx == i);
    if strict_length {
        if !same {
            return Err("transactions are not the canonical selection".into());
        }
    } else if order.len() == len && !same {
        return Err("transactions are not the canonical selection".into());
    }
    Ok(())
}

fn verify_tx(chain_id: i64, tx: &TxSnap) -> Result<(), String> {
    let refused = "signature refused";
    let from = hex::decode(&tx.from).map_err(|_| refused)?;
    let to = hex::decode(&tx.to).map_err(|_| refused)?;
    let pk = hex::decode(&tx.public_key).map_err(|_| refused)?;
    let sig = hex::decode(&tx.signature).map_err(|_| refused)?;
    if from.len() != 20 || to.len() != 20 || pk.len() != 32 || sig.len() != 64 {
        return Err(refused.into());
    }
    if !safe_int(tx.amount) || !safe_int(tx.fee) || !safe_int(tx.nonce) {
        return Err(refused.into());
    }
    if tx.amount < 0.0 || tx.fee < 0.0 || tx.nonce < 0.0 {
        return Err(refused.into());
    }
    let mut msg = Vec::with_capacity(20 + 20 + 8 + 8 + 8 + 32 + 8);
    msg.extend_from_slice(&from);
    msg.extend_from_slice(&to);
    msg.extend_from_slice(&(tx.amount as u64).to_le_bytes());
    msg.extend_from_slice(&(tx.fee as u64).to_le_bytes());
    msg.extend_from_slice(&(tx.nonce as u64).to_le_bytes());
    msg.extend_from_slice(&pk);
    msg.extend_from_slice(&(chain_id as u64).to_le_bytes());
    let key = VerifyingKey::from_bytes(pk.as_slice().try_into().unwrap()).map_err(|_| refused)?;
    let signature = Signature::from_slice(&sig).map_err(|_| refused)?;
    key.verify(&msg, &signature).map_err(|_| refused)?;
    msg.extend_from_slice(&sig);
    if hex::encode(Sha256::digest(&msg)) != tx.hash {
        return Err(refused.into());
    }
    let addr = &hex::encode(Sha256::digest(&pk))[..40];
    if addr != tx.from {
        return Err(refused.into());
    }
    Ok(())
}

fn select(pre: &OmegaSnap, txs: &[TxSnap]) -> Vec<usize> {
    let mut spent = std::collections::HashMap::<String, f64>::new();
    let mut received = std::collections::HashMap::<String, f64>::new();
    let mut used_nonce = std::collections::HashMap::<String, f64>::new();
    let mut used = std::collections::HashSet::<String>::new();
    let mut chosen = Vec::new();
    while chosen.len() < 50 {
        let mut best: Option<usize> = None;
        for (i, tx) in txs.iter().enumerate() {
            if used.contains(&tx.hash) {
                continue;
            }
            if !safe_int(tx.amount) || !safe_int(tx.fee) || tx.amount <= 0.0 || tx.fee < 0.0 {
                continue;
            }
            let nonce = account(pre, &tx.from).1 + used_nonce.get(&tx.from).copied().unwrap_or(0.0);
            if tx.nonce != nonce {
                continue;
            }
            let balance = account(pre, &tx.from).0 + received.get(&tx.from).copied().unwrap_or(0.0)
                - spent.get(&tx.from).copied().unwrap_or(0.0);
            if balance < tx.amount + tx.fee {
                continue;
            }
            let take = match best {
                None => true,
                Some(b) => {
                    tx.fee > txs[b].fee || (tx.fee == txs[b].fee && tx.hash < txs[b].hash)
                }
            };
            if take {
                best = Some(i);
            }
        }
        let Some(i) = best else { break };
        let tx = &txs[i];
        used.insert(tx.hash.clone());
        *spent.entry(tx.from.clone()).or_insert(0.0) += tx.amount + tx.fee;
        *used_nonce.entry(tx.from.clone()).or_insert(0.0) += 1.0;
        if !is_pool(pre, &tx.to) {
            *received.entry(tx.to.clone()).or_insert(0.0) += tx.amount;
        }
        chosen.push(i);
    }
    chosen
}

fn account(pre: &OmegaSnap, addr: &str) -> (f64, f64) {
    pre.ledger
        .iter()
        .find(|a| a.address == addr)
        .map(|a| (a.balance, a.nonce))
        .unwrap_or((0.0, 0.0))
}

fn is_pool(pre: &OmegaSnap, to: &str) -> bool {
    pre.pools.iter().any(|p| pool_addr(p) == to)
}

fn pool_addr(pool: &PoolSnap) -> String {
    if !pool.address.is_empty() {
        return pool.address.clone();
    }
    hex::encode(Sha256::digest(format!("eq-pool:{}", pool.id).as_bytes()))[..40].to_string()
}

pub(super) fn apply_material(omega: &mut OmegaSnap, body: &EvidenceBody) -> Result<(), String> {
    if body.v != 1 {
        return Err("unknown evidence version".into());
    }
    if body.chain_id != omega.chain_id {
        return Err(format!(
            "evidence chain {} is not {}",
            body.chain_id, omega.chain_id
        ));
    }
    let auth = authority(omega)?;
    for op in &body.stake {
        apply_stake(omega, op, &auth)?;
    }
    for item in &body.btc {
        apply_btc(omega, item)?;
    }
    for op in &body.settle {
        apply_settle(omega, op)?;
    }
    Ok(())
}

struct Auth {
    power: Vec<(String, f64)>,
    total: f64,
    quorum: f64,
}

fn authority(omega: &OmegaSnap) -> Result<Auth, String> {
    let mut power = Vec::new();
    let mut total = 0.0;
    for validator in &omega.validators {
        if validator.jailed || validator.slashed || !safe_positive(validator.bonded_stake) {
            continue;
        }
        let next = total + validator.bonded_stake;
        if !safe_int(total) || !safe_int(validator.bonded_stake) || !safe_int(next) {
            return Err("bonded stake refused".into());
        }
        total = next;
        power.push((validator.address.clone(), validator.bonded_stake));
    }
    Ok(Auth {
        power,
        total,
        quorum: (2.0 / 3.0) * total,
    })
}

fn apply_stake(omega: &mut OmegaSnap, op: &StakeOp, auth: &Auth) -> Result<(), String> {
    match op {
        StakeOp::Delegate {
            delegator,
            validator,
            amount,
        } => {
            let Some(index) = omega.validators.iter().position(|v| v.address == *validator) else {
                return Err("delegate refused".into());
            };
            if omega.validators[index].jailed || omega.validators[index].slashed {
                return Err("delegate refused".into());
            }
            if !safe_positive(*amount) {
                return Err("delegate amount refused".into());
            }
            let current = omega.validators[index].bonded_stake;
            let next = current + amount;
            if !safe_int(current) || !safe_int(next) {
                return Err("delegate amount refused".into());
            }
            debit(&mut omega.ledger, delegator, *amount).map_err(|_| "delegate funds refused")?;
            omega.validators[index].bonded_stake = next;
            omega.delegations.push(super::DelegationSnap {
                delegator: delegator.clone(),
                validator: validator.clone(),
                amount: *amount,
            });
            Ok(())
        }
        StakeOp::Claim { address } => {
            let Some(index) = omega.validators.iter().position(|v| v.address == *address) else {
                return Err("claim refused".into());
            };
            let amount = omega.validators[index].accumulated_rewards;
            if !safe_positive(amount) {
                return Err("claim refused".into());
            }
            omega.validators[index].accumulated_rewards = 0.0;
            credit(&mut omega.ledger, address, amount).map_err(|_| "claim refused".to_string())?;
            Ok(())
        }
        StakeOp::Slash { validator, reason } => {
            let Some(v) = omega.validators.iter_mut().find(|v| v.address == *validator) else {
                return Err("slash refused".into());
            };
            if v.slashed || v.jailed || !safe_positive(v.bonded_stake) {
                return Err("slash refused".into());
            }
            let pct = if reason == "double_sign" {
                0.05
            } else if reason == "downtime" {
                0.01
            } else {
                return Err("slash refused".into());
            };
            let burned = (v.bonded_stake * pct).floor();
            if !safe_non_negative(burned) || burned > v.bonded_stake {
                return Err("slash refused".into());
            }
            v.bonded_stake -= burned;
            v.slashed = true;
            if reason == "double_sign" {
                v.jailed = true;
            }
            Ok(())
        }
        StakeOp::Vote { voter, id, option } => {
            let Some(p) = omega.proposals.iter_mut().find(|p| p.id == *id) else {
                return Err("vote refused".into());
            };
            if p.status != "open" {
                return Err("vote refused".into());
            }
            let Some(power) = auth.power.iter().find(|(a, _)| a == voter).map(|(_, n)| *n) else {
                return Err("vote refused".into());
            };
            if p.ballots.iter().any(|b| b.voter == *voter) {
                return Err("vote already cast".into());
            }
            let tally = match option.as_str() {
                "yes" => p.yes + power,
                "no" => p.no + power,
                "abstain" => p.abstain + power,
                _ => return Err("vote refused".into()),
            };
            let current = match option.as_str() {
                "yes" => p.yes,
                "no" => p.no,
                "abstain" => p.abstain,
                _ => return Err("vote refused".into()),
            };
            if !safe_int(current) || !safe_int(power) || !safe_int(tally) {
                return Err("vote refused".into());
            }
            match option.as_str() {
                "yes" => p.yes = tally,
                "no" => p.no = tally,
                "abstain" => p.abstain = tally,
                _ => return Err("vote refused".into()),
            }
            p.ballots.push(super::BallotSnap {
                voter: voter.clone(),
                option: option.clone(),
            });
            let yes_no = p.yes + p.no;
            let total = yes_no + p.abstain;
            if safe_int(yes_no) && safe_int(total) && auth.total > 0.0 && total >= auth.quorum {
                p.status = if p.yes > p.no { "passed" } else { "failed" }.into();
            }
            Ok(())
        }
        StakeOp::Propose {
            proposer,
            title,
            deposit,
            id,
            coupling_key,
            coupling_value,
        } => {
            if !auth.power.iter().any(|(a, _)| a == proposer) {
                return Err("proposal proposer unauthorized".into());
            }
            if !safe_non_negative(*deposit) || !safe_int(*id as f64) || *id < 0 {
                return Err("proposal deposit refused".into());
            }
            if title.len() > 80 {
                return Err("proposal deposit refused".into());
            }
            if omega.proposals.iter().any(|p| p.id == *id) {
                return Err("proposal already exists".into());
            }
            debit(&mut omega.ledger, proposer, *deposit)
                .map_err(|_| "proposal deposit refused".to_string())?;
            let (key, value) = match (coupling_key, coupling_value) {
                (None, None) => (None, None),
                (Some(key), Some(value))
                    if matches!(
                        key.as_str(),
                        "hash" | "structural" | "continuity" | "mempool" | "fees"
                    ) && value.is_finite() =>
                {
                    (Some(key.clone()), Some(*value))
                }
                _ => return Err("coupling is not a coupling".into()),
            };
            omega.proposals.insert(
                0,
                super::ProposalSnap {
                    id: *id,
                    status: "open".into(),
                    title: title.clone(),
                    proposer: proposer.clone(),
                    deposit: *deposit,
                    yes: 0.0,
                    no: 0.0,
                    abstain: 0.0,
                    coupling_key: key,
                    coupling_value: value,
                    ballots: Vec::new(),
                },
            );
            Ok(())
        }
    }
}

fn apply_btc(omega: &mut OmegaSnap, item: &BtcEv) -> Result<(), String> {
    let raw = decode_header(&item.header_hex).ok_or("btc header is not 80 bytes")?;
    if !btc_pow(&raw) {
        return Err("btc proof of work refused".into());
    }
    let parsed = parse_btc(&raw);
    if let Some(tip) = omega.btc.last() {
        if item.height != tip.height + 1 {
            return Err("btc height does not extend the tip".into());
        }
        if parsed.prev != tip.hash {
            return Err("btc prev does not match the tip".into());
        }
    }
    if omega.btc.iter().any(|h| h.hash == parsed.hash) {
        return Err("btc header already in the transition".into());
    }
    omega.btc.push(super::BtcSnap {
        height: item.height,
        hash: parsed.hash,
        prev_hash: parsed.prev,
        merkle_root: parsed.merkle,
        bits: parsed.bits,
    });
    if omega.btc.len() > 2016 {
        omega.btc.remove(0);
    }
    Ok(())
}

struct Parsed {
    prev: String,
    merkle: String,
    bits: f64,
    hash: String,
}

fn decode_header(hex_text: &str) -> Option<Vec<u8>> {
    let clean = hex_text.trim().trim_start_matches("0x");
    if clean.len() != 160 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(clean).ok()
}

fn parse_btc(raw: &[u8]) -> Parsed {
    Parsed {
        prev: hex::encode(&raw[4..36]),
        merkle: hex::encode(&raw[36..68]),
        bits: u32::from_le_bytes(raw[72..76].try_into().unwrap()) as f64,
        hash: hex::encode(Sha256::digest(Sha256::digest(raw))),
    }
}

fn btc_pow(raw: &[u8]) -> bool {
    let mut hash = Sha256::digest(Sha256::digest(raw)).to_vec();
    hash.reverse();
    let bits = u32::from_le_bytes(raw[72..76].try_into().unwrap());
    hash.as_slice() <= bits_to_target(bits).as_slice()
}

fn bits_to_target(bits: u32) -> [u8; 32] {
    let mut target = [0u8; 32];
    let exponent = ((bits >> 24) & 0xff) as usize;
    let mantissa = bits & 0x00ff_ffff;
    if exponent == 0 || exponent > 32 {
        return target;
    }
    let start = 32 - exponent;
    let bytes = [
        ((mantissa >> 16) & 0xff) as u8,
        ((mantissa >> 8) & 0xff) as u8,
        (mantissa & 0xff) as u8,
    ];
    for (i, byte) in bytes.iter().enumerate() {
        let at = start + i;
        if at < 32 {
            target[at] = *byte;
        }
    }
    target
}

fn foreign_known(omega: &OmegaSnap, asset: &str, foreign_ref: &str) -> bool {
    if asset == "btc" {
        return omega.btc.iter().any(|h| h.hash == foreign_ref);
    }
    asset == "eth" && omega.eth.iter().any(|h| h.hash == foreign_ref)
}

fn apply_settle(omega: &mut OmegaSnap, op: &SettleOp) -> Result<(), String> {
    match op {
        SettleOp::Lock {
            id,
            asset,
            foreign_ref,
            from,
            to,
            amount,
        } => {
            if !safe_int(*amount) || *amount <= 0.0 {
                return Err("settlement amount refused".into());
            }
            if *id < 0 || omega.settlements.iter().any(|s| s.id == *id) {
                return Err("settlement already exists".into());
            }
            if asset != "btc" && asset != "eth" {
                return Err("settlement asset refused".into());
            }
            if !foreign_known(omega, asset, foreign_ref) {
                return Err("foreign observation is not in Ω".into());
            }
            debit(&mut omega.ledger, from, *amount).map_err(|_| "settlement lock refused")?;
            omega.settlements.push(super::SettlementSnap {
                id: *id,
                status: "locked".into(),
                asset: asset.clone(),
                foreign_ref: foreign_ref.clone(),
                from: from.clone(),
                to: to.clone(),
                amount: *amount as i64,
            });
            Ok(())
        }
        SettleOp::Release { id } => {
            let Some(index) = omega.settlements.iter().position(|s| s.id == *id) else {
                return Err("settlement is not locked".into());
            };
            if omega.settlements[index].status != "locked" {
                return Err("settlement is not locked".into());
            }
            let asset = omega.settlements[index].asset.clone();
            let foreign = omega.settlements[index].foreign_ref.clone();
            if !foreign_known(omega, &asset, &foreign) {
                return Err("foreign observation left the window".into());
            }
            let to = omega.settlements[index].to.clone();
            let amount = omega.settlements[index].amount as f64;
            omega.settlements[index].status = "settled".into();
            credit(&mut omega.ledger, &to, amount).map_err(|_| "settlement amount refused")?;
            Ok(())
        }
    }
}

pub(super) fn execute_wasm(omega: &mut OmegaSnap, calls: &[WasmEv], height: i64) -> Result<(), String> {
    if calls.is_empty() {
        return Ok(());
    }
    let bytes = wasm_bytes()?;
    let mut storage = omega.wasm.clone();
    let block = i32::try_from(height.max(0)).unwrap_or(0);
    for call in calls {
        let method = match call.method.as_str() {
            "init" => 0,
            "pause" => 2,
            "unpause" => 3,
            _ => return Err(format!("wasm {} returned 0", call.method)),
        };
        let args = if call.method == "init" {
            call.caller.clone().into_bytes()
        } else {
            Vec::new()
        };
        let code = run_contract(&bytes, method, &args, &call.caller, block, &mut storage)?;
        if code != 1 {
            return Err(format!("wasm {} returned {code}", call.method));
        }
    }
    omega.wasm = storage;
    Ok(())
}

struct Host {
    storage: Vec<Vec<String>>,
    caller: String,
    block: i32,
}

fn run_contract(
    bytes: &[u8],
    method: i32,
    args: &[u8],
    caller_text: &str,
    block: i32,
    storage: &mut Vec<Vec<String>>,
) -> Result<i32, String> {
    use wasmi::{Caller, Engine, Linker, Module, Store};
    let engine = Engine::default();
    let module = Module::new(&engine, bytes).map_err(|err| err.to_string())?;
    let mut store = Store::new(
        &engine,
        Host {
            storage: storage.clone(),
            caller: caller_text.to_string(),
            block,
        },
    );
    let mut linker = Linker::new(&engine);
    linker
        .func_wrap(
            "env",
            "caller_address",
            |mut caller: Caller<'_, Host>, out: i32| -> i32 {
                let text = caller.data().caller.clone();
                write_mem(&mut caller, out, text.as_bytes()) as i32
            },
        )
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap(
            "env",
            "storage_get",
            |mut caller: Caller<'_, Host>, key_ptr: i32, key_len: i32, out: i32| -> i32 {
                let key = read_mem(&caller, key_ptr, key_len);
                let value = caller
                    .data()
                    .storage
                    .iter()
                    .find(|pair| pair.first().map(String::as_str) == Some(key.as_str()))
                    .and_then(|pair| pair.get(1).cloned());
                match value {
                    Some(value) => write_mem(&mut caller, out, value.as_bytes()) as i32,
                    None => 0,
                }
            },
        )
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap(
            "env",
            "storage_set",
            |mut caller: Caller<'_, Host>, kp: i32, kl: i32, vp: i32, vl: i32| {
                let key = read_mem(&caller, kp, kl);
                let val = read_mem(&caller, vp, vl);
                let storage = &mut caller.data_mut().storage;
                if let Some(pair) = storage.iter_mut().find(|pair| pair.first().map(String::as_str) == Some(key.as_str()))
                {
                    if pair.len() == 1 {
                        pair.push(val);
                    } else if let Some(slot) = pair.get_mut(1) {
                        *slot = val;
                    }
                } else {
                    storage.push(vec![key, val]);
                }
            },
        )
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap("env", "log", |_: Caller<'_, Host>, _: i32, _: i32| {})
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap(
            "env",
            "call_contract",
            |_: Caller<'_, Host>, _: i32, _: i32, _: i32, _: i32, _: i32| -> i32 { -1 },
        )
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap(
            "env",
            "gov_param",
            |_: Caller<'_, Host>, _: i32, _: i32| -> i64 { 0 },
        )
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap("env", "block_number", |caller: Caller<'_, Host>| -> i32 {
            caller.data().block
        })
        .map_err(|err| err.to_string())?;
    linker
        .func_wrap(
            "env",
            "dex_multi_swap",
            |_: Caller<'_, Host>, _: i32, _: i32, _: i32, _: i32, _: i64| -> i64 { -1 },
        )
        .map_err(|err| err.to_string())?;
    let instance = linker
        .instantiate(&mut store, &module)
        .map_err(|err| err.to_string())?
        .start(&mut store)
        .map_err(|err| err.to_string())?;
    let alloc = instance
        .get_typed_func::<i32, i32>(&store, "alloc")
        .map_err(|err| err.to_string())?;
    let call = instance
        .get_typed_func::<(i32, i32, i32), i32>(&store, "call")
        .map_err(|err| err.to_string())?;
    let ptr = if args.is_empty() {
        0
    } else {
        alloc
            .call(&mut store, args.len() as i32)
            .map_err(|err| err.to_string())?
    };
    if !args.is_empty() {
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or("wasm memory is not ready")?;
        memory
            .write(&mut store, ptr as usize, args)
            .map_err(|err| err.to_string())?;
    }
    let code = call
        .call(&mut store, (method, ptr, args.len() as i32))
        .map_err(|err| err.to_string())?;
    *storage = store.data().storage.clone();
    Ok(code)
}

fn read_mem(caller: &wasmi::Caller<'_, Host>, ptr: i32, len: i32) -> String {
    if len <= 0 {
        return String::new();
    }
    let Some(memory) = caller.get_export("memory").and_then(|item| item.into_memory()) else {
        return String::new();
    };
    let mut buf = vec![0u8; len as usize];
    if memory.read(caller, ptr as usize, &mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn write_mem(caller: &mut wasmi::Caller<'_, Host>, ptr: i32, bytes: &[u8]) -> usize {
    let Some(memory) = caller.get_export("memory").and_then(|item| item.into_memory()) else {
        return 0;
    };
    if memory.write(caller, ptr as usize, bytes).is_err() {
        return 0;
    }
    bytes.len()
}

pub(super) fn apply_effects(
    omega: &mut OmegaSnap,
    txs: &[TxSnap],
    miner: &str,
    liquid: f64,
) -> Result<(), String> {
    for tx in txs {
        if !safe_int(tx.amount) || !safe_int(tx.fee) || tx.amount <= 0.0 || tx.fee < 0.0 {
            return Err("amount refused".into());
        }
        let total = tx.amount + tx.fee;
        if !safe_int(total) {
            return Err("amount refused".into());
        }
        let (balance, nonce) = account(omega, &tx.from);
        if !safe_non_negative(nonce) || tx.nonce != nonce {
            return Err("bad nonce".into());
        }
        if !safe_non_negative(balance) || balance < total {
            return Err("insufficient funds".into());
        }
        debit(&mut omega.ledger, &tx.from, total)?;
        if let Some(acc) = omega.ledger.iter_mut().find(|a| a.address == tx.from) {
            acc.nonce += 1.0;
        }
        credit(&mut omega.ledger, miner, tx.fee)?;
        if let Some(pool) = omega.pools.iter_mut().find(|p| pool_addr(p) == tx.to) {
            let _ = swap_a(pool, tx.amount);
        } else {
            credit(&mut omega.ledger, &tx.to, tx.amount)?;
        }
    }
    if !safe_non_negative(liquid) {
        return Err("reward refused".into());
    }
    credit(&mut omega.ledger, miner, liquid).map_err(|_| "reward refused".to_string())
}

fn swap_a(pool: &mut PoolSnap, amount_in: f64) -> f64 {
    if !amount_in.is_finite() || amount_in <= 0.0 || pool.reserve_a <= 0.0 || pool.reserve_b <= 0.0
    {
        return 0.0;
    }
    let dx = amount_in * (1.0 - pool.fee);
    if dx <= 0.0 {
        return 0.0;
    }
    let out = ((dx * pool.reserve_b) / (pool.reserve_a + dx)).floor();
    if out <= 0.0 {
        return 0.0;
    }
    pool.reserve_a += amount_in;
    pool.reserve_b -= out;
    pool.tx_count += 1;
    out
}

fn credit(ledger: &mut Vec<AccountSnap>, addr: &str, amount: f64) -> Result<(), String> {
    if !safe_non_negative(amount) {
        return Err("amount refused".into());
    }
    if let Some(acc) = ledger.iter_mut().find(|a| a.address == addr) {
        if !safe_non_negative(acc.balance) {
            return Err("amount refused".into());
        }
        if amount == 0.0 {
            return Ok(());
        }
        let next = acc.balance + amount;
        if !safe_int(next) {
            return Err("amount refused".into());
        }
        acc.balance = next;
        return Ok(());
    }
    ledger.push(AccountSnap {
        address: addr.to_string(),
        balance: amount,
        nonce: 0.0,
    });
    Ok(())
}

fn debit(ledger: &mut [AccountSnap], addr: &str, amount: f64) -> Result<(), String> {
    if !safe_non_negative(amount) {
        return Err("amount refused".into());
    }
    let Some(acc) = ledger.iter_mut().find(|a| a.address == addr) else {
        return Err("insufficient funds".into());
    };
    if !safe_non_negative(acc.balance) {
        return Err("amount refused".into());
    }
    if amount == 0.0 {
        return Ok(());
    }
    if acc.balance < amount {
        return Err("insufficient funds".into());
    }
    let next = acc.balance - amount;
    if !safe_int(next) {
        return Err("amount refused".into());
    }
    acc.balance = next;
    Ok(())
}

pub(super) fn admit_models(
    omega: &mut OmegaSnap,
    body: &EvidenceBody,
    timestamp: i64,
) -> Result<(), String> {
    for item in &body.cognition {
        match item {
            Cognition::Bind { .. } => {}
            Cognition::Challenge {
                id,
                support_hash,
                proof,
            } => {
                let Some(row) = omega.models.iter_mut().find(|m| m.id == *id) else {
                    return Err("model is not bound".into());
                };
                if row.status == "slashed" {
                    return Err("model is not bound".into());
                }
                if support_hash.len() != 64 || !support_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("challenge support refused".into());
                }
                if support_hash == &row.support_hash {
                    return Err("challenge does not disagree".into());
                }
                let expect = sha256_hex(&format!(
                    "eq-challenge|{}|{id}|{support_hash}",
                    omega.chain_id
                ));
                if proof != &expect {
                    return Err("challenge commitment refused".into());
                }
                row.status = "slashed".into();
            }
            Cognition::Model {
                id,
                uri,
                residual_fp,
                support_hash,
                proof,
            } => {
                if uri.is_empty() || uri.len() > 128 {
                    return Err("model uri refused".into());
                }
                if !safe_non_negative(*residual_fp) {
                    return Err("model residual refused".into());
                }
                if support_hash.len() != 64 || !support_hash.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err("model support refused".into());
                }
                let expect = sha256_hex(&format!(
                    "eq-model|{}|{id}|{uri}|{}|{support_hash}",
                    omega.chain_id,
                    super::js_num(*residual_fp)
                ));
                if proof != &expect {
                    return Err("model commitment refused".into());
                }
                if let Some(existing) = omega.models.iter().find(|m| m.id == *id) {
                    if existing.support_hash != *support_hash || existing.residual_fp != *residual_fp
                    {
                        return Err("model claim does not match the registry".into());
                    }
                } else {
                    omega.models.insert(
                        0,
                        super::ModelSnap {
                            id: *id,
                            status: "bound".into(),
                            residual_fp: *residual_fp,
                            support_hash: support_hash.clone(),
                            uri: uri.clone(),
                            proposed_at: timestamp,
                        },
                    );
                }
            }
        }
    }
    Ok(())
}

pub(super) fn admit_binding(
    body: &EvidenceBody,
    residual_fp_js: &str,
    state_root: &str,
) -> Result<(), String> {
    for item in &body.cognition {
        let Cognition::Bind { residual_fp, proof } = item else {
            continue;
        };
        if super::js_num(*residual_fp) != residual_fp_js {
            return Err("proof does not name this residual".into());
        }
        let expect = sha256_hex(&format!("eq-bind|{residual_fp_js}|{state_root}"));
        if proof != &expect {
            return Err("proof does not bind this state".into());
        }
    }
    Ok(())
}
