//! Ethereum execution proofs.
//! The block hash is keccak256 of the execution header RLP.
//! A receipt is in that header only when a secure Merkle-Patricia proof
//! reaches the receiptsRoot. An EQU beacon bodyRoot is not that root.
//! This does not verify Ethereum's sync committee.

const ROT: [[u32; 5]; 5] = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
];

const RC: [u64; 24] = [
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808a,
    0x8000000080008000,
    0x000000000000808b,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008a,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000a,
    0x000000008000808b,
    0x800000000000008b,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800a,
    0x800000008000000a,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
];

const TRANSFER_TOPIC: &str = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SAFE: u64 = 9_007_199_254_740_991;

fn keccak_f(a: &mut [[u64; 5]; 5]) {
    for round in 0..24 {
        let mut c = [0u64; 5];
        for x in 0..5 {
            c[x] = a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4];
        }
        for x in 0..5 {
            let d = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
            for y in 0..5 {
                a[x][y] ^= d;
            }
        }
        let mut b = [[0u64; 5]; 5];
        for x in 0..5 {
            for y in 0..5 {
                b[y][(2 * x + 3 * y) % 5] = a[x][y].rotate_left(ROT[x][y]);
            }
        }
        for x in 0..5 {
            for y in 0..5 {
                a[x][y] = b[x][y] ^ ((!b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]);
            }
        }
        a[0][0] ^= RC[round];
    }
}

pub(super) fn keccak256(data: &[u8]) -> Vec<u8> {
    let rate = 136;
    let mut a = [[0u64; 5]; 5];
    let mut absorb = |block: &[u8]| {
        for (i, byte) in block.iter().enumerate() {
            let lane = i >> 3;
            let x = lane % 5;
            let y = lane / 5;
            a[x][y] ^= (*byte as u64) << (((i & 7) * 8) as u32);
        }
        keccak_f(&mut a);
    };
    let mut offset = 0;
    while offset + rate <= data.len() {
        absorb(&data[offset..offset + rate]);
        offset += rate;
    }
    let mut last = vec![0u8; rate];
    let rest = data.len() - offset;
    last[..rest].copy_from_slice(&data[offset..]);
    last[rest] ^= 0x01;
    last[rate - 1] ^= 0x80;
    absorb(&last);
    let mut out = vec![0u8; 32];
    for i in 0..32 {
        let lane = i >> 3;
        let x = lane % 5;
        let y = lane / 5;
        out[i] = ((a[x][y] >> (((i & 7) * 8) as u32)) & 0xff) as u8;
    }
    out
}

pub(super) fn keccak256_hex(data: &[u8]) -> String {
    hex::encode(keccak256(data))
}

enum Rlp {
    Bytes(Vec<u8>),
    List(Vec<Rlp>),
}

fn minimal_len(mut length: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while length > 0 {
        out.push((length & 0xff) as u8);
        length /= 256;
    }
    out.reverse();
    out
}

fn rlp_prefix(offset: u8, length: usize) -> Vec<u8> {
    if length < 56 {
        return vec![offset + length as u8];
    }
    let len = minimal_len(length);
    let mut out = vec![offset + 55 + len.len() as u8];
    out.extend(len);
    out
}

fn rlp_encode_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    let mut out = rlp_prefix(0x80, bytes.len());
    out.extend_from_slice(bytes);
    out
}

fn rlp_encode(item: &Rlp) -> Vec<u8> {
    match item {
        Rlp::Bytes(bytes) => rlp_encode_bytes(bytes),
        Rlp::List(items) => {
            let mut payload = Vec::new();
            for child in items {
                payload.extend(rlp_encode(child));
            }
            let mut out = rlp_prefix(0xc0, payload.len());
            out.extend(payload);
            out
        }
    }
}

fn read_len(bytes: &[u8]) -> Option<usize> {
    if bytes.is_empty() || bytes[0] == 0 {
        return None;
    }
    let mut n: usize = 0;
    for &byte in bytes {
        n = n.checked_mul(256)?.checked_add(byte as usize)?;
    }
    Some(n)
}

