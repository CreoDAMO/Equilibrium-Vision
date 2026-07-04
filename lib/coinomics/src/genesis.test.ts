import { describe, expect, it } from "vitest";
import {
  MAINNET_GENESIS_PARAMETERS,
  MAINNET_GENESIS_SUPPLY,
  MAINNET_MAX_SUPPLY,
  defaultMainnetGenesisConfig,
  generateGenesis,
  validateGenesisConfig,
  type GenesisConfig,
} from "./genesis.js";

const TIMESTAMP = "2026-12-01T00:00:00Z";

function baseConfig(overrides: Partial<GenesisConfig> = {}): GenesisConfig {
  return {
    chainId: "equilibrium-1",
    timestamp: TIMESTAMP,
    initialSupply: 100,
    maxSupply: 1000,
    allocations: [{ address: "eq1abc", amount: 100, vesting: "none", category: "test" }],
    initialValidators: [{ address: "eq1validator", stake: 10, name: "Test Validator" }],
    dexPools: [{ pair: "EQU-USDC", reserveA: 1000, reserveB: 1000 }],
    parameters: MAINNET_GENESIS_PARAMETERS,
    ...overrides,
  };
}

describe("defaultMainnetGenesisConfig", () => {
  it("produces allocations that sum exactly to the genesis supply", () => {
    const config = defaultMainnetGenesisConfig(TIMESTAMP);
    const total = config.allocations.reduce((sum, a) => sum + a.amount, 0);
    expect(total).toBe(MAINNET_GENESIS_SUPPLY);
    expect(config.initialSupply).toBe(MAINNET_GENESIS_SUPPLY);
  });

  it("keeps genesis supply within the fixed max supply cap", () => {
    const config = defaultMainnetGenesisConfig(TIMESTAMP);
    expect(config.initialSupply).toBeLessThanOrEqual(MAINNET_MAX_SUPPLY);
  });

  it("passes validation as-is", () => {
    expect(() => validateGenesisConfig(defaultMainnetGenesisConfig(TIMESTAMP))).not.toThrow();
  });
});

describe("validateGenesisConfig", () => {
  it("accepts a well-formed config", () => {
    expect(() => validateGenesisConfig(baseConfig())).not.toThrow();
  });

  it("rejects an empty chainId", () => {
    expect(() => validateGenesisConfig(baseConfig({ chainId: "" }))).toThrow(/chainId/);
  });

  it("rejects an invalid timestamp", () => {
    expect(() => validateGenesisConfig(baseConfig({ timestamp: "not-a-date" }))).toThrow(/timestamp/);
  });

  it("rejects initialSupply greater than maxSupply", () => {
    expect(() => validateGenesisConfig(baseConfig({ initialSupply: 2000, maxSupply: 1000 }))).toThrow(/exceeds maxSupply/);
  });

  it("rejects zero allocations", () => {
    expect(() => validateGenesisConfig(baseConfig({ allocations: [] }))).toThrow(/at least one allocation/);
  });

  it("rejects allocations that do not sum to initialSupply", () => {
    const config = baseConfig({
      allocations: [{ address: "eq1abc", amount: 50, vesting: "none", category: "test" }],
    });
    expect(() => validateGenesisConfig(config)).toThrow(/sum to/);
  });

  it("rejects a non-positive allocation amount", () => {
    const config = baseConfig({
      allocations: [{ address: "eq1abc", amount: 0, vesting: "none", category: "test" }],
      initialSupply: 0,
    });
    expect(() => validateGenesisConfig(config)).toThrow();
  });

  it("rejects a validator with non-positive stake", () => {
    const config = baseConfig({
      initialValidators: [{ address: "eq1validator", stake: 0, name: "Bad Validator" }],
    });
    expect(() => validateGenesisConfig(config)).toThrow(/non-positive stake/);
  });

  it("rejects a dex pool with a non-positive reserve", () => {
    const config = baseConfig({ dexPools: [{ pair: "EQU-USDC", reserveA: 0, reserveB: 1000 }] });
    expect(() => validateGenesisConfig(config)).toThrow(/positive reserves/);
  });

  it("rejects an out-of-range governance quorum percentage", () => {
    const config = baseConfig({
      parameters: { ...MAINNET_GENESIS_PARAMETERS, governanceQuorumPct: 150 },
    });
    expect(() => validateGenesisConfig(config)).toThrow(/governanceQuorumPct/);
  });

  it("rejects a non-positive target block time", () => {
    const config = baseConfig({
      parameters: { ...MAINNET_GENESIS_PARAMETERS, targetBlockTimeMs: 0 },
    });
    expect(() => validateGenesisConfig(config)).toThrow(/targetBlockTimeMs/);
  });
});

describe("generateGenesis", () => {
  it("produces the canonical snake_case document shape", () => {
    const doc = generateGenesis(baseConfig());
    expect(doc.chain_id).toBe("equilibrium-1");
    expect(doc.timestamp).toBe(TIMESTAMP);
    expect(doc.initial_supply).toBe("100");
    expect(doc.allocations[0]).toEqual({ address: "eq1abc", amount: "100", vesting: "none", category: "test" });
    expect(doc.initial_validators[0]).toEqual({ address: "eq1validator", stake: "10", name: "Test Validator" });
    expect(doc.dex_pools[0]).toEqual({ pair: "EQU-USDC", reserve_a: "1000", reserve_b: "1000" });
    expect(doc.parameters.target_block_time_ms).toBe(MAINNET_GENESIS_PARAMETERS.targetBlockTimeMs);
    expect(doc.parameters.governance_voting_period_blocks).toBe(MAINNET_GENESIS_PARAMETERS.governanceVotingPeriodBlocks);
  });

  it("serializes large EQU amounts as exact decimal strings (no float precision loss)", () => {
    const doc = generateGenesis(defaultMainnetGenesisConfig(TIMESTAMP));
    expect(doc.initial_supply).toBe("100000000");
    expect(doc.allocations.find((a) => a.category === "mining_reserve")?.amount).toBe("30000000");
  });

  it("throws instead of generating a document for an invalid config", () => {
    expect(() => generateGenesis(baseConfig({ chainId: "" }))).toThrow();
  });

  it("round-trips through JSON without losing precision", () => {
    const doc = generateGenesis(defaultMainnetGenesisConfig(TIMESTAMP));
    const roundTripped = JSON.parse(JSON.stringify(doc));
    expect(roundTripped).toEqual(doc);
  });
});
