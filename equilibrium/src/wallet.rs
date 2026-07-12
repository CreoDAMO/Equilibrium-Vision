use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use sha2::{Sha256, Digest};
use rand::rngs::OsRng;
use serde::{Serialize, Deserialize};
use std::{fmt, fs, path::Path};

/// 20-byte address derived from SHA-256(public_key)[..20]
pub type Address = [u8; 20];

/// Derive a 20-byte address from an Ed25519 verifying key.
pub fn address_from_pubkey(pubkey: &VerifyingKey) -> Address {
    let hash = Sha256::digest(pubkey.as_bytes());
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[..20]);
    addr
}

/// Human-readable hex address.
pub fn address_to_hex(addr: &Address) -> String {
    addr.iter().map(|b| format!("{b:02x}")).collect()
}

/// Parse a hex address string back to bytes.
pub fn address_from_hex(s: &str) -> Result<Address, WalletError> {
    let s = s.trim_start_matches("0x");
    if s.len() != 40 {
        return Err(WalletError::InvalidAddress);
    }
    let mut addr = [0u8; 20];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        addr[i] = u8::from_str_radix(
            std::str::from_utf8(chunk).map_err(|_| WalletError::InvalidAddress)?,
            16,
        )
        .map_err(|_| WalletError::InvalidAddress)?;
    }
    Ok(addr)
}

// ── Transaction ───────────────────────────────────────────────────────────────

// ── Serde helpers for byte arrays > 32 elements ───────────────────────────────
// serde's built-in array support covers up to [T; 32]; we need [u8; 64].

mod bytes64 {
    use serde::{Deserialize, Deserializer, Serializer, ser::SerializeSeq};
    pub fn serialize<S: Serializer>(v: &[u8; 64], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(64))?;
        for b in v.iter() { seq.serialize_element(b)?; }
        seq.end()
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        let v: Vec<u8> = Vec::deserialize(d)?;
        v.try_into().map_err(|_| serde::de::Error::custom("expected 64 bytes"))
    }
}

/// A fully-signed transaction ready for inclusion in a block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedTx {
    pub from:      Address,
    pub to:        Address,
    pub amount:    u64,
    pub fee:       u64,
    /// Per-sender sequence number — prevents replay.
    pub nonce:     u64,
    /// Ed25519 signature over the canonical tx body bytes.
    #[serde(with = "bytes64")]
    pub signature: [u8; 64],
    /// Sender's Ed25519 verifying key (32 bytes).
    pub public_key: [u8; 32],
}

impl SignedTx {
    /// Canonical bytes that are signed/verified (everything except signature).
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(20 + 20 + 8 + 8 + 8 + 32);
        buf.extend_from_slice(&self.from);
        buf.extend_from_slice(&self.to);
        buf.extend_from_slice(&self.amount.to_le_bytes());
        buf.extend_from_slice(&self.fee.to_le_bytes());
        buf.extend_from_slice(&self.nonce.to_le_bytes());
        buf.extend_from_slice(&self.public_key);
        buf
    }

    /// Compute the transaction hash (SHA-256 of signing bytes + signature).
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.signing_bytes());
        hasher.update(self.signature);
        hasher.finalize().into()
    }

    /// Verify the embedded signature against the embedded public key.
    pub fn verify(&self) -> Result<(), WalletError> {
        let vk = VerifyingKey::from_bytes(&self.public_key)
            .map_err(|_| WalletError::InvalidPublicKey)?;
        let sig = Signature::from_bytes(&self.signature);
        vk.verify(&self.signing_bytes(), &sig)
            .map_err(|_| WalletError::BadSignature)
    }
}

// ── Wallet ────────────────────────────────────────────────────────────────────

/// In-memory wallet: holds an Ed25519 signing key and the derived address.
pub struct Wallet {
    signing_key:  SigningKey,
    verifying_key: VerifyingKey,
    pub address:  Address,
}

