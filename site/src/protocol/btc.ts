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

/** `p2pkh`/`p2wpkh` are 20 bytes. `p2wsh`/`p2tr` are 32. Anything else is not a destination. */
export function isBtcDestination(destination: string): boolean {
  return /^(p2pkh|p2wpkh):[0-9a-f]{40}$/.test(destination) || /^(p2wsh|p2tr):[0-9a-f]{64}$/.test(destination);
}

function scriptDestination(script: Uint8Array): string | null {
  const hex = bytesToHex(script);
  if (
    script.length === 25
    && script[0] === 0x76
    && script[1] === 0xa9
    && script[2] === 0x14
    && script[23] === 0x88
    && script[24] === 0xac
  ) {
    return `p2pkh:${hex.slice(6, 46)}`;
  }
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return `p2wpkh:${hex.slice(4)}`;
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return `p2wsh:${hex.slice(4)}`;
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return `p2tr:${hex.slice(4)}`;
  return null;
}

function readCompact(raw: Uint8Array, offset: number): { n: number; next: number } | null {
  if (offset >= raw.length) return null;
  const first = raw[offset]!;
  if (first < 0xfd) return { n: first, next: offset + 1 };
  if (first === 0xfd) {
    if (offset + 3 > raw.length) return null;
    return { n: raw[offset + 1]! + raw[offset + 2]! * 256, next: offset + 3 };
  }
  if (first === 0xfe) {
    if (offset + 5 > raw.length) return null;
    const view = new DataView(raw.buffer, raw.byteOffset + offset + 1, 4);
    return { n: view.getUint32(0, true), next: offset + 5 };
  }
  return null;
}

function readSafeU64(raw: Uint8Array, offset: number): number | null {
  let acc = 0;
  for (let i = 0; i < 8; i += 1) {
    const byte = raw[offset + i]!;
    if (byte === 0) continue;
    const add = byte * 2 ** (8 * i);
    if (!Number.isSafeInteger(add) || !Number.isSafeInteger(acc + add)) return null;
    acc += add;
  }
  return acc;
}

export interface ParsedBtcTx {
  /** sha256d of the non-witness serialization. Not the display-reversed txid. */
  txid: string;
  outputs: Array<{ value: number | null; destination: string | null }>;
}

/**
 * Bitcoin transaction. Witness bytes are skipped for the txid.
 * An unknown script leaves destination null. A value above the safe integer range leaves value null.
 */
export function parseBtcTx(raw: Uint8Array): ParsedBtcTx | null {
  if (raw.length < 10) return null;
  const version = raw.slice(0, 4);
  let i = 4;
  let segwit = false;
  if (raw[4] === 0x00 && raw[5] === 0x01) {
    segwit = true;
    i = 6;
  }
  const bodyStart = i;
  const vin = readCompact(raw, i);
  if (!vin || vin.n > 10_000) return null;
  i = vin.next;
  for (let n = 0; n < vin.n; n += 1) {
    if (i + 36 > raw.length) return null;
    i += 36;
    const script = readCompact(raw, i);
    if (!script || script.n > raw.length - script.next) return null;
    i = script.next + script.n;
    if (i + 4 > raw.length) return null;
    i += 4;
  }
  const vout = readCompact(raw, i);
  if (!vout || vout.n > 10_000) return null;
  i = vout.next;
  const outputs: ParsedBtcTx["outputs"] = [];
  for (let n = 0; n < vout.n; n += 1) {
    if (i + 8 > raw.length) return null;
    const value = readSafeU64(raw, i);
    i += 8;
    const script = readCompact(raw, i);
    if (!script || script.n > raw.length - script.next) return null;
    const bytes = raw.slice(script.next, script.next + script.n);
    i = script.next + script.n;
    outputs.push({ value, destination: scriptDestination(bytes) });
  }
  const bodyEnd = i;
  if (segwit) {
    for (let n = 0; n < vin.n; n += 1) {
      const count = readCompact(raw, i);
      if (!count || count.n > 10_000) return null;
      i = count.next;
      for (let w = 0; w < count.n; w += 1) {
        const item = readCompact(raw, i);
        if (!item || item.n > raw.length - item.next) return null;
        i = item.next + item.n;
      }
    }
  }
  if (i + 4 !== raw.length) return null;
  const locktime = raw.slice(i);
  const legacy = segwit
    ? new Uint8Array(version.length + (bodyEnd - bodyStart) + locktime.length)
    : raw;
  if (segwit) {
    legacy.set(version, 0);
    legacy.set(raw.slice(bodyStart, bodyEnd), version.length);
    legacy.set(locktime, version.length + (bodyEnd - bodyStart));
  }
  return { txid: bytesToHex(sha256d(legacy)), outputs };
}

export function decodeTxHex(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  return hexToBytes(clean);
}

/** One legacy input and one p2pkh output. The txid is sha256d of these bytes. */
export function buildP2pkhTx(value: number, hash160Hex: string): Uint8Array | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  if (!/^[0-9a-f]{40}$/.test(hash160Hex)) return null;
  const hash160 = hexToBytes(hash160Hex);
  const out: number[] = [0x01, 0x00, 0x00, 0x00, 0x01];
  for (let i = 0; i < 32; i += 1) out.push(0);
  out.push(0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out.push(rest % 256);
    rest = Math.floor(rest / 256);
  }
  out.push(0x19, 0x76, 0xa9, 0x14);
  for (const byte of hash160) out.push(byte);
  out.push(0x88, 0xac, 0x00, 0x00, 0x00, 0x00);
  return Uint8Array.from(out);
}

/**
 * Derive the output, then require that txid under the header merkle root.
 * The caller does not get to name the destination or the amount.
 */
export function proveBtcOutput(
  raw: Uint8Array,
  vout: number,
  merkleHex: string[],
  rootHex: string,
): { ok: true; txid: string; destination: string; amount: number; locator: string } | { ok: false; error: string } {
  const parsed = parseBtcTx(raw);
  if (!parsed) return { ok: false, error: "btc transaction refused" };
  if (!Number.isSafeInteger(vout) || vout < 0 || vout >= parsed.outputs.length) {
    return { ok: false, error: "btc output refused" };
  }
  const output = parsed.outputs[vout]!;
  if (output.value === null) return { ok: false, error: "btc output refused" };
  if (!output.destination) return { ok: false, error: "btc script refused" };
  if (!/^[0-9a-f]{64}$/.test(rootHex) || !/^[0-9a-f]{64}$/.test(parsed.txid)) {
    return { ok: false, error: "btc merkle refused" };
  }
  let root: Uint8Array;
  const proof: Uint8Array[] = [];
  try {
    root = hexToBytes(rootHex);
    for (const entry of merkleHex) {
      if (!/^[0-9a-f]{64}$/.test(entry)) return { ok: false, error: "btc merkle refused" };
      proof.push(hexToBytes(entry));
    }
  } catch {
    return { ok: false, error: "btc merkle refused" };
  }
  if (!verifyBtcMerkle(hexToBytes(parsed.txid), proof, root)) return { ok: false, error: "btc merkle refused" };
  return {
    ok: true,
    txid: parsed.txid,
    destination: output.destination,
    amount: output.value,
    locator: `${parsed.txid}:${vout}`,
  };
}
