export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u64ToLe(n: number | bigint): Uint8Array {
  const v = BigInt(n) & 0xffffffffffffffffn;
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, v, true);
  return out;
}

export function u32ToLe(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function hex32(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length === 32) return b;
  const out = new Uint8Array(32);
  out.set(b.subarray(0, Math.min(32, b.length)));
  return out;
}
