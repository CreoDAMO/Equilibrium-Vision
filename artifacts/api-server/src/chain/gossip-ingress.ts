/**
 * A gossip body keeps the transaction list it carries.
 * Absence is an empty list. A list that is present is not replaced with
 * the receiver's mempool, and pressure is the body's value or zero.
 * This is not the phone header, and it is not the artifacts seal.
 */
import type { BlockRecord } from "./types.js";
import { merkleRoot } from "./crypto.js";
import { admitResidual, canonicalResidual, pressureEvidence } from "./canonical-residual.js";
import { canonicalCoinbase } from "@workspace/coinomics";
import { foreignNonce } from "../../../../site/src/protocol/domain.js";
import { remoteTransactions } from "./evidence-ingress.js";

export type GossipCouplings = { hash: number; structural: number; continuity: number; mempool: number; fees: number };

export function prepareGossipBlock(
  body: Record<string, unknown>,
  ctx: {
    difficulty: number;
    couplings: GossipCouplings;
    admissionTarget: number;
  },
): { ok: true; block: BlockRecord } | { ok: false; error: string } {
  const hash = typeof body.hash === "string" ? body.hash : "";
  const height = typeof body.height === "number" ? body.height : -1;
  const prevHash = typeof body.prevHash === "string" ? body.prevHash : "";
  const miner = typeof body.miner === "string" ? body.miner : "";
  if (!hash || height < 0 || !prevHash || !miner) return { ok: false, error: "gossip body is incomplete" };
  if (Object.prototype.hasOwnProperty.call(body, "evidence") && body.evidence != null) {
    return { ok: false, error: "evidence is not a gossip body" };
  }
  for (const key of ["evidenceRoot", "stateRoot", "omegaRoot", "transitionRoot", "statement"]) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] != null) {
      return { ok: false, error: "announced identity is not a gossip body" };
    }
  }
  let nonce: bigint;
  try {
    nonce = foreignNonce(body.nonce);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "nonce is not a u64" };
  }
  const difficulty = typeof body.difficulty === "number" ? body.difficulty : NaN;
  if (difficulty !== ctx.difficulty) return { ok: false, error: "difficulty is not the canonical difficulty" };

  const namedHashes = body.txHashes ?? body.tx_hashes;
  if (Array.isArray(namedHashes) && namedHashes.length > 0 && body.transactions == null) {
    return { ok: false, error: "transactions are not on this body" };
  }
  const transactions = remoteTransactions(body.transactions);
  if (!transactions) return { ok: false, error: "transactions are not a list" };
  if (body.txCount !== undefined && body.txCount !== null) {
    if (typeof body.txCount !== "number" || !Number.isInteger(body.txCount) || body.txCount !== transactions.length) {
      return { ok: false, error: "txCount is not the transaction set" };
    }
  }
  const expectedMerkle = merkleRoot(transactions.map((tx) => tx.hash));
  const claimedMerkle = typeof body.merkleRoot === "string" ? body.merkleRoot.toLowerCase() : "";
  if (transactions.length === 0) {
    if (claimedMerkle && claimedMerkle !== expectedMerkle) {
      return { ok: false, error: "merkle root is not the transaction set" };
    }
  } else if (!/^[0-9a-f]{64}$/.test(claimedMerkle) || claimedMerkle !== expectedMerkle) {
    return { ok: false, error: "merkle root is not the transaction set" };
  }

  const pressure = body.committedPressure === undefined || body.committedPressure === null
    ? 0
    : pressureEvidence(body.committedPressure);
  if (pressure === null) return { ok: false, error: "committed pressure is block evidence" };

  const residual = typeof body.residual === "number" ? body.residual : NaN;
  const timestamp = typeof body.timestamp === "number" ? body.timestamp : 0;
  const recomputed = canonicalResidual(
    { prevHash, merkleRoot: expectedMerkle, timestamp, nonce, difficulty: ctx.difficulty },
    transactions.map((tx) => ({ hash: tx.hash, fee: tx.fee })),
    { cumulativeWork: height, mempoolPressure: pressure },
    ctx.couplings,
  );
  const admission = admitResidual(residual, recomputed, ctx.admissionTarget);
  if (!admission.ok) return { ok: false, error: admission.error };

  const block: BlockRecord = {
    hash,
    height,
    prevHash,
    merkleRoot: expectedMerkle,
    timestamp,
    nonce,
    difficulty: ctx.difficulty,
    residual: admission.residual,
    residualFp: Math.floor(admission.residual * 1e18),
    recursionDepth: 2,
    coinbaseReward: canonicalCoinbase(height, admission.residual, ctx.admissionTarget),
    miner,
    txCount: transactions.length,
    transactions: transactions.map((tx) => ({ ...tx })),
    committedPressure: pressure,
  };
  return { ok: true, block };
}
