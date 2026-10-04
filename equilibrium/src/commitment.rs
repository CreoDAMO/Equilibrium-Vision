//! `apply_opened_successor` derives Ω′ from the pre-state and I.
//! The genesis continuity transition, a signed transfer, stake evidence,
//! canonical wasm, a bitcoin header, a model, and a settlement are that
//! execution. An Ethereum signature is not. It does not install a chain.

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[path = "successor_apply.rs"]
mod apply;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitOracle {
    rows: Vec<CommitRow>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitRow {
    name: String,
    omega_root: String,
    transition_root: String,
    pre: OmegaSnap,
    post: OmegaSnap,
    transition: TransitionSnap,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OmegaSnap {
    tip_hash: String,
    chain_id: i64,
    height: i64,
    tip_timestamp: i64,
    difficulty: f64,
    finalized_height: i64,
    couplings: Couplings,
    ledger: Vec<AccountSnap>,
    pools: Vec<PoolSnap>,
    btc: Vec<BtcSnap>,
    eth_pubkey: String,
    eth: Vec<EthSnap>,
    wasm: Vec<Vec<String>>,
    validators: Vec<ValidatorSnap>,
    delegations: Vec<DelegationSnap>,
    proposals: Vec<ProposalSnap>,
    models: Vec<ModelSnap>,
    settlements: Vec<SettlementSnap>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Couplings {
    hash: f64,
    structural: f64,
    continuity: f64,
    mempool: f64,
    fees: f64,
}

#[derive(Clone, Deserialize)]
struct AccountSnap {
    address: String,
    balance: f64,
    nonce: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoolSnap {
    id: String,
    address: String,
    reserve_a: f64,
    reserve_b: f64,
    tx_count: i64,
    fee: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BtcSnap {
    height: i64,
    hash: String,
    prev_hash: String,
    merkle_root: String,
    bits: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EthSnap {
    slot: i64,
    hash: String,
    participants: i64,
    parent_root: String,
    state_root: String,
    body_root: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidatorSnap {
    address: String,
    moniker: String,
    uptime: f64,
    bonded_stake: f64,
    accumulated_rewards: f64,
    slashed: bool,
    jailed: bool,
    blocks_proposed: i64,
    commission: f64,
}

#[derive(Clone, Deserialize)]
struct DelegationSnap {
    delegator: String,
    validator: String,
    amount: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BallotSnap {
    voter: String,
    option: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalSnap {
    id: i64,
    status: String,
    title: String,
    proposer: String,
    deposit: f64,
    yes: f64,
    no: f64,
    abstain: f64,
    coupling_key: Option<String>,
    coupling_value: Option<f64>,
    ballots: Vec<BallotSnap>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSnap {
    id: i64,
    status: String,
    residual_fp: f64,
    support_hash: String,
    uri: String,
    proposed_at: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettlementSnap {
    id: i64,
    status: String,
    asset: String,
    foreign_ref: String,
    from: String,
    to: String,
    amount: i64,
}

#[derive(Clone, Deserialize)]
struct TxSnap {
    hash: String,
    from: String,
    to: String,
    amount: f64,
    fee: f64,
    nonce: f64,
    #[serde(default)]
    signature: String,
    #[serde(default, rename = "publicKey")]
    public_key: String,
}

#[derive(Clone, Deserialize)]
struct TransitionSnap {
    txs: Vec<TxSnap>,
    evidence: String,
    timestamp: i64,
    nonce: i64,
    miner: String,
    pressure: f64,
    difficulty: f64,
    couplings: Couplings,
    /// Structured I. Absent on the continuity oracle, which carries blank evidence.
    #[serde(default)]
    body: Option<apply::EvidenceBody>,
}

fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// `num()` in the site digest. `-0` is `0`. Non-finite is `nan`.
fn js_num(n: f64) -> String {
    if !n.is_finite() {
        return "nan".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        return format!("{}", n as i64);
    }
    format!("{n}")
}

/// `encodeURIComponent` over UTF-8 bytes. Unescaped set matches ECMA-262.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn couplings_of(c: &Couplings) -> String {
    format!(
        "{},{},{},{},{}",
        js_num(c.hash),
        js_num(c.structural),
        js_num(c.continuity),
        js_num(c.mempool),
        js_num(c.fees)
    )
}

fn omega_preimage(omega: &OmegaSnap) -> String {
    let mut ledger = omega.ledger.iter().collect::<Vec<_>>();
    ledger.sort_by(|a, b| a.address.cmp(&b.address));
    let ledger = ledger
        .into_iter()
        .map(|acc| {
            format!(
                "{}:{}:{}",
                acc.address,
                js_num(acc.balance),
                js_num(acc.nonce)
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    let mut pools = omega.pools.iter().collect::<Vec<_>>();
    pools.sort_by(|a, b| a.id.cmp(&b.id));
    let pools = pools
        .into_iter()
        .map(|p| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                p.id,
                p.address,
                js_num(p.reserve_a),
                js_num(p.reserve_b),
                p.tx_count,
                js_num(p.fee)
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    let btc = omega
        .btc
        .iter()
        .map(|h| {
            format!(
                "{}:{}:{}:{}:{}",
                h.height,
                h.hash,
                h.prev_hash,
                h.merkle_root,
                js_num(h.bits)
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    let eth_rows = omega
        .eth
        .iter()
        .map(|h| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                h.slot, h.hash, h.participants, h.parent_root, h.state_root, h.body_root
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    let eth = format!("{}:{eth_rows}", omega.eth_pubkey);

    let wasm = if omega.wasm.is_empty() {
        "none".to_string()
    } else {
        let mut entries = omega.wasm.iter().collect::<Vec<_>>();
        entries.sort_by(|a, b| a[0].cmp(&b[0]));
        entries
            .into_iter()
            .map(|pair| format!("{}={}", pair[0], pair[1]))
            .collect::<Vec<_>>()
            .join("|")
    };

    let mut validators = omega.validators.iter().collect::<Vec<_>>();
    validators.sort_by(|a, b| a.address.cmp(&b.address));
    let validators = validators
        .into_iter()
        .map(|v| {
            format!(
                "{}:{}:{}:{}:{}:{}:{}:{}:{}",
                v.address,
                encode_uri_component(&v.moniker),
                js_num(v.uptime),
                js_num(v.bonded_stake),
                js_num(v.accumulated_rewards),
                if v.slashed { 1 } else { 0 },
                if v.jailed { 1 } else { 0 },
                v.blocks_proposed,
                js_num(v.commission)
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    let delegations = omega
        .delegations
        .iter()
        .map(|d| format!("{}>{}:{}", d.delegator, d.validator, js_num(d.amount)))
        .collect::<Vec<_>>()
        .join(";");

    let proposals = omega
        .proposals
        .iter()
        .map(|p| {
            let ballots = p
                .ballots
                .iter()
                .map(|b| format!("{}:{}", b.voter, b.option))
                .collect::<Vec<_>>()
                .join(",");
            let key = p.coupling_key.clone().unwrap_or_default();
            let value = p.coupling_value.map(js_num).unwrap_or_default();
            format!(
                "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{ballots}",
                p.id,
                p.status,
                encode_uri_component(&p.title),
                p.proposer,
                js_num(p.deposit),
                js_num(p.yes),
                js_num(p.no),
                js_num(p.abstain),
                key,
                value
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    let models = omega
        .models
        .iter()
        .map(|m| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                m.id,
                m.status,
                js_num(m.residual_fp),
                m.support_hash,
                encode_uri_component(&m.uri),
                m.proposed_at
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    let settlements = omega
        .settlements
        .iter()
        .map(|s| {
            format!(
                "{}:{}:{}:{}:{}:{}:{}",
                s.id, s.status, s.asset, s.foreign_ref, s.from, s.to, s.amount
            )
        })
        .collect::<Vec<_>>()
        .join(";");

    [
        "ECMA-262",
        &omega.chain_id.to_string(),
        &omega.height.to_string(),
        &omega.tip_timestamp.to_string(),
        &js_num(omega.difficulty),
        &omega.finalized_height.to_string(),
        &couplings_of(&omega.couplings),
        &ledger,
        &pools,
        &btc,
        &eth,
        &wasm,
        &validators,
        &delegations,
        &proposals,
        &models,
        &settlements,
    ]
    .join("|")
}

fn transition_preimage(omega: &OmegaSnap, inputs: &TransitionSnap) -> String {
    let digest = sha256_hex(&format!("eq-omega|{}", omega_preimage(omega)));
    let txs = inputs
        .txs
        .iter()
        .map(|t| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                t.hash,
                t.from,
                t.to,
                js_num(t.amount),
                js_num(t.fee),
                js_num(t.nonce)
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    let pressure = format!("{:.6}", inputs.pressure);
    let difficulty = js_num(inputs.difficulty);
    let timestamp = inputs.timestamp.to_string();
    let nonce = inputs.nonce.to_string();
    let couplings = couplings_of(&inputs.couplings);
    [
        omega.tip_hash.as_str(),
        digest.as_str(),
        txs.as_str(),
        inputs.evidence.as_str(),
        timestamp.as_str(),
        nonce.as_str(),
        inputs.miner.as_str(),
        pressure.as_str(),
        difficulty.as_str(),
        couplings.as_str(),
    ]
    .join("|")
}

#[derive(Debug)]
struct OpenedSuccessor {
    omega_root: String,
    transition_root: String,
    header: String,
    state_root: String,
    residual: f64,
    residual_fp: i64,
    residual_fp_js: String,
    reward: u64,
    liquid: u64,
    miner_balance: f64,
    continuity: f64,
    proposal_status: Option<String>,
}

/// One transition. Pre-state and I only. Ω′ is not an argument.
/// Ethereum header signatures are not this execution.
fn apply_opened_successor(pre: &OmegaSnap, input: &TransitionSnap) -> Result<OpenedSuccessor, String> {
    if !input.pressure.is_finite() || !(0.0..=1.0).contains(&input.pressure) {
        return Err("pressure is not in [0,1]".into());
    }
    if input.timestamp < 0 {
        return Err("timestamp is not a time".into());
    }
    if pre.height >= 0 && input.timestamp < pre.tip_timestamp {
        return Err("timestamp is not monotonic".into());
    }
    if input.difficulty != pre.difficulty {
        return Err("difficulty is not the next difficulty".into());
    }
    let evidence = if let Some(body) = &input.body {
        let encoded = apply::canonical_evidence(body)?;
        if encoded != input.evidence {
            return Err("evidence is not the canonical encoding".into());
        }
        encoded
    } else {
        apply::blank_code(pre.chain_id, &input.evidence)?;
        input.evidence.clone()
    };
    let order = apply::verify_order(pre, &input.txs)?;
    apply::selection_is(&order, input.txs.len(), false)?;
    let (target, block_target) = match pre.chain_id {
        1 => (8e-4, 15.0),
        2 => (2e-3, 8.0),
        _ => return Err("unknown chain".into()),
    };

    let mut next = pre.clone();
    let mut opened = Vec::new();
    for (index, proposal) in next.proposals.iter().enumerate() {
        if proposal.status != "passed" {
            continue;
        }
        let weight = match (&proposal.coupling_key, proposal.coupling_value) {
            (Some(key), Some(value)) if value.is_finite() => Some((key.clone(), value.max(0.0))),
            _ => None,
        };
        opened.push((index, weight));
    }
    for (index, weight) in opened {
        if let Some((key, weight)) = weight {
            match key.as_str() {
                "hash" => next.couplings.hash = weight,
                "structural" => next.couplings.structural = weight,
                "continuity" => next.couplings.continuity = weight,
                "mempool" => next.couplings.mempool = weight,
                "fees" => next.couplings.fees = weight,
                _ => return Err("coupling is not a coupling".into()),
            }
        }
        next.proposals[index].status = "executed".into();
    }
    if !same_couplings(&input.couplings, &next.couplings) {
        return Err("couplings are not the opened couplings".into());
    }
    let producer = next
        .validators
        .iter()
        .find(|v| v.address == input.miner)
        .ok_or("miner is not a live validator")?;
    if producer.jailed || producer.slashed || producer.bonded_stake <= 0.0 {
        return Err("miner is not a live validator".into());
    }
    let commission = producer.commission;
    if let Some(body) = &input.body {
        apply::apply_material(&mut next, body)?;
        apply::execute_wasm(&mut next, &body.wasm, pre.height)?;
    }

    let height = pre.height + 1;
    let work = if height > 0 { height as u64 } else { 0 };
    let prev = decode_hash32(&pre.tip_hash)?;
    let merkle_hex_root = if input.txs.is_empty() {
        "0".repeat(64)
    } else {
        merkle_hex(&input.txs.iter().map(|tx| tx.hash.clone()).collect::<Vec<_>>())
    };
    let merkle = decode_hash32(&merkle_hex_root)?;
    let lambda = [
        next.couplings.hash,
        next.couplings.structural,
        next.couplings.continuity,
        next.couplings.mempool,
        next.couplings.fees,
    ];
    let mut fee_txs = Vec::new();
    for tx in &input.txs {
        fee_txs.push(crate::chain_state::TxCandidate {
            hash: decode_hash32(&tx.hash)?,
            fee: tx.fee as u64,
        });
    }
    let residual = crate::stationary_solver::canonical_residual_lambda(
        &prev,
        &merkle,
        input.timestamp as u64,
        input.nonce as u64,
        input.difficulty as u64,
        &fee_txs,
        work,
        input.pressure,
        &lambda,
    );
    let reward = crate::chain_state::canonical_coinbase(height as u64, residual, target);
    let liquid = (reward as f64 * commission).floor().max(0.0) as u64;
    if liquid > reward {
        return Err("reward refused".into());
    }
    let staked = reward - liquid;
    apply::apply_effects(&mut next, &input.txs, &input.miner, liquid as f64)?;
    apply::selection_is(&order, input.txs.len(), true)?;
    if let Some(body) = &input.body {
        apply::admit_models(&mut next, body, input.timestamp)?;
    }
    {
        let miner = next
            .validators
            .iter_mut()
            .find(|v| v.address == input.miner)
            .ok_or("miner is not a live validator")?;
        miner.blocks_proposed += 1;
    }
    if staked > 0 {
        let mut total: u128 = 0;
        let mut live = Vec::new();
        for (index, validator) in next.validators.iter().enumerate() {
            if validator.jailed || validator.slashed || validator.bonded_stake <= 0.0 {
                continue;
            }
            if validator.bonded_stake.fract() != 0.0 {
                return Err("bonded stake refused".into());
            }
            total += validator.bonded_stake as u128;
            live.push(index);
        }
        if total == 0 {
            return Err("bonded stake refused".into());
        }
        for index in live {
            let stake = next.validators[index].bonded_stake as u128;
            let share = (staked as u128 * stake) / total;
            next.validators[index].accumulated_rewards += share as f64;
        }
    }
    let (foreign_num, foreign_den) = foreign_factor(&next);
    let block_time = if pre.height < 0 {
        block_target
    } else {
        input.timestamp as f64 - pre.tip_timestamp as f64
    };
    next.difficulty = adjust_difficulty(pre.difficulty, block_time, block_target, foreign_num, foreign_den);
    let mut bonded = 0.0;
    let mut voting = 0.0;
    for validator in &next.validators {
        bonded += validator.bonded_stake;
        if !validator.jailed && !validator.slashed {
            voting += validator.bonded_stake;
        }
    }
    if bonded > 0.0 && voting / bonded >= 2.0 / 3.0 {
        let cutoff = height - 2;
        if cutoff > next.finalized_height {
            next.finalized_height = cutoff;
        }
    }
    next.height = height;
    next.tip_timestamp = input.timestamp;

    let mut sealed = input.clone();
    sealed.evidence = evidence;
    let omega_root = sha256_hex(&format!("eq-omega|{}", omega_preimage(&next)));
    let transition_root = sha256_hex(&format!("eq-transition|{}", transition_preimage(pre, &sealed)));
    let state_root = state_root_of(&next);
    if let Some(body) = &input.body {
        apply::admit_binding(body, &js_residual_fp(residual).1, &state_root)?;
    }
    let evidence_root = sha256_hex(&sealed.evidence);
    let (residual_fp, residual_fp_js) = js_residual_fp(residual);
    let header = header_with_transition(
        &pre.tip_hash,
        &merkle_hex_root,
        &state_root,
        input.timestamp as u64,
        input.nonce as u64,
        input.difficulty as u64,
        &residual_fp_js,
        &input.miner,
        height as u64,
        input.pressure,
        pre.chain_id as u64,
        &evidence_root,
        &omega_root,
        &transition_root,
    );
    let miner_balance = next
        .ledger
        .iter()
        .find(|acc| acc.address == input.miner)
        .map(|acc| acc.balance)
        .unwrap_or(0.0);
    let proposal_status = next.proposals.first().map(|p| p.status.clone());
    Ok(OpenedSuccessor {
        omega_root,
        transition_root,
        header,
        state_root,
        residual,
        residual_fp,
        residual_fp_js,
        reward,
        liquid,
        miner_balance,
        continuity: next.couplings.continuity,
        proposal_status,
    })
}

fn same_couplings(left: &Couplings, right: &Couplings) -> bool {
    left.hash == right.hash
        && left.structural == right.structural
        && left.continuity == right.continuity
        && left.mempool == right.mempool
        && left.fees == right.fees
}

fn decode_hash32(text: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(text).map_err(|_| "not this surface".to_string())?;
    if bytes.len() != 32 {
        return Err("not this surface".into());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn foreign_factor(omega: &OmegaSnap) -> (f64, f64) {
    let mut num = 1.0;
    let mut den = 1.0;
    let mut apply = |hash: &str| {
        if hash.len() < 2 {
            return;
        }
        let Ok(byte) = u32::from_str_radix(&hash[hash.len() - 2..], 16) else {
            return;
        };
        let bump = (byte as f64 / 255.0 * 100.0).round();
        num *= 9950.0 + bump;
        den *= 10_000.0;
    };
    if let Some(header) = omega.btc.last() {
        apply(&header.hash);
    }
    if let Some(header) = omega.eth.last() {
        apply(&header.hash);
    }
    (num, den)
}

fn adjust_difficulty(difficulty: f64, block_time: f64, target: f64, num: f64, den: f64) -> f64 {
    if block_time <= 0.0 {
        return difficulty;
    }
    let factor = ((target / block_time) * (num / den)).clamp(0.8, 1.2);
    if factor == 0.8 || factor == 1.2 {
        return (difficulty * factor).floor().max(100_000.0);
    }
    ((difficulty * target * num) / (block_time * den)).floor().max(100_000.0)
}

fn state_root_of(omega: &OmegaSnap) -> String {
    let mut leaves = Vec::new();
    let mut ledger = omega.ledger.iter().collect::<Vec<_>>();
    ledger.sort_by(|a, b| a.address.cmp(&b.address));
    for acc in ledger {
        leaves.push(sha256_hex(&format!(
            "{}:{}:{}",
            acc.address,
            js_num(acc.balance),
            js_num(acc.nonce)
        )));
    }
    let mut pools = omega.pools.iter().collect::<Vec<_>>();
    pools.sort_by(|a, b| a.id.cmp(&b.id));
    for pool in pools {
        leaves.push(sha256_hex(&format!(
            "pool:{}:{}:{}:{}:{}:{}",
            pool.id,
            pool.address,
            js_num(pool.reserve_a),
            js_num(pool.reserve_b),
            js_num(pool.fee),
            pool.tx_count
        )));
    }
    let btc = omega
        .btc
        .last()
        .map(|h| format!("{}:{}", h.hash, h.height))
        .unwrap_or_else(|| "none".into());
    let eth = omega
        .eth
        .last()
        .map(|h| format!("{}:{}", h.slot, h.hash))
        .unwrap_or_else(|| "none".into());
    leaves.push(sha256_hex(&format!("btc:{btc}")));
    leaves.push(sha256_hex(&format!("eth:{eth}")));
    let wasm = if omega.wasm.is_empty() {
        "none".to_string()
    } else {
        let mut entries = omega.wasm.iter().collect::<Vec<_>>();
        entries.sort_by(|a, b| a[0].cmp(&b[0]));
        entries
            .into_iter()
            .map(|pair| format!("{}={}", pair[0], pair[1]))
            .collect::<Vec<_>>()
            .join("|")
    };
    leaves.push(sha256_hex(&format!("wasm:{wasm}")));
    let models = omega
        .models
        .iter()
        .map(|m| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                m.id,
                m.status,
                js_num(m.residual_fp),
                m.support_hash,
                encode_uri_component(&m.uri),
                m.proposed_at
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    let settlements = omega
        .settlements
        .iter()
        .map(|s| {
            format!(
                "{}:{}:{}:{}:{}:{}:{}",
                s.id, s.status, s.asset, s.foreign_ref, s.from, s.to, s.amount
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    leaves.push(sha256_hex(&format!("models:{models}")));
    leaves.push(sha256_hex(&format!("settle:{settlements}")));
    merkle_hex(&leaves)
}

fn merkle_hex(hashes: &[String]) -> String {
    if hashes.is_empty() {
        return "0".repeat(64);
    }
    let mut level = hashes.to_vec();
    if level.len() == 1 {
        return level.pop().unwrap();
    }
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(level.last().unwrap().clone());
        }
        let mut next = Vec::new();
        for pair in level.chunks(2) {
            next.push(sha256_hex(&sha256_hex(&format!("{}{}", pair[0], pair[1]))));
        }
        level = next;
    }
    level.pop().unwrap()
}

fn js_residual_fp(residual: f64) -> (i64, String) {
    if !residual.is_finite() || residual < 0.0 {
        return (-1, "-1".into());
    }
    let floored = (residual * 1_000_000_000_000_000_000.0).floor();
    (floored as i64, format!("{floored}"))
}

#[allow(clippy::too_many_arguments)]
fn header_with_transition(
    prev_hash: &str,
    merkle_root: &str,
    state_root: &str,
    timestamp: u64,
    nonce: u64,
    difficulty: u64,
    residual_fp: &str,
    miner: &str,
    height: u64,
    pressure: f64,
    chain_id: u64,
    evidence_root: &str,
    omega_root: &str,
    transition_root: &str,
) -> String {
    let preimage = format!(
        "{prev_hash}|{merkle_root}|{state_root}|{timestamp}|{nonce}|{difficulty}|{residual_fp}|{miner}|{height}|{pressure:.6}|{chain_id}|{evidence_root}|{omega_root}|{transition_root}"
    );
    let first = Sha256::digest(preimage.as_bytes());
    hex::encode(Sha256::digest(first))
}

#[cfg(test)]
mod tests {
    use super::{
        encode_uri_component, js_num, omega_preimage, sha256_hex, transition_preimage, CommitOracle,
    };

    #[test]
    fn js_number_and_uri_match_the_digest_alphabet() {
        assert_eq!(js_num(0.0), "0");
        assert_eq!(js_num(-0.0), "0");
        assert_eq!(js_num(f64::NAN), "nan");
        assert_eq!(js_num(0.1), "0.1");
        assert_eq!(js_num(0.003), "0.003");
        assert_eq!(js_num(1_500_000.0), "1500000");
        assert_eq!(
            encode_uri_component("Equilibrium Foundation"),
            "Equilibrium%20Foundation"
        );
        assert_eq!(encode_uri_component("ipfs://model"), "ipfs%3A%2F%2Fmodel");
        assert_eq!(encode_uri_component("a b"), "a%20b");
    }

    #[test]
    fn commitment_matches_the_site_oracle() {
        let Some(path) = std::env::var_os("EQ_COMMIT_ORACLE") else {
            println!("commit-oracle: not supplied");
            return;
        };
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("oracle {}: {err}", path.to_string_lossy()));
        let oracle: CommitOracle = serde_json::from_str(&text).expect("commit oracle json");
        assert!(!oracle.rows.is_empty(), "oracle has no rows");
        for row in &oracle.rows {
            let omega = omega_preimage(&row.post);
            let omega_hash = sha256_hex(&format!("eq-omega|{omega}"));
            assert_eq!(
                omega_hash, row.omega_root,
                "{} omega preimage {omega}",
                row.name
            );
            let transition = transition_preimage(&row.pre, &row.transition);
            let transition_hash = sha256_hex(&format!("eq-transition|{transition}"));
            assert_eq!(
                transition_hash, row.transition_root,
                "{} transition preimage {transition}",
                row.name
            );
        }
        println!("commit-oracle: rows {}", oracle.rows.len());
    }

    #[test]
    fn native_successor_applies_the_continuity_transition() {
        let Some(path) = std::env::var_os("EQ_SUCCESSOR_ORACLE") else {
            println!("native-successor: not supplied");
            return;
        };
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("oracle {}: {err}", path.to_string_lossy()));
        let oracle: SuccessorOracle = serde_json::from_str(&text).expect("successor oracle json");
        assert!(!oracle.cases.is_empty(), "oracle has no cases");
        let mut off_header = String::new();
        let mut on_header = String::new();
        for case in &oracle.cases {
            let got = super::apply_opened_successor(&case.pre, &case.transition);
            if let Some(reason) = &case.refuse {
                let err = got.expect_err(&case.name);
                assert_eq!(&err, reason, "{}", case.name);
                assert!(case.site.is_none(), "{} refuse is not a result", case.name);
                continue;
            }
            let got = got.unwrap_or_else(|err| panic!("{}: {err}", case.name));
            let site = case.site.as_ref().expect("site result");
            assert_eq!(got.omega_root, site.omega_root, "{} omega", case.name);
            assert_eq!(got.transition_root, site.transition_root, "{} transition", case.name);
            assert_eq!(got.state_root, site.state_root, "{} state", case.name);
            assert_eq!(got.reward, site.reward, "{} reward", case.name);
            assert_eq!(got.liquid, site.liquid, "{} liquid", case.name);
            assert_eq!(got.miner_balance, site.miner_balance, "{} balance", case.name);
            assert_eq!(got.continuity, site.continuity, "{} continuity", case.name);
            assert_eq!(got.proposal_status, site.proposal_status, "{} proposal", case.name);
            let expected: f64 = site.residual.parse().expect("residual");
            assert!(
                (got.residual - expected).abs() < 1e-12,
                "{} residual {} != {expected}",
                case.name,
                got.residual
            );
            assert_eq!(got.residual_fp_js, site.residual_fp, "{} fp", case.name);
            assert_eq!(got.header, site.header, "{} header", case.name);
            if case.name == "continuity-off" {
                off_header = got.header.clone();
                assert_eq!(got.reward, 100);
                assert_eq!(got.liquid, 10);
                assert_eq!(got.residual_fp, 201_100_202_523_998);
                assert_eq!(got.continuity, 0.0);
            }
            if case.name == "continuity-on" {
                on_header = got.header.clone();
                assert_eq!(got.reward, 0);
                assert_eq!(got.continuity, 1.0);
            }
        }
        assert_ne!(off_header, on_header, "the opened coupling must move the header");
        println!("native-successor: rows {}", oracle.cases.len());
        println!("native-successor: substituted refused");
        println!("native-successor: continuity-off reward 100");
    }

    #[derive(serde::Deserialize)]
    struct SuccessorOracle {
        cases: Vec<SuccessorCase>,
    }

    #[derive(serde::Deserialize)]
    struct SuccessorCase {
        name: String,
        pre: super::OmegaSnap,
        transition: super::TransitionSnap,
        site: Option<SiteExpect>,
        refuse: Option<String>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SiteExpect {
        omega_root: String,
        transition_root: String,
        header: String,
        state_root: String,
        residual: String,
        residual_fp: String,
        reward: u64,
        liquid: u64,
        miner_balance: f64,
        continuity: f64,
        proposal_status: Option<String>,
    }

    #[test]
    fn native_successor_expands_the_input() {
        let Some(path) = std::env::var_os("EQ_MEMBRANE_ORACLE") else {
            println!("membrane: not supplied");
            return;
        };
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("oracle {}: {err}", path.to_string_lossy()));
        let oracle: MembraneOracle = serde_json::from_str(&text).expect("membrane oracle json");
        assert_eq!(oracle.cases.len(), 18, "oracle rows");
        let mut pay = String::new();
        let mut other = String::new();
        for case in &oracle.cases {
            let got = super::apply_opened_successor(&case.pre, &case.transition);
            if let Some(reason) = &case.refuse {
                let err = got.expect_err(&case.name);
                assert_eq!(&err, reason, "{}", case.name);
                continue;
            }
            let got = got.unwrap_or_else(|err| panic!("{}: {err}", case.name));
            let site = case.site.as_ref().expect("site");
            assert_eq!(got.omega_root, site.omega_root, "{} omega", case.name);
            assert_eq!(got.transition_root, site.transition_root, "{} transition", case.name);
            assert_eq!(got.state_root, site.state_root, "{} state", case.name);
            assert_eq!(got.header, site.header, "{} header", case.name);
            if let Some(decoy) = case.decoy_balance {
                assert_ne!(got.miner_balance, decoy, "{} accepted a caller balance", case.name);
            }
            if case.name == "tx-pay" {
                pay = got.omega_root.clone();
            }
            if case.name == "tx-other" {
                other = got.omega_root.clone();
            }
        }
        assert_ne!(pay, other, "an altered signed transaction must move Ω′");
        println!("membrane: rows {}", oracle.cases.len());
        println!("membrane: signature refused");
        println!("membrane: wasm executed");
        println!("membrane: btc admitted");
    }

    #[derive(serde::Deserialize)]
    struct MembraneOracle {
        cases: Vec<MembraneCase>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MembraneCase {
        name: String,
        pre: super::OmegaSnap,
        transition: super::TransitionSnap,
        site: Option<MembraneSite>,
        refuse: Option<String>,
        decoy_balance: Option<f64>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MembraneSite {
        omega_root: String,
        transition_root: String,
        header: String,
        state_root: String,
    }
}
