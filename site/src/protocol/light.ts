import type { BlockRecord, NetworkParams, VerificationReport } from "./types";
import { evaluateResidual } from "./solver";
import { verifyStationaryEvidence } from "./verify";

export interface IndependentReport extends VerificationReport {
  localResidual: number;
  claimedResidual: number;
  discoveryIters: number;
  agree: boolean;
}

/**
 * Cheap path: one residual evaluation, no nonce search.
 * This is what a mobile / light body is allowed to do.
 */
export function independentVerify(
  block: BlockRecord,
  prev: BlockRecord | null,
  params: NetworkParams,
): IndependentReport {
  const report = verifyStationaryEvidence({
    block,
    prev,
    mempoolPressure: block.committedPressure,
    cumulativeWork: block.height,
    params,
  });
  const local = evaluateResidual(
    {
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      timestamp: block.timestamp,
      nonce: block.nonce,
      difficulty: block.difficulty,
    },
    block.transactions.map((t) => ({ hash: t.hash, fee: t.fee })),
    { cumulativeWork: block.height, mempoolPressure: block.committedPressure },
    block.couplings,
  );
  const agree = Math.abs(local.canonical - block.residual) < 1e-12 && report.ok;
  return {
    ...report,
    localResidual: local.canonical,
    claimedResidual: block.residual,
    discoveryIters: block.solverIterations,
    agree,
  };
}

/** Construct a dishonest candidate that claims a residual it did not earn. */
export function forgeResidual(block: BlockRecord, residual = 1e-12): BlockRecord {
  return { ...block, residual, residualFp: 0, verifyNotes: ["forged residual"] };
}
