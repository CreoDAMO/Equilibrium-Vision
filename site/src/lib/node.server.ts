import { OrganismNode, RestoreRefused } from "@/protocol/chain";
import type { NetworkId } from "@/protocol/types";
import { dbSource } from "./db";
import { persistNode, recordBidirectional, restoreNode } from "./persist.server";
import { attachSidecar } from "./sidecar.server";
import { evaluateResidual } from "@/protocol/solver";
import { networkMayMine } from "@/protocol/restore-hold";

const g = globalThis as unknown as {
  __eqReadyV7?: Promise<void>;
  __eqTestnetV7?: OrganismNode;
  __eqMainnetV7?: OrganismNode;
  __eqHoldV7?: Partial<Record<NetworkId, string>>;
  __eqTimersV7?: boolean;
};

async function restoreOrHold(network: NetworkId): Promise<OrganismNode | undefined> {
  try {
    return await restoreNode(network);
  } catch (err) {
    if (err instanceof RestoreRefused) {
      g.__eqHoldV7 ??= {};
      g.__eqHoldV7[network] = err.message;
      console.error(`[equilibrium] ${network} preserved, not restored: ${err.message}`);
      return undefined;
    }
    throw err;
  }
}

async function ensure() {
  if (!g.__eqReadyV7) {
    g.__eqReadyV7 = (async () => {
      console.log(`[equilibrium] persistence ${dbSource}`);
      g.__eqHoldV7 = {};
      g.__eqTestnetV7 = await restoreOrHold("testnet");
      g.__eqMainnetV7 = await restoreOrHold("mainnet");
      if (!g.__eqTimersV7) {
        g.__eqTimersV7 = true;
        attachSidecar((network) => (network === "mainnet" ? g.__eqMainnetV7 : g.__eqTestnetV7));
        setInterval(() => {
          try {
            if (networkMayMine(g.__eqHoldV7 ?? {}, "testnet")) {
              const t = g.__eqTestnetV7?.tick() ?? null;
              if (t && g.__eqTestnetV7) {
                void persistNode(g.__eqTestnetV7).then((ok) => {
                  if (ok && g.__eqTestnetV7) g.__eqTestnetV7.persisted = true;
                });
              }
            }
            if (networkMayMine(g.__eqHoldV7 ?? {}, "mainnet")) {
              const m = g.__eqMainnetV7?.tick() ?? null;
              if (m && g.__eqMainnetV7) {
                void persistNode(g.__eqMainnetV7).then((ok) => {
                  if (ok && g.__eqMainnetV7) g.__eqMainnetV7.persisted = true;
                });
              }
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
  const held = g.__eqHoldV7?.[network];
  if (held) throw new RestoreRefused(held);
  return network === "mainnet" ? g.__eqMainnetV7! : g.__eqTestnetV7!;
}

export async function persist(network: NetworkId) {
  const node = await getNode(network);
  node.persisted = await persistNode(node);
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
