import type { NetworkId, ValidatorRecord } from "./types";
import { keypairFromSeed, type Keypair } from "./wallet";

export interface GenesisAlloc {
  address: string;
  amount: number;
  category: string;
  vesting: string;
}

export const GENESIS_ALLOCATIONS: GenesisAlloc[] = [
  {
    address: "ea693e1d5d891d90d91c56fc2446c8d330a8997a",
    amount: 40_000_000,
    category: "community_airdrop_mining",
    vesting: "none",
  },
  {
    address: "e89ffa36b8d3d18c24f9c0aaad3328a886554d5a",
    amount: 20_000_000,
    category: "liquidity_pools",
    vesting: "locked-in-pools",
  },
  {
    address: "9ee64f3daeb6bb22ef2913967f9d8a8a8290d5f0",
    amount: 15_000_000,
    category: "ecosystem_dev_fund",
    vesting: "2-4-year time-lock",
  },
  {
    address: "d1c2c0a431299a97779cdc23837ed9ce5408aaaa",
    amount: 5_000_000,
    category: "founder_upfront",
    vesting: "none",
  },
  {
    address: "db4d0a79beb2001f61c671532c254ef746ab0cda",
    amount: 5_000_000,
    category: "founder_vested",
    vesting: "4-year linear, 1-year cliff",
  },
  {
    address: "bb18cca322f539b9750701a07e2d871fdd744566",
    amount: 5_000_000,
    category: "team",
    vesting: "3-year linear, 1-year cliff",
  },
  {
    address: "ab92b2d4e3591203220d707a8248a144758c2888",
    amount: 5_000_000,
    category: "advisors_early_contributors",
    vesting: "2-3-year linear",
  },
];

export const GENESIS_VALIDATORS: Array<{
  address: string;
  stake: number;
  name: string;
}> = [
  { address: "6ea341f4f8d62cd427434c89d35d3fc6340a8bb1", stake: 1_500_000, name: "Equilibrium Foundation" },
  { address: "736d0217b01cdaec6288ced8ddb8be7435f711e0", stake: 1_500_000, name: "Equilibrium Labs" },
  { address: "cec6a4f606263f462db50d853f599b758cede73b", stake: 1_000_000, name: "Community Validator Alpha" },
  { address: "347eae6992d4a575868c6137c707c87cb6e1a833", stake: 1_000_000, name: "Community Validator Beta" },
];

export const GENESIS_TIME = Math.floor(new Date("2026-07-05T00:44:37.417Z").getTime() / 1000);

export function treasuryKey(network: NetworkId): Keypair {
  return keypairFromSeed(`equilibrium.site/${network}/treasury/v1`);
}

export function minerKey(network: NetworkId): Keypair {
  return keypairFromSeed(`equilibrium.site/${network}/miner/foundation/v1`);
}

export function activityKeys(network: NetworkId): Keypair[] {
  return [0, 1, 2].map((i) => keypairFromSeed(`equilibrium.site/${network}/activity/${i}`));
}

export function genesisValidators(): ValidatorRecord[] {
  return GENESIS_VALIDATORS.map((v) => ({
    address: v.address,
    moniker: v.name,
    bondedStake: v.stake,
    accumulatedRewards: 0,
    slashed: false,
    jailed: false,
    uptime: 1,
    blocksProposed: 0,
    commission: 0.1,
  }));
}
