/**
 * Stage 1 Option A. A bounded check of the production reward, the liquid split,
 * and the miner's balance after that credit. It is not a transition proof.
 * The RETAIN package is the version-1 descriptor. Adoption stays off.
 */
import type { Successor } from "./constitution";
import { selectSuccessorTxs, type SelectableTx } from "./tx-select";
import { V1_RELATION } from "./v1-relation";

export const STAGE1_OPTION_A_ID = "stage1-option-a";

export const STAGE1_EXCLUDES = [
  "material derivation",
  "staked distribution",
  "swap events",
  "full applySuccessor",
  "omega identity",
  "cross-proof composition",
  "reading B",
  "network or economic assurance",
  "C-007",
] as const;

export const STAGE1_RETAIN = V1_RELATION;

const RETAIN = "RETAIN-WITH-DISCLAIMER";

export function retainOutcomes(): readonly string[] {
  return [
    V1_RELATION.couplings.outcome,
    V1_RELATION.btcHeaders.outcome,
    V1_RELATION.ethBeacon.outcome,
    V1_RELATION.ethExecution.outcome,
    V1_RELATION.models.outcome,
    V1_RELATION.settlements.outcome,
  ];
}

export function stage1Order<T extends SelectableTx>(
  balanceOf: (addr: string) => number,
  nonceOf: (addr: string) => number,
  txs: readonly T[],
  limit: number,
  claimed: readonly T[],
): boolean {
  const ordered = selectSuccessorTxs(balanceOf, nonceOf, txs, limit);
  return ordered.length === claimed.length && ordered.every((tx, i) => tx.hash === claimed[i]?.hash);
}

export function stage1OptionA(
  stepped: Successor,
  claim: { id: string; reward: number; liquid: number; miner: string; minerBalance: number },
): { ok: true; excludes: readonly string[] } | { ok: false; error: string } {
  if (claim.id !== STAGE1_OPTION_A_ID) return { ok: false, error: "statement is not stage1-option-a" };
  if (retainOutcomes().some((outcome) => outcome !== RETAIN)) {
    return { ok: false, error: "retain package was rewritten" };
  }
  if (!stepped.ok) return { ok: false, error: stepped.error };
  if (claim.reward !== stepped.reward) return { ok: false, error: "reward is not the production reward" };
  if (claim.liquid !== stepped.liquid) return { ok: false, error: "liquid is not the production split" };
  const balance = stepped.next.ledger.get(claim.miner)?.balance;
  if (balance !== claim.minerBalance) return { ok: false, error: "miner liquid credit is not the ledger balance" };
  return { ok: true, excludes: STAGE1_EXCLUDES };
}
