import type { NetworkId, NetworkParams } from "./types";

function net(params: NetworkParams): NetworkParams {
  return Object.freeze(params);
}

/** Shared, frozen, and not a place a harness may write. A copy is a different object. */
export const NETWORKS: Record<NetworkId, NetworkParams> = Object.freeze({
  testnet: net({
    id: "testnet",
    chainId: 2,
    name: "Equilibrium Testnet",
    domain: "equilibriums.site",
    targetBlockTimeMs: 8000,
    residualThreshold: 2e-3,
    territoryThreshold: 1e-7,
    initialDifficulty: 1_000_000,
    baseReward: 100,
    halvingInterval: 2_100_000,
    maxTxPerBlock: 50,
    mempoolCap: 500,
    finalityQuorum: 2 / 3,
    finalityLag: 2,
    unbondingPeriod: 10,
    withdrawalTimeout: 10,
    allowFaucet: true,
    faucetAmount: 1_000_000,
  }),
  mainnet: net({
    id: "mainnet",
    chainId: 1,
    name: "Equilibrium Mainnet",
    domain: "equilibriums.site",
    targetBlockTimeMs: 15000,
    residualThreshold: 8e-4,
    territoryThreshold: 1e-7,
    initialDifficulty: 1_000_000,
    baseReward: 100,
    halvingInterval: 2_100_000,
    maxTxPerBlock: 50,
    mempoolCap: 500,
    finalityQuorum: 2 / 3,
    finalityLag: 2,
    unbondingPeriod: 10,
    withdrawalTimeout: 10,
    allowFaucet: false,
    faucetAmount: 0,
  }),
});

