import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Addresses the public kernel derives for its operating balances.
 * `keypairFromSeed` is sha256(utf8(seed)) as an ed25519 seed, then sha256(pubkey)[0..20].
 */
export function kernelAddress(seed: string): string {
  const hashed = createHash("sha256").update(seed, "utf8").digest();
  const { publicKey } = ed25519.keygen(hashed);
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 40);
}

export type KernelNetwork = "mainnet" | "testnet";

export function kernelParty(network: KernelNetwork): {
  treasury: string;
  miner: string;
  activity: string[];
  treasuryAmount: number;
} {
  return {
    treasury: kernelAddress(`equilibrium.site/${network}/treasury/v1`),
    miner: kernelAddress(`equilibrium.site/${network}/miner/foundation/v1`),
    activity: [0, 1, 2].map((i) => kernelAddress(`equilibrium.site/${network}/activity/${i}`)),
    treasuryAmount: network === "testnet" ? 25_000_000 : 8_000_000,
  };
}

/** The four genesis validators whose stake the kernel also credits as liquid. */
export const KERNEL_VALIDATOR_LIQUID: Array<{ address: string; amount: number; name: string }> = [
  { address: "6ea341f4f8d62cd427434c89d35d3fc6340a8bb1", amount: 1_500_000, name: "Equilibrium Foundation" },
  { address: "736d0217b01cdaec6288ced8ddb8be7435f711e0", amount: 1_500_000, name: "Equilibrium Labs" },
  { address: "cec6a4f606263f462db50d853f599b758cede73b", amount: 1_000_000, name: "Community Validator Alpha" },
  { address: "347eae6992d4a575868c6137c707c87cb6e1a833", amount: 1_000_000, name: "Community Validator Beta" },
];

/** The seven allocation lines. genesis.json credits these and not its 100,000,000 header. */
export const KERNEL_ALLOCATIONS: Array<{ address: string; amount: number }> = [
  { address: "ea693e1d5d891d90d91c56fc2446c8d330a8997a", amount: 40_000_000 },
  { address: "e89ffa36b8d3d18c24f9c0aaad3328a886554d5a", amount: 20_000_000 },
  { address: "9ee64f3daeb6bb22ef2913967f9d8a8a8290d5f0", amount: 15_000_000 },
  { address: "d1c2c0a431299a97779cdc23837ed9ce5408aaaa", amount: 5_000_000 },
  { address: "db4d0a79beb2001f61c671532c254ef746ab0cda", amount: 5_000_000 },
  { address: "bb18cca322f539b9750701a07e2d871fdd744566", amount: 5_000_000 },
  { address: "ab92b2d4e3591203220d707a8248a144758c2888", amount: 5_000_000 },
];

export function kernelNetworkOf(chainId: string): KernelNetwork | null {
  if (chainId === "equilibrium-1" || chainId === "1") return "mainnet";
  if (chainId === "equilibrium-2" || chainId === "2") return "testnet";
  return null;
}

export function allocationsMatchKernel(lines: Array<{ address: string; amount: string | number }>): boolean {
  if (lines.length !== KERNEL_ALLOCATIONS.length) return false;
  const got = new Map(lines.map((line) => [line.address, Number(line.amount)]));
  return KERNEL_ALLOCATIONS.every((line) => got.get(line.address) === line.amount);
}
