import { createHash } from "crypto";

/**
 * Bitcoin header admission. Same PoW check as the public kernel.
 * A bare hash is not a tip. Nothing here mints EQU.
 * The hash is sha256d of the raw header, not the reversed display hash.
 */
export const BTC_GENESIS_HEADER_HEX =
  "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";

function sha256d(raw: Buffer): Buffer {
  return createHash("sha256").update(createHash("sha256").update(raw).digest()).digest();
}

function bitsToTarget(bits: number): Buffer {
  const exponent = (bits >>> 24) & 0xff;
  const mantissa = bits & 0x00ffffff;
  const target = Buffer.alloc(32);
  if (exponent <= 0 || exponent > 32) return target;
  const start = 32 - exponent;
  const mantissaBytes = [(mantissa >>> 16) & 0xff, (mantissa >>> 8) & 0xff, mantissa & 0xff];
  for (let i = 0; i < 3; i += 1) {
    const at = start + i;
    if (at >= 0 && at < 32) target[at] = mantissaBytes[i]!;
  }
  return target;
}

function compareBe(a: Buffer, b: Buffer): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/** Returns the header hash when the 80-byte header meets its target. Otherwise null. */
export function btcHeaderHash(headerHex: string): string | null {
  const clean = headerHex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== 160) return null;
  const raw = Buffer.from(clean, "hex");
  if (raw.length !== 80) return null;
  const hash = sha256d(raw);
  const hashBe = Buffer.from(hash).reverse();
  const target = bitsToTarget(raw.readUInt32LE(72));
  if (compareBe(hashBe, target) > 0) return null;
  return hash.toString("hex");
}
