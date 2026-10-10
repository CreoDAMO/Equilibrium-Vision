import type { ChainState } from "./state.js";
import { SparseMerkleTree, smtKey, smtValue } from "./smt.js";
import type { BlockRecord } from "./types.js";
import { stateRootOf } from "../../../../site/src/protocol/constitution.js";

const ZERO_ROOT = "0".repeat(64);

export interface StateRootSnapshot {
  tip: BlockRecord;
  /** Operational SMT. Its root is not the protocol header commitment. */
  smt: SparseMerkleTree;
  /** stateRootOf(Ω). This is what the header's stateRoot has to match. */
  protocolStateRoot: string;
  /** rebuildStateSmt(state).root(). A different domain from protocolStateRoot. */
  operationalRoot: string;
}

export interface StateRootError {
  status: 409 | 503;
  message: string;
}

/**
 * Rebuild the operational commitment: accounts, UTXOs, contract storage,
 * pools, and validators. This is not stateRootOf(Ω).
 */
export function rebuildStateSmt(chainState: ChainState): SparseMerkleTree {
  const smt = new SparseMerkleTree();

  for (const [addr, acc] of chainState.ledger.getAllAccounts()) {
    smt.set(smtKey("acct", addr), smtValue(`${acc.balance}:${acc.nonce}`));
  }
  for (const utxo of chainState.utxoSet.getAllUnspent()) {
    smt.set(
      smtKey("utxo", `${utxo.txHash}:${utxo.outputIndex}`),
      smtValue(`${utxo.amount}:${utxo.address}:${utxo.blockHeight}`),
    );
  }
  for (const contract of chainState.wasmVM.listContracts()) {
    smt.set(
      smtKey("contract", contract.address),
      smtValue(JSON.stringify(contract.storage)),
    );
  }
  for (const [id, pool] of chainState.dexPools) {
    smt.set(smtKey("pool", id), smtValue(`${pool.reserveA}:${pool.reserveB}:${pool.fee}`));
  }
  for (const [addr, v] of chainState.validators) {
    smt.set(
      smtKey("val", addr),
      smtValue(`${v.bondedStake}:${v.commission}:${v.jailed ? 1 : 0}:${v.slashed ? 1 : 0}`),
    );
  }

  return smt;
}

/**
 * The header commitment is stateRootOf(Ω). The operational SMT is named
 * separately and is not required to equal that commitment.
 * A missing or legacy zero header root is rejected rather than replaced.
 */
export function getVerifiedStateRoot(
  chainState: ChainState,
): { snapshot?: StateRootSnapshot; error?: StateRootError } {
  const tip = chainState.canonicalTip;
  if (!tip) {
    return {
      error: { status: 503, message: "Chain not initialised" },
    };
  }

  const headerRoot = tip.stateRoot;
  if (!headerRoot || headerRoot === ZERO_ROOT) {
    return {
      error: {
        status: 503,
        message: "State root unavailable for the current tip",
      },
    };
  }

  const protocolStateRoot = stateRootOf(chainState.canonicalBody.omega);
  if (headerRoot !== protocolStateRoot) {
    return {
      error: {
        status: 409,
        message: `Protocol state root mismatch at height ${tip.height}: header ${headerRoot}, stateRootOf ${protocolStateRoot}`,
      },
    };
  }

  const smt = chainState._stateSmt ?? rebuildStateSmt(chainState);
  chainState._stateSmt = smt;
  return {
    snapshot: {
      tip,
      smt,
      protocolStateRoot,
      operationalRoot: smt.root(),
    },
  };
}
