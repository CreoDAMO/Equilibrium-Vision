import * as ed from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bytesToHex, concatBytes, hexToBytes, u64ToLe } from "./bytes";
import { addressFromPubkeyHex, sha256Hex } from "./crypto";
import type { TxRecord } from "./types";

ed.hashes.sha512 = sha512;

export interface Keypair {
  privateKey: string;
  publicKey: string;
  address: string;
}

export function keypairFromSeed(seed: Uint8Array | string): Keypair {
  const bytes = typeof seed === "string" ? sha256(new TextEncoder().encode(seed)) : seed;
  const { secretKey, publicKey } = ed.keygen(bytes);
  const pubHex = bytesToHex(publicKey);
  return {
    privateKey: bytesToHex(secretKey),
    publicKey: pubHex,
    address: addressFromPubkeyHex(pubHex),
  };
}

export function generateKeypair(): Keypair {
  return keypairFromSeed(ed.utils.randomSecretKey());
}

export function generatePhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function walletFromMnemonic(mnemonic: string, accountIndex = 0, addressIndex = 0): Keypair & {
  mnemonic: string;
  derivationPath: string;
} {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("Invalid mnemonic");
  const seed = mnemonicToSeedSync(mnemonic);
  let node = slip010Master(seed);
  for (const idx of [44, 600, accountIndex, 0, addressIndex]) {
    node = slip010Child(node, idx);
  }
  const kp = keypairFromSeed(node.key);
  return {
    ...kp,
    mnemonic,
    derivationPath: `m/44'/600'/${accountIndex}'/0'/${addressIndex}'`,
  };
}

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

export function signingBytes(tx: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  publicKey: string;
  chainId: number;
}): Uint8Array {
  return concatBytes(
    hexToBytes(tx.from),
    hexToBytes(tx.to),
    u64ToLe(tx.amount),
    u64ToLe(tx.fee),
    u64ToLe(tx.nonce),
    hexToBytes(tx.publicKey),
    u64ToLe(tx.chainId),
  );
}

export function signTx(
  kp: Keypair,
  input: { to: string; amount: number; fee: number; nonce: number; chainId: number; timestamp?: number },
): TxRecord {
  const body = {
    from: kp.address,
    to: input.to,
    amount: input.amount,
    fee: input.fee,
    nonce: input.nonce,
    publicKey: kp.publicKey,
    chainId: input.chainId,
  };
  const msg = signingBytes(body);
  const sig = ed.sign(msg, hexToBytes(kp.privateKey));
  const signature = bytesToHex(sig);
  const hash = sha256Hex(concatBytes(msg, sig));
  return {
    hash,
    from: kp.address,
    to: input.to,
    amount: input.amount,
    fee: input.fee,
    nonce: input.nonce,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    status: "pending",
    signature,
    publicKey: kp.publicKey,
    blockHash: null,
    blockHeight: null,
  };
}

export function verifyTx(tx: TxRecord, chainId: number): boolean {
  try {
    const msg = signingBytes({
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      fee: tx.fee,
      nonce: tx.nonce,
      publicKey: tx.publicKey,
      chainId,
    });
    const ok = ed.verify(hexToBytes(tx.signature), msg, hexToBytes(tx.publicKey));
    if (!ok) return false;
    const addr = addressFromPubkeyHex(tx.publicKey);
    return addr === tx.from;
  } catch {
    return false;
  }
}

export { addressFromPubkeyHex };
