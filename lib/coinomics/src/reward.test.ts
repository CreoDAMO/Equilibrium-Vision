import { describe, expect, it } from "vitest";
import {
  MAINNET_REWARD_PARAMS,
  blockReward,
  cumulativeEmission,
  minerReward,
  qualityMultiplier,
} from "./reward.js";

describe("blockReward", () => {
  it("returns the base reward at height 0", () => {
    expect(blockReward(0)).toBe(MAINNET_REWARD_PARAMS.baseReward);
  });

  it("halves exactly at one halving interval", () => {
    const reward = blockReward(MAINNET_REWARD_PARAMS.halvingInterval);
    expect(reward).toBeCloseTo(MAINNET_REWARD_PARAMS.baseReward / 2, 10);
  });

  it("quarters exactly at two halving intervals", () => {
    const reward = blockReward(MAINNET_REWARD_PARAMS.halvingInterval * 2);
    expect(reward).toBeCloseTo(MAINNET_REWARD_PARAMS.baseReward / 4, 10);
  });

  it("decays monotonically as height increases", () => {
    const early = blockReward(1000);
    const later = blockReward(2000);
    expect(later).toBeLessThan(early);
  });

  it("approaches (but never reaches) zero at very large heights", () => {
    const reward = blockReward(MAINNET_REWARD_PARAMS.halvingInterval * 40);
    expect(reward).toBeGreaterThan(0);
    expect(reward).toBeLessThan(1e-9);
  });

  it("supports custom curve params", () => {
    expect(blockReward(50, { baseReward: 10, halvingInterval: 100 })).toBeCloseTo(10 * Math.pow(0.5, 0.5), 10);
  });

  it("rejects negative or non-finite heights", () => {
    expect(() => blockReward(-1)).toThrow(RangeError);
    expect(() => blockReward(Number.NaN)).toThrow(RangeError);
    expect(() => blockReward(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("rejects a non-positive halving interval", () => {
    expect(() => blockReward(10, { baseReward: 100, halvingInterval: 0 })).toThrow(RangeError);
  });
});

describe("qualityMultiplier", () => {
  it("returns ~1.0 (minus the epsilon term) when the residual exactly matches the target", () => {
    // 1e-7 / (1e-7 + 1e-9) = 0.990099...  — the 1e-9 epsilon is intentional
    // (per spec) so a residual exactly at target is not quite a perfect 1.0.
    expect(qualityMultiplier(1e-7, 1e-7)).toBeCloseTo(0.9900990099009901, 10);
  });

  it("returns 1.0 (capped) when the residual is far better than target", () => {
    expect(qualityMultiplier(1e-12, 1e-7)).toBe(1.0);
  });

  it("scales down proportionally for a worse residual", () => {
    // actual = 2x target -> ~0.5 multiplier (slightly under, due to the epsilon)
    // 1e-7 / (2e-7 + 1e-9) = 0.4975124378109453
    expect(qualityMultiplier(2e-7, 1e-7)).toBeCloseTo(0.4975124378109453, 10);
  });

  it("never divides by exactly zero for a perfect (zero) residual", () => {
    expect(() => qualityMultiplier(0, 1e-7)).not.toThrow();
    expect(qualityMultiplier(0, 1e-7)).toBe(1.0);
  });

  it("rejects negative residuals", () => {
    expect(() => qualityMultiplier(-1, 1e-7)).toThrow(RangeError);
    expect(() => qualityMultiplier(1e-7, -1)).toThrow(RangeError);
  });
});

describe("minerReward", () => {
  it("equals the full block reward when quality is perfect", () => {
    const reward = minerReward(0, 0, 1e-7);
    expect(reward).toBeCloseTo(MAINNET_REWARD_PARAMS.baseReward, 5);
  });

  it("scales down with both height decay and quality multiplier", () => {
    const atHalving = minerReward(MAINNET_REWARD_PARAMS.halvingInterval, 2e-7, 1e-7);
    // baseReward/2 (height decay) * 0.4975124378109453 (quality, see qualityMultiplier tests)
    expect(atHalving).toBeCloseTo((MAINNET_REWARD_PARAMS.baseReward / 2) * 0.4975124378109453, 6);
  });

  it("is never negative", () => {
    expect(minerReward(1_000_000, 5e-7, 1e-7)).toBeGreaterThanOrEqual(0);
  });
});

describe("cumulativeEmission", () => {
  it("is zero for uptoHeight = 0", () => {
    expect(cumulativeEmission(0)).toBe(0);
  });

  it("equals the sum of individual block rewards", () => {
    const manual = blockReward(0) + blockReward(1) + blockReward(2);
    expect(cumulativeEmission(3)).toBeCloseTo(manual, 10);
  });

  it("grows monotonically with height", () => {
    expect(cumulativeEmission(2000)).toBeGreaterThan(cumulativeEmission(1000));
  });

  it("rejects negative uptoHeight", () => {
    expect(() => cumulativeEmission(-5)).toThrow(RangeError);
  });
});
