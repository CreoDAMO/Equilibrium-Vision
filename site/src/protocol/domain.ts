/**
 * The only decoder for constitutional integers and participation.
 * A JavaScript number is not an input. 2^53+1 survives here and collapses in Number.
 */
export const U64_MAX = (1n << 64n) - 1n;
export const PARTICIPATION_BYTES = 64;

export function encodeU64(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new Error("u64 refused");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function decodeU64(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) throw new Error("u64 refused");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

/** Decimal text, no sign, no fraction, no leading zero. */
export function decodeU64Decimal(text: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("u64 refused");
  const value = BigInt(text);
  if (value > U64_MAX) throw new Error("u64 refused");
  return value;
}

export function popcount(bits: Uint8Array): number {
  let n = 0;
  for (const byte of bits) {
    let rest = byte;
    while (rest) {
      n += rest & 1;
      rest >>>= 1;
    }
  }
  return n;
}

export function blockNonce(value: bigint): bigint {
  if (value < 0n || value > U64_MAX) throw new Error("nonce is not a u64");
  return value;
}

/** A stored safe integer is already a u64. An unsafe number is refused, not rounded. */
export function asBlockNonce(value: number | bigint): bigint {
  if (typeof value === "bigint") return blockNonce(value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("nonce is not a u64");
  return blockNonce(BigInt(value));
}

/** JSON text that keeps a u64 bigint as a decimal integer, not a string and not a JS number. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `__U64__${item.toString()}` : item)).replaceAll(
    /"__U64__(\d+)"/g,
    "$1",
  );
}
/** Exactly 64 bytes. The participant count is popcount of these bits, never a second field. */
export function participationBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(clean)) throw new Error("participation refused");
  const out = new Uint8Array(PARTICIPATION_BYTES);
  for (let i = 0; i < PARTICIPATION_BYTES; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
