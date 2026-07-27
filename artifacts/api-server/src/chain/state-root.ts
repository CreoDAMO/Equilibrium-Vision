import type { ChainState } from "./state.js";
import { SparseMerkleTree, smtKey, smtValue } from "./smt.js";
import type { BlockRecord } from "./types.js";

const ZERO_ROOT = "0".repeat(64);

export interface StateRootSnapshot {
  tip: BlockRecord;
  smt: SparseMerkleTree;
}

export interface StateRootError {
  status: 409 | 503;
  message: string;
}

/**
 * Rebuild the state commitment from the same state partitions used by
 * ChainState.addBlock(). This is intentionally kept outside the HTTP route so
 * the HTTP and libp2p light-node protocols cannot drift apart.
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

  return smt;
}

/**
 * Return the current SMT only when it cryptographically agrees with the
 * advertised tip commitment. A missing/legacy zero root is rejected rather
 * than silently replaced with a locally rebuilt root.
 */
export function getVerifiedStateRoot(
  chainState: ChainState,
): { snapshot?: StateRootSnapshot; error?: StateRootError } {
  const tip = chainState.latestBlock;
  if (!tip) {
    return {
      error: { status: 503, message: "Chain not initialised" },
    };
  }

  const expectedRoot = tip.stateRoot;
  if (!expectedRoot || expectedRoot === ZERO_ROOT) {
    return {
      error: {
        status: 503,
        message: "State root unavailable for the current tip",
      },
    };
  }

  const smt = chainState._stateSmt ?? rebuildStateSmt(chainState);
  // Cache a cold rebuild, but never trust it until it has passed this check.
  chainState._stateSmt = smt;
  const actualRoot = smt.root();
  if (actualRoot !== expectedRoot) {
    return {
      error: {
        status: 409,
        message: `State root mismatch at height ${tip.height}: expected ${expectedRoot}, rebuilt ${actualRoot}`,
      },
    };
  }

  return { snapshot: { tip, smt } };
}