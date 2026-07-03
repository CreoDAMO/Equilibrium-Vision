import * as ed from "@noble/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

// ── Address derivation ─────────────────────────────────────────────────────────

export async function deriveAddress(pubKeyHex: string): Promise<string> {
  const data = new TextEncoder().encode(pubKeyHex);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

// ── Raw keypair ────────────────────────────────────────────────────────────────

export async function generateWallet() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const privHex = ed.etc.bytesToHex(privateKey);
  const pubHex = ed.etc.bytesToHex(publicKey);
  const address = await deriveAddress(pubHex);
  return { privateKey: privHex, publicKey: pubHex, address, walletType: "raw" as const };
}

export async function importFromPrivKey(privHex: string) {
  const privateKey = ed.utils.hexToBytes(privHex);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const pubHex = ed.etc.bytesToHex(publicKey);
  const address = await deriveAddress(pubHex);
  return { privateKey: privHex, publicKey: pubHex, address, walletType: "raw" as const };
}

// ── BIP-39 Mnemonic ───────────────────────────────────────────────────────────

export function generateMnemonic(strength: 128 | 256 = 128): string {
  return bip39Generate(wordlist, strength);
}

export function validateMnemonicPhrase(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

// ── SLIP-0010 Ed25519 HD derivation ───────────────────────────────────────────
// Coin type: 600 (Equilibrium)
// Path: m/44'/600'/account'/0'/index'
// All derivations are hardened (required for Ed25519 in SLIP-0010)

function slip010Master(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function slip010Child(
  parent: { key: Uint8Array; chainCode: Uint8Array },
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const idx = (index | 0x80000000) >>> 0;
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, idx, false);
  const data = new Uint8Array([0x00, ...parent.key, ...indexBytes]);
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

export async function mnemonicToWallet(
  mnemonic: string,
  accountIndex = 0,
  addressIndex = 0,
) {
  if (!validateMnemonicPhrase(mnemonic)) throw new Error("Invalid mnemonic phrase");
  const seed = mnemonicToSeedSync(mnemonic);
  let node = slip010Master(seed);
  for (const idx of [44, 600, accountIndex, 0, addressIndex]) {
    node = slip010Child(node, idx);
  }
  const privateKey = node.key;
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const privHex = ed.etc.bytesToHex(privateKey);
  const pubHex = ed.etc.bytesToHex(publicKey);
  const address = await deriveAddress(pubHex);
  return {
    privateKey: privHex,
    publicKey: pubHex,
    address,
    mnemonic,
    derivationPath: `m/44'/600'/${accountIndex}'/0'/${addressIndex}'`,
    walletType: "mnemonic" as const,
  };
}

// ── AES-GCM Encrypted Keystore ────────────────────────────────────────────────

export interface EncryptedKeystore {
  version: 2;
  kdf: "pbkdf2";
  salt: string;
  iv: string;
  iterations: number;
  hash: "SHA-256";
  ciphertext: string;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveAESKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export async function encryptKeystore(
  secret: string,
  password: string,
): Promise<EncryptedKeystore> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 100_000;
  const key = await deriveAESKey(password, salt, iterations, ["encrypt"]);
  const plaintext = new TextEncoder().encode(secret);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return {
    version: 2,
    kdf: "pbkdf2",
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    iterations,
    hash: "SHA-256",
    ciphertext: bytesToHex(ciphertext),
  };
}

export async function decryptKeystore(
  ks: EncryptedKeystore,
  password: string,
): Promise<string> {
  const salt = hexToBytes(ks.salt);
  const iv = hexToBytes(ks.iv);
  const ciphertext = hexToBytes(ks.ciphertext);
  const key = await deriveAESKey(password, salt, ks.iterations, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Incorrect password or corrupted keystore");
  }
}

export function serializeKeystore(ks: EncryptedKeystore): string {
  return JSON.stringify(ks, null, 2);
}

export function parseKeystore(json: string): EncryptedKeystore {
  const parsed = JSON.parse(json);
  if (parsed.version !== 2 || parsed.kdf !== "pbkdf2") {
    throw new Error("Unsupported keystore format (expected version 2, pbkdf2)");
  }
  return parsed as EncryptedKeystore;
}

// ── Multi-sig m-of-n Ed25519 ──────────────────────────────────────────────────

export interface MultisigConfig {
  threshold: number;
  pubKeys: string[];
  address: string;
  walletType: "multisig";
}

export interface MultisigSignature {
  signerPubKey: string;
  signature: string;
}

export async function createMultisigAddress(
  pubKeys: string[],
  threshold: number,
): Promise<MultisigConfig> {
  if (threshold < 1 || threshold > pubKeys.length) {
    throw new Error(`Threshold ${threshold} is invalid for ${pubKeys.length} keys`);
  }
  const sorted = [...pubKeys].sort();
  const payload = new TextEncoder().encode(`multisig:${threshold}:${sorted.join(",")}`);
  const hash = sha256(payload);
  const address = Array.from(hash)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
  return { threshold, pubKeys: sorted, address, walletType: "multisig" };
}

export async function signForMultisig(
  privateKeyHex: string,
  from: string,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
): Promise<MultisigSignature> {
  const msg = new TextEncoder().encode(`${from}${to}${amount}${fee}${nonce}`);
  const sig = await ed.signAsync(msg, privateKeyHex);
  const pubKey = ed.etc.bytesToHex(
    await ed.getPublicKeyAsync(ed.utils.hexToBytes(privateKeyHex)),
  );
  return { signerPubKey: pubKey, signature: ed.etc.bytesToHex(sig) };
}

export async function verifyMultisigThreshold(
  signatures: MultisigSignature[],
  config: MultisigConfig,
  from: string,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
): Promise<boolean> {
  const msg = new TextEncoder().encode(`${from}${to}${amount}${fee}${nonce}`);
  let valid = 0;
  for (const { signerPubKey, signature } of signatures) {
    if (!config.pubKeys.includes(signerPubKey)) continue;
    try {
      const ok = await ed.verifyAsync(
        ed.utils.hexToBytes(signature),
        msg,
        ed.utils.hexToBytes(signerPubKey),
      );
      if (ok) valid++;
    } catch {
      // invalid sig — skip
    }
  }
  return valid >= config.threshold;
}

// ── TX signing ────────────────────────────────────────────────────────────────

export async function signTx(
  privHex: string,
  from: string,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
): Promise<string> {
  const msg = new TextEncoder().encode(`${from}${to}${amount}${fee}${nonce}`);
  const sig = await ed.signAsync(msg, privHex);
  return ed.etc.bytesToHex(sig);
}
