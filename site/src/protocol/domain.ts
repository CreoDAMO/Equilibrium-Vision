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

const SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A foreign consensus nonce. An in-range bigint, strict decimal text, or a safe integer.
 * Missing, malformed, fractional, and unsafe values are refused. Never a default of 0.
 */
export function foreignNonce(value: unknown): bigint {
  if (typeof value === "bigint") return blockNonce(value);
  if (typeof value === "number") return asBlockNonce(value);
  if (typeof value === "string") {
    try {
      return blockNonce(decodeU64Decimal(value));
    } catch {
      throw new Error("nonce is not a u64");
    }
  }
  throw new Error("nonce is not a u64");
}

/**
 * JSON wire. A safe u64 stays a number so a miner sending nonce 6 still works.
 * A larger u64 is decimal text. JSON.parse of that text does not collapse it.
 */
export function wireNonce(value: number | bigint): number | string {
  const n = asBlockNonce(value);
  return n <= SAFE_U64 ? Number(n) : n.toString();
}

/** JSON text for a value that may carry a block nonce. A u64 above 2^53 is a string, not a raw integer. */
export function stringifyCanonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "bigint") return item;
    if (item < 0n || item > U64_MAX) throw new Error("nonce is not a u64");
    return item <= SAFE_U64 ? Number(item) : item.toString();
  });
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
