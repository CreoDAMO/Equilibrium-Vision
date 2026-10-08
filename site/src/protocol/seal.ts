import { merkleRoot, canonicalHeaderHash } from "./crypto";
import { omegaDigest, transitionDigest, type Successor } from "./constitution";
import { ARBITRAGE_CODE, evidenceRoot } from "./evidence";
import type { CanonicalInputs, Omega, TransitionEvidence } from "./types";

export type SealedSuccessor = {
  hash: string;
  merkleRoot: string;
  evidence: TransitionEvidence;
  evidenceRoot: string;
  /** Commit_I(Ω, I). Bound by the header beside the omega digest. */
  transitionRoot: string;
  /** Ω′ as the relation returned it. tipHash is still the previous block. */
  digestOmega: Extract<Successor, { ok: true }>["next"];
  /** The Ω the next block reads. tipHash is the header just sealed. */
  carried: Omega;
};

export function blankEvidence(chainId: number): TransitionEvidence {
  return { v: 1, chainId, wasmCode: ARBITRAGE_CODE, btc: [], eth: [], wasm: [], stake: [] };
}

/**
 * Header identity of a successor. One construction.
 * The new tip hash is not inside omegaDigest: the hash commits to that digest,
 * so writing the hash back into the digest would be circular.
 * The next Ω carries the hash as tipHash, which the next header binds as prev.
 */
export function sealFromSuccessor(
  omega: Omega,
  inputs: CanonicalInputs,
  stepped: Extract<Successor, { ok: true }>,
): SealedSuccessor {
  const evidence = inputs.evidence ?? blankEvidence(omega.chainId);
  const txHashes = inputs.transactions.map((t) => t.hash);
  const mr = merkleRoot(txHashes.length ? txHashes : ["0".repeat(64)]);
  const root = evidenceRoot(evidence);
  const transitionRoot = transitionDigest(omega, { ...inputs, evidence });
  const hash = canonicalHeaderHash({
    prevHash: omega.tipHash,
    merkleRoot: mr,
    stateRoot: stepped.stateRoot,
    timestamp: inputs.timestamp,
    nonce: inputs.nonce,
    difficulty: inputs.difficulty,
    residualFp: stepped.residualFp,
    miner: inputs.miner,
    height: omega.height + 1,
    committedPressure: inputs.committedPressure,
    chainId: evidence.chainId,
    evidenceRoot: root,
    omegaRoot: stepped.omegaRoot,
    transitionRoot,
  });
  return {
    hash,
    merkleRoot: mr,
    evidence,
    evidenceRoot: root,
    transitionRoot,
    digestOmega: stepped.next,
    carried: { ...stepped.next, tipHash: hash },
  };
}

/** Every field of Ω, including the ones omegaDigest leaves out. */
export function omegaRecord(omega: Omega) {
  const ledger = [...omega.ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([address, acc]) => ({ address, balance: acc.balance, nonce: acc.nonce }));
  const pools = [...omega.pools]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({ ...p }));
  const validators = [...omega.validators.values()]
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    .map((v) => ({ ...v }));
  return {
    chainId: omega.chainId,
    height: omega.height,
    tipHash: omega.tipHash,
    tipTimestamp: omega.tipTimestamp,
    difficulty: omega.difficulty,
    couplings: { ...omega.couplings },
    ledger,
    pools,
    btc: omega.btc.map((h) => ({ ...h })),
    ethPubkey: omega.ethPubkey,
    ethCommittee: omega.ethCommittee ?? "",
    eth: omega.eth.map((h) => ({ ...h })),
    wasm: [...omega.wasm.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    validators,
    delegations: omega.delegations.map((d) => ({ ...d })),
    unbonding: omega.unbonding.map((u) => ({ ...u })),
    withdrawals: omega.withdrawals.map((w) => ({ ...w })),
    proposals: omega.proposals.map((p) => ({ ...p })),
    models: omega.models.map((m) => ({ ...m })),
    settlements: omega.settlements.map((s) => ({ ...s })),
    finalizedHeight: omega.finalizedHeight,
    omegaRoot: omegaDigest(omega),
  };
}
