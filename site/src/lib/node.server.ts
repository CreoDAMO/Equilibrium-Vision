import { OrganismNode } from "@/protocol/chain";
import type { NetworkId } from "@/protocol/types";
import { persistNode, recordBidirectional, restoreNode } from "./persist.server";
import { attachSidecar } from "./sidecar.server";
import { evaluateResidual } from "@/protocol/solver";

const g = globalThis as unknown as {
  __eqReadyV7?: Promise<void>;
  __eqTestnetV7?: OrganismNode;
  __eqMainnetV7?: OrganismNode;
  __eqTimersV7?: boolean;
};

async function ensure() {
  if (!g.__eqReadyV7) {
    g.__eqReadyV7 = (async () => {
      g.__eqTestnetV7 = await restoreNode("testnet");
      g.__eqMainnetV7 = await restoreNode("mainnet");
      if (!g.__eqTimersV7) {
        g.__eqTimersV7 = true;
        attachSidecar((network) => (network === "mainnet" ? g.__eqMainnetV7 : g.__eqTestnetV7));
        setInterval(() => {
          try {
            const t = g.__eqTestnetV7?.tick() ?? null;
            const m = g.__eqMainnetV7?.tick() ?? null;
            if (t && g.__eqTestnetV7) {
              g.__eqTestnetV7.persisted = true;
              void persistNode(g.__eqTestnetV7);
            }
            if (m && g.__eqMainnetV7) {
              g.__eqMainnetV7.persisted = true;
              void persistNode(g.__eqMainnetV7);
            }
          } catch (err) {
            console.error("[equilibrium] miner tick", err);
          }
        }, 1000);
      }
    })().catch((err) => {
      g.__eqReadyV7 = undefined;
      throw err;
    });
  }
  await g.__eqReadyV7;
}

export async function getNode(network: NetworkId): Promise<OrganismNode> {
  await ensure();
  return network === "mainnet" ? g.__eqMainnetV7! : g.__eqTestnetV7!;
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