fn rlp_decode_at(raw: &[u8], offset: usize) -> Option<(Rlp, usize)> {
    if offset >= raw.len() {
        return None;
    }
    let first = raw[offset];
    if first < 0x80 {
        return Some((Rlp::Bytes(vec![first]), offset + 1));
    }
    if first <= 0xb7 {
        let len = (first - 0x80) as usize;
        let start = offset + 1;
        let end = start + len;
        if end > raw.len() {
            return None;
        }
        if len == 1 && raw[start] < 0x80 {
            return None;
        }
        return Some((Rlp::Bytes(raw[start..end].to_vec()), end));
    }
    if first <= 0xbf {
        let len_of_len = (first - 0xb7) as usize;
        let start = offset + 1;
        if len_of_len == 0 || start + len_of_len > raw.len() {
            return None;
        }
        let len = read_len(&raw[start..start + len_of_len])?;
        if len < 56 {
            return None;
        }
        let data_start = start + len_of_len;
        let end = data_start + len;
        if end > raw.len() {
            return None;
        }
        return Some((Rlp::Bytes(raw[data_start..end].to_vec()), end));
    }
    if first <= 0xf7 {
        let len = (first - 0xc0) as usize;
        let start = offset + 1;
        let end = start + len;
        if end > raw.len() {
            return None;
        }
        let items = decode_list(&raw[start..end])?;
        return Some((Rlp::List(items), end));
    }
    let len_of_len = (first - 0xf7) as usize;
    let start = offset + 1;
    if len_of_len == 0 || start + len_of_len > raw.len() {
        return None;
    }
    let len = read_len(&raw[start..start + len_of_len])?;
    if len < 56 {
        return None;
    }
    let data_start = start + len_of_len;
    let end = data_start + len;
    if end > raw.len() {
        return None;
    }
    let items = decode_list(&raw[data_start..end])?;
    Some((Rlp::List(items), end))
}

fn decode_list(raw: &[u8]) -> Option<Vec<Rlp>> {
    let mut items = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let (value, next) = rlp_decode_at(raw, i)?;
        items.push(value);
        i = next;
    }
    Some(items)
}

fn rlp_decode(raw: &[u8]) -> Option<Rlp> {
    let (value, next) = rlp_decode_at(raw, 0)?;
    if next != raw.len() {
        return None;
    }
    Some(value)
}

fn read_rlp_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() {
        return Some(0);
    }
    if bytes[0] == 0 || bytes.len() > 6 {
        return None;
    }
    let mut n: u64 = 0;
    for &byte in bytes {
        n = n * 256 + byte as u64;
    }
    if n > SAFE {
        return None;
    }
    Some(n)
}

fn read_abi_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.len() != 32 {
        return None;
    }
    let mut n: u128 = 0;
    for &byte in bytes {
        n = n * 256 + byte as u128;
        if n > SAFE as u128 {
            return None;
        }
    }
    Some(n as u64)
}

fn rlp_uint_bytes(n: u64) -> Vec<u8> {
    if n == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut x = n;
    while x > 0 {
        out.push((x & 0xff) as u8);
        x >>= 8;
    }
    out.reverse();
    out
}

fn rlp_uint(n: u64) -> Vec<u8> {
    rlp_encode_bytes(&rlp_uint_bytes(n))
}

fn to_nibbles(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(byte >> 4);
        out.push(byte & 0x0f);
    }
    out
}

fn decode_hp(path: &[u8]) -> Option<(bool, Vec<u8>)> {
    if path.is_empty() {
        return None;
    }
    let first = path[0];
    if first & 0xc0 != 0 {
        return None;
    }
    let leaf = first & 0x20 != 0;
    let odd = first & 0x10 != 0;
    if !odd && first & 0x0f != 0 {
        return None;
    }
    let mut nibbles = Vec::new();
    if odd {
        nibbles.push(first & 0x0f);
    }
    for &byte in &path[1..] {
        nibbles.push(byte >> 4);
        nibbles.push(byte & 0x0f);
    }
    Some((leaf, nibbles))
}

