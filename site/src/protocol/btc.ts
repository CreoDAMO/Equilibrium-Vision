import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./bytes";

/**
 * Bitcoin header checks from contracts/btc_spv_bridge.
 * PoW and continuity only. Nothing here mints EQU.
 *
 * Genesis header, 80 bytes. The first admitted header may be this one.
 */
export const BTC_GENESIS_HEADER_HEX =
  "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";

export interface ParsedBtcHeader {
  prevHash: string;
  merkleRoot: string;
  bits: number;
  /** sha256d of the raw header. This is what the next header's prev must equal. */
  hash: string;
}

export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** Bitcoin compact nBits → 32-byte big-endian target. */
export function bitsToTarget(bits: number): Uint8Array {
  const exponent = (bits >>> 24) & 0xff;
  const mantissa = bits & 0x00ffffff;
  const target = new Uint8Array(32);
  if (exponent <= 0 || exponent > 32) return target;
  const start = 32 - exponent;
  const mantissaBytes = [(mantissa >>> 16) & 0xff, (mantissa >>> 8) & 0xff, mantissa & 0xff];
  for (let i = 0; i < 3; i += 1) {
    const at = start + i;
    if (at >= 0 && at < 32) target[at] = mantissaBytes[i]!;
  }
  return target;
}

function compareBe(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function parseBtcHeader(raw: Uint8Array): ParsedBtcHeader {
  if (raw.length !== 80) throw new Error("Bitcoin header is 80 bytes");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    prevHash: bytesToHex(raw.subarray(4, 36)),
    merkleRoot: bytesToHex(raw.subarray(36, 68)),
    bits: view.getUint32(72, true),
    hash: bytesToHex(sha256d(raw)),
  };
}

/** SHA256d(header) ≤ target(bits), compared big-endian as the Rust contract does. */
export function verifyBtcPow(raw: Uint8Array): boolean {
  if (raw.length !== 80) return false;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const hashBe = sha256d(raw).slice().reverse();
  return compareBe(hashBe, bitsToTarget(view.getUint32(72, true))) <= 0;
}

/**
 * Bitcoin merkle inclusion. Siblings are concatenated in the order given.
 * An empty proof means the tx hash is the root.
 */
export function verifyBtcMerkle(txHash: Uint8Array, proof: Uint8Array[], root: Uint8Array): boolean {
  if (txHash.length !== 32 || root.length !== 32) return false;
  let current = txHash;
  for (const sibling of proof) {
    if (sibling.length !== 32) return false;
    const combined = new Uint8Array(64);
    combined.set(current, 0);
    combined.set(sibling, 32);
    current = sha256d(combined);
  }
  return bytesToHex(current) === bytesToHex(root);
}

export function decodeHeaderHex(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{160}$/.test(clean)) return null;
  return hexToBytes(clean);
}
