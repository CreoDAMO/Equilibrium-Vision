import { OrganismNode } from "@/protocol/chain";
import type { NetworkId } from "@/protocol/types";
import { persistNode, recordBidirectional, restoreNode } from "./persist.server";
import { evaluateResidual } from "@/protocol/solver";

const g = globalThis as unknown as {
  __eqReadyV4?: Promise<void>;
  __eqTestnetV4?: OrganismNode;
  __eqMainnetV4?: OrganismNode;
  __eqTimersV4?: boolean;
};

async function ensure() {
  if (!g.__eqReadyV4) {
    g.__eqReadyV4 = (async () => {
      g.__eqTestnetV4 = await restoreNode("testnet");
      g.__eqMainnetV4 = await restoreNode("mainnet");
      if (!g.__eqTimersV4) {
        g.__eqTimersV4 = true;
        setInterval(() => {
          try {
            const t = g.__eqTestnetV4?.tick() ?? null;
            const m = g.__eqMainnetV4?.tick() ?? null;
            if (t && g.__eqTestnetV4) {
              g.__eqTestnetV4.persisted = true;
              void persistNode(g.__eqTestnetV4);
            }
            if (m && g.__eqMainnetV4) {
              g.__eqMainnetV4.persisted = true;
              void persistNode(g.__eqMainnetV4);
            }
          } catch (err) {
            console.error("[equilibrium] miner tick", err);
          }
        }, 1000);
      }
    })().catch((err) => {
      g.__eqReadyV4 = undefined;
      throw err;
    });
  }
  await g.__eqReadyV4;
}

export async function getNode(network: NetworkId): Promise<OrganismNode> {
  await ensure();
  return network === "mainnet" ? g.__eqMainnetV4! : g.__eqTestnetV4!;
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
