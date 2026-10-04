import { sha256 } from "@noble/hashes/sha2.js";
import { CANONICAL_RESIDUAL_TARGET } from "@workspace/coinomics";

/**
 * Canonical residual. Same quantity as `evaluateResidual` in
 * `site/src/protocol/solver.ts`. Territory residual is not this number.
 * A claimed residual is admitted only when it matches this recompute
 * and the recompute is under the network target.
 */

const PHI = (1 + Math.sqrt(5)) / 2;
const TWO_64 = 2 ** 64;

export interface CanonicalHeader {
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  /** Exact u64. An unsafe number is refused. */
  nonce: number | bigint;
  difficulty: number;
}

export interface CanonicalTx {
  hash: string;
  fee: number;
}

export interface CanonicalCouplings {
  hash: number;
  structural: number;
  continuity: number;
  mempool: number;
  fees: number;
}

const COUPLINGS: CanonicalCouplings = {
  hash: 1,
  structural: 1,
  continuity: 1,
  mempool: 1,
  fees: 1,
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

function hex32(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length === 32) return b;
  const out = new Uint8Array(32);
  out.set(b.subarray(0, Math.min(32, b.length)));
  return out;
}

function u64Bytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** Timestamp bytes. Floor, then the low 64 bits. This is not the nonce path. */
function u64Masked(n: number): Uint8Array {
  return u64Bytes(BigInt(Math.floor(n)) & 0xffffffffffffffffn);
}

/** Nonce bytes. Exact. An unsafe number is refused, not rounded. */
function u64Exact(n: number | bigint): Uint8Array {
  let v: bigint;
  if (typeof n === "bigint") v = n;
  else if (Number.isSafeInteger(n) && n >= 0) v = BigInt(n);
  else throw new Error("u64 refused");
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error("u64 refused");
  return u64Bytes(v);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

function headerDigest(header: CanonicalHeader, txs: CanonicalTx[]): Uint8Array {
  const parts: Uint8Array[] = [
    hex32(header.prevHash),
    hex32(header.merkleRoot),
    u64Masked(header.timestamp),
    u64Exact(header.nonce),
  ];
  for (const tx of txs) parts.push(hex32(tx.hash));
  return sha256(concatBytes(...parts));
}

/** Dimensionless residual used for admission and reward. */
export function canonicalResidual(
  header: CanonicalHeader,
  txs: CanonicalTx[],
  state: { cumulativeWork: number; mempoolPressure: number },
  lambda: CanonicalCouplings = COUPLINGS,
): number {
  const digest = headerDigest(header, txs);
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const hashVal = view.getBigUint64(0, true);
  const hFrac = Number(hashVal) / TWO_64;
  const tau = Math.min(0.95, Math.max(0.05, 1_000_000 / (header.difficulty + 1_000_000) + 0.35));
  const vHash = Math.max(hFrac - tau, 0);
  const vStruct = Math.abs(hFrac - 1 / PHI);
  const vChain = state.cumulativeWork > 0 ? 0 : 1;
  const vMem = Math.min(1, Math.max(0, state.mempoolPressure));
  const totalFees = txs.reduce((s, t) => s + t.fee, 0);
  const vFee = Math.max(0, vMem - Math.min(1, totalFees / 1_000_000));
  return (
    lambda.hash * vHash ** 2 +
    lambda.structural * vStruct ** 2 +
    lambda.continuity * vChain ** 2 +
    lambda.mempool * vMem ** 2 +
    lambda.fees * vFee ** 2
  );
}

/**
 * A claimed residual enters a block only when this process recomputes the
 * same fingerprint, floor(R × 1e18), and that number is under the target.
 * A float window is not the comparison. The claim is not the rule.
 */
export function residualFingerprint(residual: number): bigint {
  if (!Number.isFinite(residual) || residual < 0) return -1n;
  return BigInt(Math.floor(residual * 1e18));
}

export function admitResidual(
  claimed: number,
  recomputed: number,
  target = CANONICAL_RESIDUAL_TARGET,
): { ok: true; residual: number } | { ok: false; error: string } {
  const recomputedFp = residualFingerprint(recomputed);
  if (recomputedFp < 0n || !(recomputed < target)) {
    return { ok: false, error: "recomputed residual is not under the admission target" };
  }
  if (residualFingerprint(claimed) !== recomputedFp) {
    return { ok: false, error: "claimed residual fingerprint does not match the recomputed residual" };
  }
  return { ok: true, residual: recomputed };
}

/** Pressure is block evidence. The receiver's mempool is not a substitute. */
export function pressureEvidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}
