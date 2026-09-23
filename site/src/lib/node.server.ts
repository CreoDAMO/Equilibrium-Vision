import { OrganismNode } from "@/protocol/chain";
import type { NetworkId } from "@/protocol/types";
import { persistNode, recordBidirectional, restoreNode } from "./persist.server";
import { evaluateResidual } from "@/protocol/solver";

const g = globalThis as unknown as {
  __eqReadyV6?: Promise<void>;
  __eqTestnetV6?: OrganismNode;
  __eqMainnetV6?: OrganismNode;
  __eqTimersV6?: boolean;
};

async function ensure() {
  if (!g.__eqReadyV6) {
    g.__eqReadyV6 = (async () => {
      g.__eqTestnetV6 = await restoreNode("testnet");
      g.__eqMainnetV6 = await restoreNode("mainnet");
      if (!g.__eqTimersV6) {
        g.__eqTimersV6 = true;
        setInterval(() => {
          try {
            const t = g.__eqTestnetV6?.tick() ?? null;
            const m = g.__eqMainnetV6?.tick() ?? null;
            if (t && g.__eqTestnetV6) {
              g.__eqTestnetV6.persisted = true;
              void persistNode(g.__eqTestnetV6);
            }
            if (m && g.__eqMainnetV6) {
              g.__eqMainnetV6.persisted = true;
              void persistNode(g.__eqMainnetV6);
            }
          } catch (err) {
            console.error("[equilibrium] miner tick", err);
          }
        }, 1000);
      }
    })().catch((err) => {
      g.__eqReadyV6 = undefined;
      throw err;
    });
  }
  await g.__eqReadyV6;
}

export async function getNode(network: NetworkId): Promise<OrganismNode> {
  await ensure();
  return network === "mainnet" ? g.__eqMainnetV6! : g.__eqTestnetV6!;
}

export async function persist(network: NetworkId) {
  const node = await getNode(network);
  node.persisted = true;
  await persistNode(node);
  const tip = node.tip;
  if (!tip) return;
  const local = evaluateResidual(
    {
      prevHash: tip.prevHash,
      merkleRoot: tip.merkleRoot,
      timestamp: tip.timestamp,
      nonce: tip.nonce,
      difficulty: tip.difficulty,
    },
    tip.transactions.map((t) => ({ hash: t.hash, fee: t.fee })),
    { cumulativeWork: tip.height, mempoolPressure: tip.committedPressure },
    tip.couplings,
  );
  await recordBidirectional(network, {
    height: tip.height,
    claimedR: tip.residual,
    inferredR: local.canonical,
    agree: Math.abs(local.canonical - tip.residual) < 1e-12,
    discoveryIters: tip.solverIterations,
    verifyEvals: 1,
  });
}
