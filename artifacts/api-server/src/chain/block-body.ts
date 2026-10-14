/**
 * Whether the transaction list attached to a persisted block is the list it
 * committed to. Checked before restore moves state.
 *
 * An empty list uses the same root as sealFromSuccessor: one 64-zero leaf.
 * In this merkle implementation that leaf is the root, which is 64 zero bytes.
 * A missing signature is refused. There is no unsigned historical exception.
 * This does not recompute the successor, and it does not prove a snapshot.
 */
import { merkleRoot } from "./crypto.js";
import { verifyCanonicalTx } from "../lib/canonical-tx.js";
import type { BlockRecord } from "./types.js";
import { evidenceRoot } from "../../../../site/src/protocol/evidence.js";
import type { TransitionEvidence } from "../../../../site/src/protocol/types.js";

export type BodyVerdict =
  | { ok: true }
  | { ok: false; code: "tx-count" | "merkle" | "tx-auth"; reason: string };

export class RestoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreIntegrityError";
  }
}

/**
 * The stored evidenceRoot column is not the authority for the evidence.
 * No evidence: the column is left alone. Evidence with no column, or the
 * same root: the record carries the recomputed root. A different column
 * is refused. It is not rewritten and it is not replayed.
 */
export function bindStoredEvidenceRoot(
  stored: string | null | undefined,
  evidence: unknown,
): { ok: true; evidenceRoot?: string } | { ok: false; reason: string } {
  if (evidence == null) return { ok: true, evidenceRoot: stored ?? undefined };
  let root: string;
  try {
    root = evidenceRoot(evidence as TransitionEvidence);
  } catch {
    return { ok: false, reason: "evidenceRoot is not the evidence" };
  }
  if (stored != null && stored !== "" && stored.toLowerCase() !== root) {
    return { ok: false, reason: "evidenceRoot is not the evidence" };
  }
  return { ok: true, evidenceRoot: root };
}

export function verifyBlockBody(
  block: BlockRecord,
  chainId: number,
  opts: { authenticate: boolean } = { authenticate: true },
): BodyVerdict {
  const txs = block.transactions ?? [];
  if (block.txCount !== txs.length) {
    return { ok: false, code: "tx-count", reason: `txCount ${block.txCount} but ${txs.length} transaction(s) attached` };
  }
  const root = merkleRoot(txs.length ? txs.map((tx) => tx.hash) : ["0".repeat(64)]);
  if (root !== block.merkleRoot) {
    return {
      ok: false,
      code: "merkle",
      reason: `stored merkleRoot ${block.merkleRoot.slice(0, 16)} but the attached transactions give ${root.slice(0, 16)}`,
    };
  }
  if (opts.authenticate) {
    for (const [i, tx] of txs.entries()) {
      const verdict = verifyCanonicalTx({
        from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee, nonce: tx.nonce,
        signature: tx.signature, publicKey: tx.publicKey, chainId, hash: tx.hash,
      });
      if (!verdict.ok) {
        return { ok: false, code: "tx-auth", reason: `transaction ${i} (${tx.hash.slice(0, 16)}) refused: ${verdict.error}` };
      }
    }
  }
  return { ok: true };
}

/**
 * The order a block committed is txIndex 0..n-1.
 * One row has only one order. Two or more rows with a missing, duplicate, or
 * gapped index are not recoverable by sorting on the hash.
 */
export function orderRestoredRows<T extends { hash: string; txIndex?: number | null }>(rows: readonly T[]): T[] {
  if (rows.length <= 1) return [...rows];
  const indexes: number[] = [];
  for (const row of rows) {
    if (row.txIndex == null || !Number.isInteger(row.txIndex)) {
      throw new RestoreIntegrityError("transaction order is not recoverable");
    }
    indexes.push(row.txIndex);
  }
  const seen = new Set(indexes);
  if (seen.size !== rows.length) throw new RestoreIntegrityError("transaction order is not recoverable");
  for (let i = 0; i < rows.length; i++) {
    if (!seen.has(i)) throw new RestoreIntegrityError("transaction order is not recoverable");
  }
  return [...rows].sort((a, b) => a.txIndex! - b.txIndex!);
}
