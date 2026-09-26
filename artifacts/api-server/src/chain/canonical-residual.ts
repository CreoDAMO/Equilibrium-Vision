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
  nonce: number;
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

function u64ToLe(n: number): Uint8Array {
  const v = BigInt(Math.floor(n)) & 0xffffffffffffffffn;
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
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
    u64ToLe(header.timestamp),
    u64ToLe(header.nonce),
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
 * same number and that number is under the target. The claim is not the rule.
 */
export function admitResidual(
  claimed: number,
  recomputed: number,
  target = CANONICAL_RESIDUAL_TARGET,
): { ok: true; residual: number } | { ok: false; error: string } {
  if (!Number.isFinite(recomputed) || recomputed < 0 || !(recomputed < target)) {
    return { ok: false, error: "recomputed residual is not under the admission target" };
  }
  if (!Number.isFinite(claimed) || Math.abs(claimed - recomputed) > 1e-12) {
    return { ok: false, error: "claimed residual does not match the recomputed residual" };
  }
  return { ok: true, residual: recomputed };
}