impl Wallet {
    /// Generate a brand-new wallet from OS entropy.
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let address = address_from_pubkey(&verifying_key);
        Self { signing_key, verifying_key, address }
    }

    /// Restore a wallet from a 32-byte raw private key.
    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        let signing_key = SigningKey::from_bytes(bytes);
        let verifying_key = signing_key.verifying_key();
        let address = address_from_pubkey(&verifying_key);
        Self { signing_key, verifying_key, address }
    }

    /// Export the raw 32-byte private key (keep this secret).
    pub fn private_key_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }

    /// The 32-byte public key.
    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.verifying_key.to_bytes()
    }

    /// Sign a transaction to `to`, spending `amount` + `fee` with the given nonce.
    pub fn sign_tx(&self, to: Address, amount: u64, fee: u64, nonce: u64) -> SignedTx {
        let mut tx = SignedTx {
            from:       self.address,
            to,
            amount,
            fee,
            nonce,
            signature:  [0u8; 64],
            public_key: self.public_key_bytes(),
        };
        let sig: Signature = self.signing_key.sign(&tx.signing_bytes());
        tx.signature = sig.to_bytes();
        tx
    }

    // ── Keystore ──────────────────────────────────────────────────────────────

    /// Persist the private key to a file (unencrypted — encrypt before production use).
    pub fn save(&self, path: &Path) -> Result<(), WalletError> {
        let ks = KeystoreFile {
            version: 1,
            private_key: hex::encode(self.private_key_bytes()),
            address:     address_to_hex(&self.address),
        };
        let json = serde_json::to_string_pretty(&ks)
            .map_err(|e| WalletError::Io(e.to_string()))?;
        fs::write(path, json).map_err(|e| WalletError::Io(e.to_string()))
    }

    /// Load a wallet from a keystore file produced by `save`.
    pub fn load(path: &Path) -> Result<Self, WalletError> {
        let raw = fs::read_to_string(path)
            .map_err(|e| WalletError::Io(e.to_string()))?;
        let ks: KeystoreFile = serde_json::from_str(&raw)
            .map_err(|e| WalletError::Io(e.to_string()))?;
        let bytes = hex::decode(&ks.private_key)
            .map_err(|_| WalletError::InvalidAddress)?;
        let arr: [u8; 32] = bytes.try_into().map_err(|_| WalletError::InvalidAddress)?;
        Ok(Self::from_bytes(&arr))
    }
}

impl fmt::Display for Wallet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Wallet({})", address_to_hex(&self.address))
    }
}

// ── Keystore file schema ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct KeystoreFile {
    version:     u32,
    private_key: String,
    address:     String,
}

// ── Ledger (in-memory account state) ─────────────────────────────────────────

/// Simple account-based ledger for tracking EQU balances and nonces.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Ledger {
    accounts: std::collections::HashMap<String, Account>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Account {
    pub balance: u64,
    pub nonce:   u64,
}

impl Ledger {
    pub fn new() -> Self { Self::default() }

    pub fn balance(&self, addr: &Address) -> u64 {
        self.accounts
            .get(&address_to_hex(addr))
            .map(|a| a.balance)
            .unwrap_or(0)
    }

    pub fn nonce(&self, addr: &Address) -> u64 {
        self.accounts
            .get(&address_to_hex(addr))
            .map(|a| a.nonce)
            .unwrap_or(0)
    }

    /// Credit an address (used for coinbase rewards).
    pub fn credit(&mut self, addr: &Address, amount: u64) {
        let acc = self.accounts
            .entry(address_to_hex(addr))
            .or_default();
        acc.balance = acc.balance.saturating_add(amount);
    }

    /// Apply a signed transaction; returns `Err` if invalid.
    pub fn apply_tx(&mut self, tx: &SignedTx) -> Result<(), WalletError> {
        tx.verify()?;

        let sender_key = address_to_hex(&tx.from);
        let sender = self.accounts.entry(sender_key).or_default();

        if tx.nonce != sender.nonce {
            return Err(WalletError::BadNonce { expected: sender.nonce, got: tx.nonce });
        }
        let total = tx.amount.checked_add(tx.fee)
            .ok_or(WalletError::InsufficientFunds)?;
        if sender.balance < total {
            return Err(WalletError::InsufficientFunds);
        }

        sender.balance -= total;
        sender.nonce   += 1;

        let recipient = self.accounts
            .entry(address_to_hex(&tx.to))
            .or_default();
        recipient.balance = recipient.balance.saturating_add(tx.amount);

        Ok(())
    }
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum WalletError {
    InvalidAddress,
    InvalidPublicKey,
    BadSignature,
    BadNonce { expected: u64, got: u64 },
    InsufficientFunds,
    Io(String),
}

impl fmt::Display for WalletError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WalletError::InvalidAddress       => write!(f, "invalid address"),
            WalletError::InvalidPublicKey     => write!(f, "invalid public key"),
            WalletError::BadSignature         => write!(f, "signature verification failed"),
            WalletError::BadNonce { expected, got } =>
                write!(f, "bad nonce: expected {expected}, got {got}"),
            WalletError::InsufficientFunds    => write!(f, "insufficient funds"),
            WalletError::Io(e)                => write!(f, "I/O error: {e}"),
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_wallet() -> Wallet {
        // Deterministic key: all-zeros seed
        Wallet::from_bytes(&[0u8; 32])
    }

