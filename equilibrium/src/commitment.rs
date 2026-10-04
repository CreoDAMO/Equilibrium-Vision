//! Commitment of a state the site already produced.
//! This rebuilds `omegaDigest` and `transitionDigest` from fields.
//! It does not apply the successor, and it does not install Ω.

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitOracle {
    rows: Vec<CommitRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitRow {
    name: String,
    omega_root: String,
    transition_root: String,
    pre: OmegaSnap,
    post: OmegaSnap,
    transition: TransitionSnap,
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Couplings {
    hash: f64,
    structural: f64,
    continuity: f64,
    mempool: f64,
    fees: f64,
}

#[derive(Deserialize)]
struct AccountSnap {
    address: String,
    balance: f64,
    nonce: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoolSnap {
    id: String,
    address: String,
    reserve_a: f64,
    reserve_b: f64,
    tx_count: i64,
    fee: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BtcSnap {
    height: i64,
    hash: String,
    prev_hash: String,
    merkle_root: String,
    bits: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EthSnap {
    slot: i64,
    hash: String,
    participants: i64,
    parent_root: String,
    state_root: String,
    body_root: String,
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
struct DelegationSnap {
    delegator: String,
    validator: String,
    amount: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BallotSnap {
    voter: String,
    option: String,
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSnap {
    id: i64,
    status: String,
    residual_fp: f64,
    support_hash: String,
    uri: String,
    proposed_at: i64,
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
struct TxSnap {
    hash: String,
    from: String,
    to: String,
    amount: f64,
    fee: f64,
    nonce: f64,
}

#[derive(Deserialize)]
struct TransitionSnap {
    txs: Vec<TxSnap>,
    evidence: String,
    timestamp: i64,
    nonce: i64,
    miner: String,
    pressure: f64,
    difficulty: f64,
    couplings: Couplings,
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
}
