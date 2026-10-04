import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes";

/** Same threshold the Rust contract uses: 342 of 512. */
export const ETH_SYNC_SIZE = 512;
export const ETH_MIN_PARTICIPANTS = 342;

const bls = bls12_381;
const long = bls.longSignatures;

export interface EthHeaderFields {
  slot: number;
  proposerIndex: number;
  parentRoot: string;
  stateRoot: string;
  bodyRoot: string;
}

function u64le(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("u64 refused");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** SHA256("equilibrium-eth-lc-v1" || slot || proposer || parent || state || body || participation). */
export function hashEthHeader(header: EthHeaderFields, participation: Uint8Array): Uint8Array {
  if (participation.length !== 64) throw new Error("participation refused");
  return sha256(
    concatBytes(
      utf8("equilibrium-eth-lc-v1"),
      u64le(header.slot),
      u64le(header.proposerIndex),
      hexToBytes(header.parentRoot),
      hexToBytes(header.stateRoot),
      hexToBytes(header.bodyRoot),
      participation,
    ),
  );
}

export function countParticipants(bits: Uint8Array): number {
  let n = 0;
  for (const byte of bits) {
    let b = byte;
    while (b) {
      n += b & 1;
      b >>>= 1;
    }
  }
  return n;
}

export function participationMask(count: number): Uint8Array {
  const bits = new Uint8Array(64);
  const n = Math.max(0, Math.min(512, count));
  for (let i = 0; i < n; i += 1) bits[i >> 3] |= 1 << (i & 7);
  return bits;
}

const COMMITTEE_BYTES = ETH_SYNC_SIZE * 48;
const committees = new Map<number, SyncCommittee>();

export interface SyncCommittee {
  seed: number;
  secrets: Uint8Array[];
  raw: Uint8Array;
  committee: string;
  aggregate: string;
}

/** Exactly 512 compressed keys. Anything else is not a committee. */
export function committeeRaw(hex: string): Uint8Array | null {
  if (typeof hex !== "string") return null;
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length !== COMMITTEE_BYTES * 2) return null;
  return hexToBytes(clean);
}

export function aggregateOf(keys: Uint8Array[]): Uint8Array {
  return long.aggregatePublicKeys(keys).toBytes(true);
}

/** Aggregate of the whole committee. Null when the bytes are not 512 keys. */
export function committeeAggregate(hex: string): string | null {
  const raw = committeeRaw(hex);
  if (!raw) return null;
  const keys: Uint8Array[] = [];
  for (let i = 0; i < ETH_SYNC_SIZE; i += 1) keys.push(raw.subarray(i * 48, (i + 1) * 48));
  try {
    return bytesToHex(aggregateOf(keys));
  } catch {
    return null;
  }
}

/** Aggregate of the keys the bitset selects. The full-committee key is not this. */
export function subsetAggregate(committee: Uint8Array, bits: Uint8Array): Uint8Array {
  if (committee.length !== COMMITTEE_BYTES || bits.length !== 64) throw new Error("eth committee refused");
  const keys: Uint8Array[] = [];
  for (let i = 0; i < ETH_SYNC_SIZE; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
    keys.push(committee.subarray(i * 48, (i + 1) * 48));
  }
  if (!keys.length) throw new Error("eth quorum not met");
  return aggregateOf(keys);
}

export function verifySelectedHeader(
  committeeHex: string,
  header: EthHeaderFields,
  signature: Uint8Array,
  bits: Uint8Array,
): boolean {
  try {
    const raw = committeeRaw(committeeHex);
    if (!raw) return false;
    return verifyEthHeader(subsetAggregate(raw, bits), header, signature, bits);
  } catch {
    return false;
  }
}

export function signSelected(secrets: Uint8Array[], header: EthHeaderFields, bits: Uint8Array): Uint8Array {
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < ETH_SYNC_SIZE; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
    const secret = secrets[i];
    if (!secret) throw new Error("eth committee refused");
    sigs.push(signEthHeader(secret, header, bits));
  }
  if (!sigs.length) throw new Error("eth quorum not met");
  return long.aggregateSignatures(sigs).toBytes(true);
}

export function rotationPayload(nextCommittee: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8("equilibrium-eth-rotate-v1"), nextCommittee));
}

function signPayload(secret: Uint8Array, payload: Uint8Array): Uint8Array {
  return long.sign(long.hash(payload), secret).toBytes(true);
}

function verifyPayload(pubkey: Uint8Array, payload: Uint8Array, signature: Uint8Array): boolean {
  try {
    return long.verify(signature, long.hash(payload), pubkey);
  } catch {
    return false;
  }
}

export function signRotation(secrets: Uint8Array[], bits: Uint8Array, nextRaw: Uint8Array): Uint8Array {
  const payload = rotationPayload(nextRaw);
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < ETH_SYNC_SIZE; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
    const secret = secrets[i];
    if (!secret) throw new Error("eth committee refused");
    sigs.push(signPayload(secret, payload));
  }
  if (!sigs.length) throw new Error("eth quorum not met");
  return long.aggregateSignatures(sigs).toBytes(true);
}

export function verifyRotation(currentHex: string, bits: Uint8Array, signature: Uint8Array, nextRaw: Uint8Array): boolean {
  try {
    const raw = committeeRaw(currentHex);
    if (!raw) return false;
    return verifyPayload(subsetAggregate(raw, bits), rotationPayload(nextRaw), signature);
  } catch {
    return false;
  }
}

/** Deterministic 512-key committee. The aggregate is derived, not chosen. */
export function syncCommittee(seed = 1): SyncCommittee {
  const hit = committees.get(seed);
  if (hit) return hit;
  const secrets: Uint8Array[] = [];
  const pubs: Uint8Array[] = [];
  for (let i = 1; secrets.length < ETH_SYNC_SIZE; i += 1) {
    const sk = new Uint8Array(32);
    const view = new DataView(sk.buffer);
    view.setUint32(0, seed, true);
    view.setUint32(28, i, true);
    try {
      const pk = long.getPublicKey(sk).toBytes(true);
      if (pk.length !== 48) continue;
      secrets.push(sk);
      pubs.push(pk);
    } catch {
      continue;
    }
  }
  const raw = concatBytes(...pubs);
  const built: SyncCommittee = {
    seed,
    secrets,
    raw,
    committee: bytesToHex(raw),
    aggregate: bytesToHex(aggregateOf(pubs)),
  };
  committees.set(seed, built);
  return built;
}

export function ethKeygen(secret?: Uint8Array): { secret: Uint8Array; pubkey: Uint8Array } {
  const sk = secret ?? bls.utils.randomSecretKey();
  return { secret: sk, pubkey: long.getPublicKey(sk).toBytes(true) };
}

export function signEthHeader(secret: Uint8Array, header: EthHeaderFields, participation: Uint8Array): Uint8Array {
  const message = long.hash(hashEthHeader(header, participation));
  return long.sign(message, secret).toBytes(true);
}

export function verifyEthHeader(
  pubkey: Uint8Array,
  header: EthHeaderFields,
  signature: Uint8Array,
  participation: Uint8Array,
): boolean {
  try {
    const message = long.hash(hashEthHeader(header, participation));
    return long.verify(signature, message, pubkey);
  } catch {
    return false;
  }
}

export function hexOf(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export { hexToBytes };
