import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hex32, u64ToLe } from "./bytes";
import {
  DEFAULT_COUPLINGS,
  type Couplings,
  type ResidualBreakdown,
} from "./types";
import { PHI, residualToFixed, u64LeFromHash } from "./crypto";

export interface SolverHeader {
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: number;
  difficulty: number;
}

export interface SolverTx {
  hash: string;
  fee: number;
}

export interface SolverState {
  cumulativeWork: number;
  mempoolPressure: number;
}

export interface SolveInput {
  header: SolverHeader;
  txs: SolverTx[];
  state: SolverState;
  couplings?: Couplings;
  maxIter?: number;
  recursionDepth?: number;
  target?: number;
}

export interface SolveResult {
  nonce: number;
  residual: number;
  residualFp: number;
  breakdown: ResidualBreakdown;
  iterations: number;
  reachedTarget: boolean;
}

const TWO_64 = 2 ** 64;

function headerDigest(header: SolverHeader, txs: SolverTx[]): Uint8Array {
  const parts: Uint8Array[] = [
    hex32(header.prevHash),
    hex32(header.merkleRoot),
    u64ToLe(header.timestamp),
    u64ToLe(header.nonce),
  ];
  for (const tx of txs) parts.push(hex32(tx.hash));
  return sha256(concatBytes(...parts));
}

/**
 * Territory residual — faithful to `stationary_solver.rs`.
 * Hash term uses a raw u64 against difficulty, so it saturates on almost
 * every nonce. Kept as evidence, not as the consensus quantity.
 */
export function territoryResidual(
  header: SolverHeader,
  txs: SolverTx[],
  state: SolverState,
  lambda: Couplings,
): { residual: number; hashVal: bigint } {
  const digest = headerDigest(header, txs);
  const hashVal = u64LeFromHash(digest);
  const difficulty = header.difficulty;
  const hashViolation = Math.max(Number(hashVal) - difficulty, 0);
  const structuralViolation = Math.abs(Number(hashVal) - difficulty / PHI);
  const chainViolation = state.cumulativeWork > 0 ? 0 : 1;
  const mempoolViolation = state.mempoolPressure;
  const totalFees = txs.reduce((s, t) => s + t.fee, 0);
  const feeDeficit = state.mempoolPressure * 1_000_000;
  const txViolation = totalFees >= feeDeficit ? 0 : (feeDeficit - totalFees) / 1_000_000;

  const residual =
    lambda.hash * hashViolation ** 2 +
    lambda.structural * structuralViolation ** 2 +
    lambda.continuity * chainViolation ** 2 +
    lambda.mempool * mempoolViolation ** 2 +
    lambda.fees * txViolation ** 2;

  return { residual, hashVal };
}

/**
 * Canonical residual — dimensionless couplings that can actually stationarize.
 * This is the rebuild quantity used for acceptance, reward, and fork-choice.
 *
 * v_hash        : max(h − τ, 0)          h ∈ [0,1), τ from difficulty
 * v_structural  : |h − 1/φ|
 * v_continuity  : 0 if chain has work else 1
 * v_mempool     : mempool pressure ∈ [0,1]
 * v_fees        : uncovered fee demand ∈ [0,1]
 */
export function evaluateResidual(
  header: SolverHeader,
  txs: SolverTx[],
  state: SolverState,
  lambda: Couplings = DEFAULT_COUPLINGS,
): ResidualBreakdown {
  const digest = headerDigest(header, txs);
  const hashVal = u64LeFromHash(digest);
  const hFrac = Number(hashVal) / TWO_64;
  const tau = Math.min(0.95, Math.max(0.05, 1_000_000 / (header.difficulty + 1_000_000) + 0.35));

  const vHash = Math.max(hFrac - tau, 0);
  const vStruct = Math.abs(hFrac - 1 / PHI);
  const vChain = state.cumulativeWork > 0 ? 0 : 1;
  const vMem = Math.min(1, Math.max(0, state.mempoolPressure));
  const totalFees = txs.reduce((s, t) => s + t.fee, 0);
  const feeDemand = vMem;
  const vFee = Math.max(0, feeDemand - Math.min(1, totalFees / 1_000_000));

  const canonical =
    lambda.hash * vHash ** 2 +
    lambda.structural * vStruct ** 2 +
    lambda.continuity * vChain ** 2 +
    lambda.mempool * vMem ** 2 +
    lambda.fees * vFee ** 2;

  const terr = territoryResidual(header, txs, state, lambda);

  return {
    canonical,
    canonicalFp: residualToFixed(canonical),
    territory: terr.residual,
    territoryFp: residualToFixed(terr.residual),
    violations: {
      hash: vHash,
      structural: vStruct,
      continuity: vChain,
      mempool: vMem,
      fees: vFee,
    },
    lambdas: { ...lambda },
    hFrac,
    hashVal: hashVal.toString(),
  };
}

export function solveStationary(input: SolveInput): SolveResult {
  const lambda = input.couplings ?? DEFAULT_COUPLINGS;
  const maxIter = input.maxIter ?? 400;
  const depth = input.recursionDepth ?? 2;
  const target = input.target ?? 1e-4;

  let header: SolverHeader = { ...input.header };
  let best = evaluateResidual(header, input.txs, input.state, lambda);
  let bestNonce = header.nonce;
  let iterations = 0;
  let reached = best.canonical < target;

  for (let d = 0; d < depth && !reached; d++) {
    for (let i = 0; i < maxIter; i++) {
      iterations++;
      header = { ...header, nonce: (header.nonce + 1 + ((i * 0x9e3779b9) >>> 0)) >>> 0 };
      const br = evaluateResidual(header, input.txs, input.state, lambda);
      if (br.canonical < best.canonical) {
        best = br;
        bestNonce = header.nonce;
        if (br.canonical < target) {
          reached = true;
          break;
        }
      }
    }
  }

  return {
    nonce: bestNonce,
    residual: best.canonical,
    residualFp: best.canonicalFp,
    breakdown: best,
    iterations,
    reachedTarget: reached,
  };
}
