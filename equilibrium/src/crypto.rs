use sha2::{Sha256, Digest};

/// Double-SHA256 hash of input bytes, as used in block/transaction hashing.
pub fn hash256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    Sha256::digest(first).into()
}

/// Compute a Merkle root from a list of transaction hashes.
pub fn merkle_root(hashes: &[[u8; 32]]) -> [u8; 32] {
    if hashes.is_empty() {
        return [0u8; 32];
    }
    if hashes.len() == 1 {
        return hashes[0];
    }

    let mut level = hashes.to_vec();
    while level.len() > 1 {
        if level.len() % 2 != 0 {
            level.push(*level.last().unwrap());
        }
        level = level
            .chunks(2)
            .map(|pair| {
                let mut combined = [0u8; 64];
                combined[..32].copy_from_slice(&pair[0]);
                combined[32..].copy_from_slice(&pair[1]);
                hash256(&combined)
            })
            .collect();
    }
    level[0]
}
