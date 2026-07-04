import { describe, expect, it } from "vitest";
import {
  allocateValidatorRewards,
  distributeStakingRewards,
  splitValidatorReward,
  totalBondedStake,
  type ValidatorStake,
} from "./staking.js";

function validator(overrides: Partial<ValidatorStake> = {}): ValidatorStake {
  return {
    address: "eq1validator",
    selfStake: 100,
    commissionPct: 10,
    delegators: [
      { address: "eq1delA", stake: 300 },
      { address: "eq1delB", stake: 600 },
    ],
    ...overrides,
  };
}

describe("totalBondedStake", () => {
  it("sums self-stake and all delegator stakes", () => {
    expect(totalBondedStake(validator())).toBe(1000);
  });

  it("equals self-stake alone when there are no delegators", () => {
    expect(totalBondedStake(validator({ delegators: [] }))).toBe(100);
  });
});

describe("allocateValidatorRewards", () => {
  it("splits a reward proportionally to bonded stake across validators", () => {
    const v1 = validator({ address: "v1", selfStake: 100, delegators: [] }); // 100 bonded
    const v2 = validator({ address: "v2", selfStake: 300, delegators: [] }); // 300 bonded
    const allocations = allocateValidatorRewards(400, [v1, v2]);
    expect(allocations.get("v1")).toBeCloseTo(100, 10); // 25% of 400
    expect(allocations.get("v2")).toBeCloseTo(300, 10); // 75% of 400
  });

  it("gives the sole validator the entire reward", () => {
    const v = validator({ address: "solo" });
    const allocations = allocateValidatorRewards(50, [v]);
    expect(allocations.get("solo")).toBeCloseTo(50, 10);
  });

  it("rejects an empty validator set", () => {
    expect(() => allocateValidatorRewards(100, [])).toThrow(/at least one validator/);
  });

  it("rejects a negative total reward", () => {
    expect(() => allocateValidatorRewards(-1, [validator()])).toThrow(RangeError);
  });

  it("rejects a validator with non-positive selfStake", () => {
    expect(() => allocateValidatorRewards(100, [validator({ selfStake: 0 })])).toThrow(RangeError);
  });

  it("rejects an out-of-range commission percentage", () => {
    expect(() => allocateValidatorRewards(100, [validator({ commissionPct: 101 })])).toThrow(RangeError);
    expect(() => allocateValidatorRewards(100, [validator({ commissionPct: -1 })])).toThrow(RangeError);
  });

  it("rejects a delegator with non-positive stake", () => {
    const v = validator({ delegators: [{ address: "eq1bad", stake: 0 }] });
    expect(() => allocateValidatorRewards(100, [v])).toThrow(RangeError);
  });
});

describe("splitValidatorReward", () => {
  it("keeps the full reward for the validator when there are no delegators", () => {
    const v = validator({ delegators: [] });
    const payout = splitValidatorReward(100, v);
    expect(payout.validatorAmount).toBeCloseTo(100, 10);
    expect(payout.delegatorPayouts).toEqual([]);
  });

  it("splits self-stake share, commission, and delegator pool correctly", () => {
    // bonded = 1000 (100 self + 900 delegated), commission 10%
    const v = validator();
    const payout = splitValidatorReward(1000, v);

    // selfShare = 1000 * (100/1000) = 100
    // delegatedPortion = 1000 * (900/1000) = 900
    // commission = 900 * 0.10 = 90
    // delegatorPool = 900 - 90 = 810
    // validatorAmount = 100 (self) + 90 (commission) = 190
    expect(payout.validatorAmount).toBeCloseTo(190, 10);

    // delegatorPool split proportionally: A gets 300/900 of 810, B gets 600/900 of 810
    const a = payout.delegatorPayouts.find((d) => d.address === "eq1delA")!;
    const b = payout.delegatorPayouts.find((d) => d.address === "eq1delB")!;
    expect(a.amount).toBeCloseTo(270, 10);
    expect(b.amount).toBeCloseTo(540, 10);

    // Total distributed must equal the input reward (no leakage).
    const total = payout.validatorAmount + payout.delegatorPayouts.reduce((sum, d) => sum + d.amount, 0);
    expect(total).toBeCloseTo(1000, 8);
  });

  it("pays the validator everything when commission is 100%", () => {
    const v = validator({ commissionPct: 100 });
    const payout = splitValidatorReward(1000, v);
    expect(payout.validatorAmount).toBeCloseTo(1000, 10);
    for (const d of payout.delegatorPayouts) {
      expect(d.amount).toBeCloseTo(0, 10);
    }
  });

  it("pays delegators everything (minus zero commission) when commission is 0%", () => {
    const v = validator({ commissionPct: 0, selfStake: 0.0001, delegators: [{ address: "eq1solo", stake: 999.9999 }] });
    const payout = splitValidatorReward(1000, v);
    expect(payout.delegatorPayouts[0].amount).toBeGreaterThan(payout.validatorAmount);
  });

  it("rejects a negative validatorReward", () => {
    expect(() => splitValidatorReward(-1, validator())).toThrow(RangeError);
  });
});

describe("distributeStakingRewards", () => {
  it("conserves the total reward across all validators and delegators", () => {
    const v1 = validator({ address: "v1", selfStake: 100, commissionPct: 5 });
    const v2 = validator({ address: "v2", selfStake: 400, commissionPct: 20, delegators: [{ address: "eq1delC", stake: 100 }] });
    const totalReward = 12345.6789;

    const payouts = distributeStakingRewards(totalReward, [v1, v2]);

    const grandTotal = payouts.reduce(
      (sum, p) => sum + p.validatorAmount + p.delegatorPayouts.reduce((s, d) => s + d.amount, 0),
      0,
    );
    expect(grandTotal).toBeCloseTo(totalReward, 6);
  });

  it("returns payouts in the same order as the input validators", () => {
    const v1 = validator({ address: "first" });
    const v2 = validator({ address: "second" });
    const payouts = distributeStakingRewards(1000, [v1, v2]);
    expect(payouts.map((p) => p.address)).toEqual(["first", "second"]);
  });
});
