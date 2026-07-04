// ── Genesis block generator ─────────────────────────────────────────────────
//
// Builds the immutable `genesis.json` structure defined in the Equilibrium
// Mainnet Specification ("Genesis Block" section). This module only builds
// and validates the document in memory — writing it to disk is left to the
// CLI wrapper (see `src/cli/generate-genesis.ts`) so the generator itself
// stays pure and testable.

export interface Allocation {
  address: string;
  /** Amount in whole EQU (not the smallest unit). */
  amount: number;
  vesting: string;
  category: string;
}

export interface InitialValidator {
  address: string;
  /** Bonded stake in whole EQU. */
  stake: number;
  name: string;
}

export interface DexPool {
  pair: string;
  reserveA: number;
  reserveB: number;
}

export interface GenesisParameters {
  targetBlockTimeMs: number;
  residualThreshold: number;
  initialDifficulty: number;
  slashingDoubleSignPct: number;
  slashingDowntimePct: number;
  unbondingPeriodBlocks: number;
  maxValidators: number;
  governanceQuorumPct: number;
  governanceVotingPeriodBlocks: number;
}

export interface GenesisConfig {
  chainId: string;
  /** ISO-8601 timestamp string. */
  timestamp: string;
  /** Total genesis supply in whole EQU (must equal the sum of `allocations`). */
  initialSupply: number;
  /** Protocol-wide fixed maximum supply in whole EQU, for validation only. */
  maxSupply: number;
  allocations: Allocation[];
  initialValidators: InitialValidator[];
  dexPools: DexPool[];
  parameters: GenesisParameters;
}

/** The canonical on-disk genesis.json shape (snake_case, spec-exact field names). */
export interface GenesisDocument {
  chain_id: string;
  timestamp: string;
  initial_supply: string;
  allocations: Array<{
    address: string;
    amount: string;
    vesting: string;
    category: string;
  }>;
  initial_validators: Array<{
    address: string;
    stake: string;
    name: string;
  }>;
  dex_pools: Array<{
    pair: string;
    reserve_a: string;
    reserve_b: string;
  }>;
  parameters: {
    target_block_time_ms: number;
    residual_threshold: number;
    initial_difficulty: number;
    slashing_double_sign_pct: number;
    slashing_downtime_pct: number;
    unbonding_period_blocks: number;
    max_validators: number;
    governance_quorum_pct: number;
    governance_voting_period_blocks: number;
  };
}

/** Mainnet defaults per the "Coinomics" and "Genesis Block" spec sections. */
export const MAINNET_MAX_SUPPLY = 1_000_000_000;
export const MAINNET_GENESIS_SUPPLY = 100_000_000;

export const MAINNET_GENESIS_PARAMETERS: GenesisParameters = {
  targetBlockTimeMs: 15_000,
  residualThreshold: 1e-7,
  initialDifficulty: 1_000_000,
  slashingDoubleSignPct: 5,
  slashingDowntimePct: 1,
  unbondingPeriodBlocks: 10,
  maxValidators: 100,
  governanceQuorumPct: 33.4,
  governanceVotingPeriodBlocks: 10_080,
};

/**
 * Validate a `GenesisConfig` against the invariants required by the spec.
 * Throws a descriptive `Error` on the first violation found. Pure — never
 * mutates the input.
 */
export function validateGenesisConfig(config: GenesisConfig): void {
  if (!config.chainId.trim()) {
    throw new Error("validateGenesisConfig: chainId must be non-empty");
  }
  if (Number.isNaN(Date.parse(config.timestamp))) {
    throw new Error(`validateGenesisConfig: timestamp is not a valid ISO-8601 date: ${config.timestamp}`);
  }
  if (config.initialSupply <= 0) {
    throw new Error("validateGenesisConfig: initialSupply must be positive");
  }
  if (config.initialSupply > config.maxSupply) {
    throw new Error(
      `validateGenesisConfig: initialSupply (${config.initialSupply}) exceeds maxSupply (${config.maxSupply})`,
    );
  }
  if (config.allocations.length === 0) {
    throw new Error("validateGenesisConfig: at least one allocation is required");
  }

  const allocated = config.allocations.reduce((sum, a) => sum + a.amount, 0);
  // Compare with a small epsilon to tolerate floating-point summation error.
  if (Math.abs(allocated - config.initialSupply) > 1e-6) {
    throw new Error(
      `validateGenesisConfig: allocations sum to ${allocated} EQU but initialSupply is ${config.initialSupply} EQU`,
    );
  }

  for (const a of config.allocations) {
    if (a.amount <= 0) {
      throw new Error(`validateGenesisConfig: allocation "${a.category}" has non-positive amount ${a.amount}`);
    }
    if (!a.address.trim()) {
      throw new Error(`validateGenesisConfig: allocation "${a.category}" has an empty address`);
    }
  }

  for (const v of config.initialValidators) {
    if (v.stake <= 0) {
      throw new Error(`validateGenesisConfig: validator "${v.name}" has non-positive stake ${v.stake}`);
    }
    if (!v.address.trim()) {
      throw new Error(`validateGenesisConfig: validator "${v.name}" has an empty address`);
    }
  }

  for (const pool of config.dexPools) {
    if (pool.reserveA <= 0 || pool.reserveB <= 0) {
      throw new Error(`validateGenesisConfig: dex pool "${pool.pair}" must have positive reserves on both sides`);
    }
  }

  const p = config.parameters;
  if (p.targetBlockTimeMs <= 0) throw new Error("validateGenesisConfig: parameters.targetBlockTimeMs must be positive");
  if (p.residualThreshold <= 0) throw new Error("validateGenesisConfig: parameters.residualThreshold must be positive");
  if (p.initialDifficulty <= 0) throw new Error("validateGenesisConfig: parameters.initialDifficulty must be positive");
  if (p.slashingDoubleSignPct < 0 || p.slashingDoubleSignPct > 100) {
    throw new Error("validateGenesisConfig: parameters.slashingDoubleSignPct must be between 0 and 100");
  }
  if (p.slashingDowntimePct < 0 || p.slashingDowntimePct > 100) {
    throw new Error("validateGenesisConfig: parameters.slashingDowntimePct must be between 0 and 100");
  }
  if (p.unbondingPeriodBlocks < 0) throw new Error("validateGenesisConfig: parameters.unbondingPeriodBlocks must be non-negative");
  if (p.maxValidators <= 0) throw new Error("validateGenesisConfig: parameters.maxValidators must be positive");
  if (p.governanceQuorumPct <= 0 || p.governanceQuorumPct > 100) {
    throw new Error("validateGenesisConfig: parameters.governanceQuorumPct must be between 0 and 100");
  }
  if (p.governanceVotingPeriodBlocks <= 0) {
    throw new Error("validateGenesisConfig: parameters.governanceVotingPeriodBlocks must be positive");
  }
}