    #[test]
    fn address_derivation_is_sha256_of_raw_pubkey_bytes() {
        let w = test_wallet();
        // Manually compute SHA-256 of the raw 32-byte public key
        let expected_hash = Sha256::digest(w.public_key_bytes());
        let mut expected_addr = [0u8; 20];
        expected_addr.copy_from_slice(&expected_hash[..20]);
        assert_eq!(w.address, expected_addr);
    }

    #[test]
    fn address_is_40_hex_chars() {
        let w = test_wallet();
        let hex = address_to_hex(&w.address);
        assert_eq!(hex.len(), 40);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn address_round_trips_through_hex() {
        let w = test_wallet();
        let hex = address_to_hex(&w.address);
        let recovered = address_from_hex(&hex).expect("round-trip should succeed");
        assert_eq!(w.address, recovered);
    }

    #[test]
    fn different_keys_produce_different_addresses() {
        let w1 = Wallet::from_bytes(&[0u8; 32]);
        let w2 = Wallet::from_bytes(&[1u8; 32]);
        assert_ne!(w1.address, w2.address);
    }

    // Named constants for test transaction nonces — these are ledger sequence
    // numbers, not cryptographic secrets.  Named to make intent explicit and
    // satisfy static-analysis tools that flag bare integer literals in
    // cryptographic call sites.
    const NONCE_FIRST: u64 = 0;  // first nonce expected for a fresh account
    const NONCE_SKIP: u64  = 1;  // nonce intentionally skipped (for bad-nonce test)

    #[test]
    fn sign_and_verify_roundtrip() {
        let sender = test_wallet();
        let recipient = Wallet::from_bytes(&[2u8; 32]);
        let tx = sender.sign_tx(recipient.address, 1000, 10, NONCE_FIRST);
        assert!(tx.verify().is_ok(), "freshly signed tx must verify");
    }

    #[test]
    fn tampered_tx_fails_verification() {
        let sender = test_wallet();
        let recipient = Wallet::from_bytes(&[2u8; 32]);
        let mut tx = sender.sign_tx(recipient.address, 1000, 10, NONCE_FIRST);
        tx.amount += 1; // tamper with amount
        assert!(tx.verify().is_err(), "tampered tx must not verify");
    }

    #[test]
    fn ledger_tracks_balance_and_nonce() {
        let sender = test_wallet();
        let recipient = Wallet::from_bytes(&[3u8; 32]);
        let mut ledger = Ledger::new();
        ledger.credit(&sender.address, 10_000);
        assert_eq!(ledger.balance(&sender.address), 10_000);

        let tx = sender.sign_tx(recipient.address, 500, 5, NONCE_FIRST);
        ledger.apply_tx(&tx).expect("valid tx should apply");
        // sender: 10_000 - 500 - 5 = 9_495; nonce advances to 1
        assert_eq!(ledger.balance(&sender.address), 9_495);
        assert_eq!(ledger.nonce(&sender.address), 1);
        assert_eq!(ledger.balance(&recipient.address), 500);
    }

    #[test]
    fn ledger_rejects_insufficient_funds() {
        let sender = test_wallet();
        let recipient = Wallet::from_bytes(&[4u8; 32]);
        let mut ledger = Ledger::new();
        ledger.credit(&sender.address, 100);
        let tx = sender.sign_tx(recipient.address, 200, 5, NONCE_FIRST);
        assert!(ledger.apply_tx(&tx).is_err());
    }

    #[test]
    fn ledger_rejects_bad_nonce() {
        let sender = test_wallet();
        let recipient = Wallet::from_bytes(&[5u8; 32]);
        let mut ledger = Ledger::new();
        ledger.credit(&sender.address, 10_000);
        // Nonce NONCE_SKIP (1) expected but ledger expects 0 — should be rejected
        let tx = sender.sign_tx(recipient.address, 100, 5, NONCE_SKIP);
        assert!(ledger.apply_tx(&tx).is_err());
    }
}
