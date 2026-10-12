/**
 * The opportunities cache stores a scan, not one HTTP body.
 * A later smaller limit slices that scan. A saturated smaller scan does not
 * answer a larger limit. The published fields are tokens and profitFactor.
 */
import { describe, expect, it } from "vitest";
import {
  opportunityLimit,
  opportunitiesBody,
  scanCovers,
  type OpportunityScan,
} from "../routes/arbitrage.js";
import type { ArbitrageOpportunity } from "../variational-ai/bridge.js";

function cycle(profitFactor: number): ArbitrageOpportunity {
  return {
    tokens: ["EQU", "WBTC", "USDC", "EQU"],
    poolIds: ["EQU-WBTC", "WBTC-USDC", "USDC-EQU"],
    hopCount: 3,
    rates: [1.01, 1.01, 1.01],
    profitFactor,
    optimalAmountIn: 10,
    expectedProfit: profitFactor,
  };
}

function scan(scannedAt: number, count: number): OpportunityScan {
  return {
    at: Date.now(),
    poolsScanned: 2,
    scannedAt,
    opportunities: Array.from({ length: count }, (_, i) => cycle(0.01 + i)),
  };
}

describe("an opportunity limit applies to the cached scan", () => {
  it("defaults to 5 and clamps into 1..20", () => {
    expect(opportunityLimit(undefined)).toBe(5);
    expect(opportunityLimit("2")).toBe(2);
    expect(opportunityLimit(999)).toBe(20);
    expect(opportunityLimit("0")).toBe(1);
    expect(opportunityLimit("-4")).toBe(1);
    expect(opportunityLimit("nope")).toBe(5);
  });

  it("slices a scan of 5 down to the requested limit of 2", () => {
    const cached = scan(5, 5);
    expect(scanCovers(cached, 2, 2)).toBe(true);
    const body = opportunitiesBody(cached, 2);
    expect(body.opportunities).toHaveLength(2);
    expect(body.count).toBe(2);
    expect(body.opportunities[0]?.tokens).toEqual(["EQU", "WBTC", "USDC", "EQU"]);
    expect(typeof body.opportunities[0]?.profitFactor).toBe("number");
    expect(body.opportunities[0]).not.toHaveProperty("path");
    expect(body.opportunities[0]).not.toHaveProperty("profit_ratio");
  });

  it("does not reuse a saturated scan for a larger limit", () => {
    expect(scanCovers(scan(2, 2), 5, 2)).toBe(false);
  });

  it("reuses a scan that already returned fewer cycles than it asked for", () => {
    const cached = scan(5, 1);
    expect(scanCovers(cached, 20, 2)).toBe(true);
    expect(opportunitiesBody(cached, 20).opportunities).toHaveLength(1);
  });

  it("does not cover a different pool count or an expired scan", () => {
    const cached = scan(5, 5);
    expect(scanCovers(cached, 2, 3)).toBe(false);
    expect(scanCovers({ ...cached, at: Date.now() - 5_000 }, 2, 2)).toBe(false);
  });
});