/**
 * Build the canonical `genesis.json` document from a `GenesisConfig`.
 * Validates the config first (throws on any invariant violation), then
 * serializes numeric EQU amounts as decimal strings — matching the spec's
 * example document — to avoid float-precision loss for large supplies.
 */
export function generateGenesis(config: GenesisConfig): GenesisDocument {
  validateGenesisConfig(config);

  return {
    chain_id: config.chainId,
    timestamp: config.timestamp,
    initial_supply: config.initialSupply.toString(10),
    allocations: config.allocations.map((a) => ({
      address: a.address,
      amount: a.amount.toString(10),
      vesting: a.vesting,
      category: a.category,
    })),
    initial_validators: config.initialValidators.map((v) => ({
      address: v.address,
      stake: v.stake.toString(10),
      name: v.name,
    })),
    dex_pools: config.dexPools.map((p) => ({
      pair: p.pair,
      reserve_a: p.reserveA.toString(10),
      reserve_b: p.reserveB.toString(10),
    })),
    parameters: {
      target_block_time_ms: config.parameters.targetBlockTimeMs,
      residual_threshold: config.parameters.residualThreshold,
      initial_difficulty: config.parameters.initialDifficulty,
      slashing_double_sign_pct: config.parameters.slashingDoubleSignPct,
      slashing_downtime_pct: config.parameters.slashingDowntimePct,
      unbonding_period_blocks: config.parameters.unbondingPeriodBlocks,
      max_validators: config.parameters.maxValidators,
      governance_quorum_pct: config.parameters.governanceQuorumPct,
      governance_voting_period_blocks: config.parameters.governanceVotingPeriodBlocks,
    },
  };
}

/**
 * A ready-to-use mainnet genesis config using the exact allocation split from
 * the spec's example (`20/15/25/30/10` million EQU, summing to the 100M
 * genesis supply). Placeholder `eq1...` addresses must be replaced with real
 * addresses before this is ever used to launch a real network — this export
 * exists for tests, previews, and as a documented starting point.
 */
export function defaultMainnetGenesisConfig(timestamp: string): GenesisConfig {
  return {
    chainId: "equilibrium-1",
    timestamp,
    initialSupply: MAINNET_GENESIS_SUPPLY,
    maxSupply: MAINNET_MAX_SUPPLY,
    allocations: [
      { address: "eq1coreCONTRIBUTORSPLACEHOLDER00000000", amount: 20_000_000, vesting: "4-year linear", category: "core_contributors" },
      { address: "eq1earlyBACKERSPLACEHOLDER0000000000000", amount: 15_000_000, vesting: "3-year linear", category: "early_backers" },
      { address: "eq1communityTREASURYPLACEHOLDER000000000", amount: 25_000_000, vesting: "none", category: "community_treasury" },
      { address: "eq1miningRESERVEPLACEHOLDER0000000000000", amount: 30_000_000, vesting: "10-year linear", category: "mining_reserve" },
      { address: "eq1ecosystemFUNDPLACEHOLDER00000000000000", amount: 10_000_000, vesting: "none", category: "ecosystem_fund" },
    ],
    initialValidators: [
      { address: "eq1foundationVALIDATORPLACEHOLDER00000000", stake: 500_000, name: "Equilibrium Foundation" },
    ],
    dexPools: [
      { pair: "EQU-WBTC", reserveA: 5_000_000, reserveB: 50 },
      { pair: "EQU-USDC", reserveA: 5_000_000, reserveB: 5_000_000 },
    ],
    parameters: MAINNET_GENESIS_PARAMETERS,
  };
}