pub(super) fn verify_secure_trie(root: &[u8], key: &[u8], proof: &[Vec<u8>]) -> Option<Vec<u8>> {
    let mut nibbles = to_nibbles(&keccak256(key));
    let mut want = root.to_vec();
    if proof.is_empty() {
        return None;
    }
    for (i, node) in proof.iter().enumerate() {
        let inline = want.len() < 32 && want == *node;
        let hashed = want.len() == 32 && keccak256(node) == want;
        if !inline && !hashed {
            return None;
        }
        let Rlp::List(items) = rlp_decode(node)? else {
            return None;
        };
        if items.len() == 17 {
            if nibbles.is_empty() {
                if i + 1 != proof.len() {
                    return None;
                }
                let Rlp::Bytes(value) = &items[16] else {
                    return None;
                };
                return Some(value.clone());
            }
            let Rlp::Bytes(next) = &items[nibbles[0] as usize] else {
                return None;
            };
            nibbles = nibbles[1..].to_vec();
            want = next.clone();
            continue;
        }
        if items.len() != 2 {
            return None;
        }
        let Rlp::Bytes(path) = &items[0] else {
            return None;
        };
        let Rlp::Bytes(rest) = &items[1] else {
            return None;
        };
        let (leaf, hp) = decode_hp(path)?;
        if leaf {
            if i + 1 != proof.len() || nibbles != hp {
                return None;
            }
            return Some(rest.clone());
        }
        if nibbles.len() < hp.len() || nibbles[..hp.len()] != hp[..] {
            return None;
        }
        nibbles = nibbles[hp.len()..].to_vec();
        want = rest.clone();
    }
    None
}

pub(super) struct ExecutionHeader {
    pub hash: String,
    pub parent_hash: String,
    pub transactions_root: String,
    pub receipts_root: String,
    pub number: i64,
}

fn as_bytes(item: &Rlp) -> Option<&[u8]> {
    match item {
        Rlp::Bytes(bytes) => Some(bytes),
        Rlp::List(_) => None,
    }
}

pub(super) fn parse_execution_header(raw: &[u8]) -> Option<ExecutionHeader> {
    let decoded = rlp_decode(raw)?;
    let Rlp::List(items) = &decoded else {
        return None;
    };
    if items.len() < 15 {
        return None;
    }
    if rlp_encode(&decoded) != raw {
        return None;
    }
    let parent = as_bytes(&items[0])?;
    let tx_root = as_bytes(&items[4])?;
    let receipt_root = as_bytes(&items[5])?;
    let number = as_bytes(&items[8])?;
    if parent.len() != 32 || tx_root.len() != 32 || receipt_root.len() != 32 {
        return None;
    }
    let height = read_rlp_uint(number)?;
    Some(ExecutionHeader {
        hash: hex::encode(keccak256(raw)),
        parent_hash: hex::encode(parent),
        transactions_root: hex::encode(tx_root),
        receipts_root: hex::encode(receipt_root),
        number: height as i64,
    })
}

struct ParsedLog {
    address: String,
    topics: Vec<String>,
    data: Vec<u8>,
}

fn parse_receipt(raw: &[u8]) -> Option<(u64, Vec<ParsedLog>)> {
    let body = if !raw.is_empty() && raw[0] < 0xc0 {
        if raw[0] < 1 || raw[0] > 4 {
            return None;
        }
        &raw[1..]
    } else {
        raw
    };
    let Rlp::List(items) = rlp_decode(body)? else {
        return None;
    };
    if items.len() < 4 {
        return None;
    }
    let status = read_rlp_uint(as_bytes(&items[0])?)?;
    if status != 0 && status != 1 {
        return None;
    }
    let Rlp::List(logs) = &items[3] else {
        return None;
    };
    let mut parsed = Vec::new();
    for item in logs {
        let Rlp::List(fields) = item else {
            return None;
        };
        if fields.len() < 3 {
            return None;
        }
        let address = as_bytes(&fields[0])?;
        if address.len() != 20 {
            return None;
        }
        let Rlp::List(topics) = &fields[1] else {
            return None;
        };
        let data = as_bytes(&fields[2])?.to_vec();
        let mut topic_hex = Vec::new();
        for topic in topics {
            let bytes = as_bytes(topic)?;
            if bytes.len() != 32 {
                return None;
            }
            topic_hex.push(hex::encode(bytes));
        }
        parsed.push(ParsedLog {
            address: hex::encode(address),
            topics: topic_hex,
            data,
        });
    }
    Some((status, parsed))
}

fn parse_native_tx(raw: &[u8]) -> Option<(String, u64)> {
    let (body, kind) = if raw.len() > 1 && raw[0] < 0xc0 {
        let kind = match raw[0] {
            1 => 1,
            2 => 2,
            _ => return None,
        };
        (&raw[1..], kind)
    } else {
        (raw, 0)
    };
    let Rlp::List(items) = rlp_decode(body)? else {
        return None;
    };
    let to_at = if kind == 0 { 3 } else if kind == 1 { 4 } else { 5 };
    let to = as_bytes(items.get(to_at)?)?;
    let value = as_bytes(items.get(to_at + 1)?)?;
    if to.len() != 20 {
        return None;
    }
    Some((hex::encode(to), read_rlp_uint(value)?))
}

