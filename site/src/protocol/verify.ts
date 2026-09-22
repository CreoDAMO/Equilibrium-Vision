import type { BlockRecord, NetworkParams, TxRecord, VerificationReport } from "./types";
import { canonicalHeaderHash, merkleRoot } from "./crypto";
import { evaluateResidual } from "./solver";
import { verifyTx } from "./wallet";

const MAX_FUTURE_SECS = 7200;

export function verifyStationaryEvidence(args: {
  block: BlockRecord;
  prev: BlockRecord | null;
  mempoolPressure?: number;
  cumulativeWork?: number;
  params: NetworkParams;
  now?: number;
}): VerificationReport {
  const { block, prev, params } = args;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const pressure = args.mempoolPressure ?? block.committedPressure;
  const work = args.cumulativeWork ?? block.height;
  const checks: VerificationReport["checks"] = [];

  const continuity =
    block.height === 0
      ? block.prevHash === "0".repeat(64)
      : !!prev && prev.hash === block.prevHash && prev.height + 1 === block.height;
  checks.push({
    name: "continuity",
    ok: continuity,
    detail: continuity
      ? `prev ${block.prevHash.slice(0, 12)}… matches`
      : "predecessor hash or height mismatch",
  });

  const notFuture = block.timestamp - now <= MAX_FUTURE_SECS;
  const monotonic = block.height === 0 || !prev || block.timestamp >= prev.timestamp;
  const timeOk = notFuture && monotonic;
  checks.push({
    name: "timestamp",
    ok: timeOk,
    detail: timeOk
      ? monotonic
        ? "monotonic, not in the future"
        : "ok"
      : !notFuture
        ? `timestamp ${block.timestamp} is more than 2h ahead`
        : "timestamp not monotonic with predecessor",
  });

  const txHashes = block.transactions.map((t) => t.hash);
  const mr = merkleRoot(txHashes.length ? txHashes : ["0".repeat(64)]);
  const merkleOk = mr === block.merkleRoot;
  checks.push({
    name: "merkle",
    ok: merkleOk,
    detail: merkleOk ? block.merkleRoot.slice(0, 16) + "…" : "merkle root does not recompute",
  });

  const recomputed = evaluateResidual(
    {
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      timestamp: block.timestamp,
      nonce: block.nonce,
      difficulty: block.difficulty,
    },
    block.transactions.map((t) => ({ hash: t.hash, fee: t.fee })),
    { cumulativeWork: work, mempoolPressure: pressure },
    block.couplings,
  );

  const residualMatch = Math.abs(recomputed.canonical - block.residual) < 1e-12;
  checks.push({
    name: "residual-recompute",
    ok: residualMatch,
    detail: residualMatch
      ? `R = ${recomputed.canonical.toExponential(4)} (1 eval, ${block.solverIterations} discovery iters)`
      : `claimed ${block.residual} ≠ recomputed ${recomputed.canonical}`,
  });

  const underThreshold = block.height === 0 || block.residual < params.residualThreshold;
  checks.push({
    name: "threshold",
    ok: underThreshold,
    detail:
      block.height === 0
        ? "genesis is a commitment, not a stationary transition"
        : underThreshold
          ? `R < ${params.residualThreshold}`
          : `R ${block.residual} exceeds ${params.residualThreshold}`,
  });

  const expectedHash = canonicalHeaderHash({
    prevHash: block.prevHash,
    merkleRoot: block.merkleRoot,
    stateRoot: block.stateRoot,
    timestamp: block.timestamp,
    nonce: block.nonce,
    difficulty: block.difficulty,
    residualFp: block.residualFp,
    miner: block.miner,
    height: block.height,
    committedPressure: block.committedPressure,
  });
  const hashOk = expectedHash === block.hash;
  checks.push({
    name: "header-hash",
    ok: hashOk,
    detail: hashOk
      ? "header binds merkle, state root, nonce, residual, pressure"
      : "header hash does not recompute from committed fields",
  });

  let sigOk = true;
  let sigFail = 0;
  for (const tx of block.transactions) {
    if (!verifyTx(tx, params.chainId)) {
      sigOk = false;
      sigFail++;
    }
  }
  checks.push({
    name: "signatures",
    ok: sigOk,
    detail: sigOk ? `${block.transactions.length} verified` : `${sigFail} invalid signatures`,
  });

  return { ok: checks.every((c) => c.ok), verifyEvals: 1, checks };
}

export function lightVerifyTx(tx: TxRecord, chainId: number): boolean {
  return verifyTx(tx, chainId);
}
