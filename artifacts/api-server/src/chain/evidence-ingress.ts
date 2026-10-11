/**
 * One evidence record. The transaction list that is replayed is the list that
 * is installed and the list that is persisted. A different remote object is not
 * written afterwards.
 */
import type { BlockRecord, TxRecord } from "./types.js";
import { ChainState } from "./state.js";
import { persistBlock, persistKeepsMemory, type PersistBlockResult } from "./persistence.js";
import { foreignNonce } from "../../../../site/src/protocol/domain.js";

export type EvidenceIngressResult = {
  admitted: boolean;
  kept: boolean;
  error?: string;
  persist: PersistBlockResult | null;
};

function refused(error: string): EvidenceIngressResult {
  return { admitted: false, kept: false, error, persist: null };
}

function transactionList(value: unknown): TxRecord[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out: TxRecord[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return null;
    const tx = row as Record<string, unknown>;
    if (typeof tx.hash !== "string" || typeof tx.from !== "string" || typeof tx.to !== "string") return null;
    const amount = typeof tx.amount === "number" ? tx.amount : Number(tx.amount);
    const fee = tx.fee == null ? 0 : typeof tx.fee === "number" ? tx.fee : Number(tx.fee);
    const nonce = typeof tx.nonce === "number" ? tx.nonce : Number(tx.nonce);
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    if (!Number.isSafeInteger(fee) || fee < 0) return null;
    if (!Number.isSafeInteger(nonce) || nonce < 0) return null;
    out.push({
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      amount,
      fee,
      nonce,
      timestamp: typeof tx.timestamp === "number" ? tx.timestamp : Number(tx.timestamp) || 0,
      status: "confirmed",
      blockHash: null,
      blockHeight: null,
      signature: typeof tx.signature === "string" ? tx.signature : undefined,
      publicKey: typeof tx.publicKey === "string" ? tx.publicKey : undefined,
    });
  }
  return out;
}

/**
 * Replay a remote evidence body and persist that same record.
 * A count, merkle root, parent, or hash that does not describe the replayed
 * transaction set is refused before a write. A refused or failed write does
 * not keep the canonical tip.
 */
export async function admitRemoteEvidence(
  state: ChainState,
  remote: Record<string, unknown>,
  blockHash: string,
  persist: (block: BlockRecord) => Promise<PersistBlockResult> = persistBlock,
): Promise<EvidenceIngressResult> {
  if (!remote.evidence || typeof remote.evidence !== "object") return refused("no evidence");
  const bodyHash = typeof remote.hash === "string" ? remote.hash : "";
  if (bodyHash && blockHash && bodyHash !== blockHash) return refused("hash is not the announced block");
  const hash = bodyHash || blockHash;
  if (!/^[0-9a-f]{64}$/i.test(hash)) return refused("hash is not the announced block");

  const transactions = transactionList(remote.transactions);
  if (!transactions) return refused("transactions are not a list");
  if (remote.txCount !== undefined && remote.txCount !== null) {
    if (typeof remote.txCount !== "number" || !Number.isInteger(remote.txCount) || remote.txCount !== transactions.length) {
      return refused("txCount is not the transaction set");
    }
  }
  if (typeof remote.merkleRoot !== "string" || !/^[0-9a-f]{64}$/i.test(remote.merkleRoot)) {
    return refused("merkle root is not the transaction set");
  }
  let nonce: bigint;
  try {
    nonce = foreignNonce(remote.nonce);
  } catch (err) {
    return refused(err instanceof Error ? err.message : "nonce is not a u64");
  }

  const block: BlockRecord = {
    hash,
    height: Number(remote.height) || 0,
    prevHash: typeof remote.prevHash === "string" ? remote.prevHash : "",
    merkleRoot: remote.merkleRoot.toLowerCase(),
    timestamp: Number(remote.timestamp) || 0,
    nonce,
    difficulty: Number(remote.difficulty) || 0,
    residual: Number(remote.residual) || 0,
    residualFp: typeof remote.residualFp === "number" ? remote.residualFp : undefined,
    recursionDepth: 2,
    coinbaseReward: Number(remote.coinbaseReward) || 0,
    miner: String(remote.miner ?? ""),
    txCount: transactions.length,
    transactions: transactions.map((tx) => ({ ...tx })),
    committedPressure: typeof remote.committedPressure === "number" ? remote.committedPressure : 0,
    stateRoot: typeof remote.stateRoot === "string" ? remote.stateRoot : undefined,
    chainId: typeof remote.chainId === "number" ? remote.chainId : undefined,
    evidenceRoot: typeof remote.evidenceRoot === "string" ? remote.evidenceRoot : undefined,
    omegaRoot: typeof remote.omegaRoot === "string" ? remote.omegaRoot : undefined,
    transitionRoot: typeof remote.transitionRoot === "string" ? remote.transitionRoot : undefined,
    evidence: remote.evidence as BlockRecord["evidence"],
  };

  return state.withAdmission(async () => {
    const beforeHeight = state.canonicalBody.omega.height;
    const beforeTip = state.canonicalBody.omega.tipHash;
    const err = await state.adoptReplay(block);
    if (err) return refused(err);
    let saved: PersistBlockResult;
    try {
      saved = await persist(block);
    } catch (err) {
      if (state.canonicalBody.omega.tipHash !== beforeTip) state.rollbackToHeight(beforeHeight);
      return {
        admitted: true,
        kept: false,
        error: err instanceof Error ? err.message : "block was not persisted",
        persist: { durable: false, outcome: "failed" },
      };
    }
    if (!persistKeepsMemory(saved)) {
      if (state.canonicalBody.omega.tipHash !== beforeTip) state.rollbackToHeight(beforeHeight);
      return { admitted: true, kept: false, error: saved.outcome, persist: saved };
    }
    return { admitted: true, kept: true, persist: saved };
  });
}