pub(super) struct EthEffect {
    pub asset: String,
    pub destination: String,
    pub amount: u64,
    pub locator: String,
}

fn hex_bytes(value: &str) -> Option<Vec<u8>> {
    let clean = value.trim().trim_start_matches("0x").to_ascii_lowercase();
    if clean.is_empty() || clean.len() % 2 != 0 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(clean).ok()
}

fn hex_list(values: &[String]) -> Option<Vec<Vec<u8>>> {
    values.iter().map(|value| hex_bytes(value)).collect()
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub(super) fn prove_eth_effect(
    receipts_root: &str,
    transactions_root: &str,
    block_hash: &str,
    tx_index: i64,
    receipt_rlp: &str,
    receipt_proof: &[String],
    log_index: i64,
    tx_rlp: &str,
    tx_proof: &[String],
    asset: &str,
) -> Result<EthEffect, String> {
    let Some(index) = (tx_index >= 0 && (tx_index as u64) <= SAFE).then_some(tx_index as u64) else {
        return Err("eth receipt refused".into());
    };
    if !hex64(receipts_root) || !hex64(transactions_root) {
        return Err("eth header is not in Ω".into());
    }
    let Some(receipt) = hex_bytes(receipt_rlp) else {
        return Err("eth receipt refused".into());
    };
    let Some(proof) = hex_list(receipt_proof) else {
        return Err("eth receipt refused".into());
    };
    let key = rlp_uint(index);
    let Some(root) = hex_bytes(receipts_root) else {
        return Err("eth header is not in Ω".into());
    };
    let proved = verify_secure_trie(&root, &key, &proof);
    if proved.as_deref() != Some(receipt.as_slice()) {
        return Err("eth trie refused".into());
    }
    let Some((status, logs)) = parse_receipt(&receipt) else {
        return Err("eth receipt refused".into());
    };
    if status != 1 {
        return Err("eth receipt refused".into());
    }
    if asset == "eth" {
        let Some(tx_raw) = hex_bytes(tx_rlp) else {
            return Err("eth transaction refused".into());
        };
        if tx_raw.is_empty() {
            return Err("eth transaction refused".into());
        }
        let Some(tx_nodes) = hex_list(tx_proof) else {
            return Err("eth transaction refused".into());
        };
        let Some(tx_root) = hex_bytes(transactions_root) else {
            return Err("eth header is not in Ω".into());
        };
        let tx_value = verify_secure_trie(&tx_root, &key, &tx_nodes);
        if tx_value.as_deref() != Some(tx_raw.as_slice()) {
            return Err("eth trie refused".into());
        }
        let Some((to, value)) = parse_native_tx(&tx_raw) else {
            return Err("eth transaction refused".into());
        };
        return Ok(EthEffect {
            asset: "eth".into(),
            destination: format!("eth:{to}"),
            amount: value,
            locator: format!("{block_hash}:{tx_index}:value"),
        });
    }
    if asset.len() != 40 || !asset.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("withdrawal asset refused".into());
    }
    if log_index < 0 || log_index as usize >= logs.len() {
        return Err("eth log refused".into());
    }
    let log = &logs[log_index as usize];
    if log.address != asset || log.topics.len() != 3 || log.topics[0] != TRANSFER_TOPIC {
        return Err("eth log refused".into());
    }
    let to_topic = &log.topics[2];
    if !to_topic.starts_with("000000000000000000000000") {
        return Err("eth log refused".into());
    }
    let Some(amount) = read_abi_uint(&log.data) else {
        return Err("eth amount refused".into());
    };
    Ok(EthEffect {
        asset: log.address.clone(),
        destination: format!("eth:{}", &to_topic[24..]),
        amount,
        locator: format!("{block_hash}:{tx_index}:{log_index}"),
    })
}

pub(super) fn is_eth_destination(destination: &str) -> bool {
    let Some(rest) = destination.strip_prefix("eth:") else {
        return false;
    };
    rest.len() == 40 && rest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub(super) fn is_eth_asset(asset: &str) -> bool {
    asset == "eth" || (asset.len() == 40 && asset.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}
