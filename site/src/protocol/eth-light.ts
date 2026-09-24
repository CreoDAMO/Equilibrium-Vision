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
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** SHA256("equilibrium-eth-lc-v1" || slot || proposer || parent || state || body). */
export function hashEthHeader(header: EthHeaderFields): Uint8Array {
  return sha256(
    concatBytes(
      utf8("equilibrium-eth-lc-v1"),
      u64le(header.slot),
      u64le(header.proposerIndex),
      hexToBytes(header.parentRoot),
      hexToBytes(header.stateRoot),
      hexToBytes(header.bodyRoot),
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

export function ethKeygen(secret?: Uint8Array): { secret: Uint8Array; pubkey: Uint8Array } {
  const sk = secret ?? bls.utils.randomSecretKey();
  return { secret: sk, pubkey: long.getPublicKey(sk).toBytes(true) };
}

export function signEthHeader(secret: Uint8Array, header: EthHeaderFields): Uint8Array {
  const message = long.hash(hashEthHeader(header));
  return long.sign(message, secret).toBytes(true);
}

export function verifyEthHeader(pubkey: Uint8Array, header: EthHeaderFields, signature: Uint8Array): boolean {
  try {
    const message = long.hash(hashEthHeader(header));
    return long.verify(signature, message, pubkey);
  } catch {
    return false;
  }
}

export function hexOf(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export { hexToBytes };
