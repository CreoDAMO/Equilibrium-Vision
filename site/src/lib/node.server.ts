import { OrganismNode } from "@/protocol/chain";
import type { NetworkId } from "@/protocol/types";
import { persistNode, recordBidirectional, restoreNode } from "./persist.server";
import { evaluateResidual } from "@/protocol/solver";

const g = globalThis as unknown as {
  __eqReadyV5?: Promise<void>;
  __eqTestnetV5?: OrganismNode;
  __eqMainnetV5?: OrganismNode;
  __eqTimersV5?: boolean;
};

async function ensure() {
  if (!g.__eqReadyV5) {
    g.__eqReadyV5 = (async () => {
      g.__eqTestnetV5 = await restoreNode("testnet");
      g.__eqMainnetV5 = await restoreNode("mainnet");
      if (!g.__eqTimersV5) {
        g.__eqTimersV5 = true;
        setInterval(() => {
          try {
            const t = g.__eqTestnetV5?.tick() ?? null;
            const m = g.__eqMainnetV5?.tick() ?? null;
            if (t && g.__eqTestnetV5) {
              g.__eqTestnetV5.persisted = true;
              void persistNode(g.__eqTestnetV5);
            }
            if (m && g.__eqMainnetV5) {
              g.__eqMainnetV5.persisted = true;
              void persistNode(g.__eqMainnetV5);
            }
          } catch (err) {
            console.error("[equilibrium] miner tick", err);
          }
        }, 1000);
      }
    })().catch((err) => {
      g.__eqReadyV5 = undefined;
      throw err;
    });
  }
  await g.__eqReadyV5;
}

export async function getNode(network: NetworkId): Promise<OrganismNode> {
  await ensure();
  return network === "mainnet" ? g.__eqMainnetV5! : g.__eqTestnetV5!;
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
