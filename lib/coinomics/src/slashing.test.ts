import { describe, expect, it } from "vitest";
import {
  applySlashing,
  slashingPercentageForReason,
  SLASHING_DOUBLE_SIGN_PCT,
  SLASHING_DOWNTIME_PCT,
  SLASHING_JAIL_INCIDENT_THRESHOLD,
} from "./slashing.js";
import { totalBondedStake, type ValidatorStake } from "./staking.js";

function validator(overrides: Partial<ValidatorStake> = {}): ValidatorStake {
  return {
    address: "eq1validator",
    selfStake: 1000,
    commissionPct: 10,
    delegators: [
      { address: "eq1delA", stake: 3000 },
      { address: "eq1delB", stake: 6000 },
    ],
    ...overrides,
  };
}

describe("slashingPercentageForReason", () => {
  it("returns the double-sign percentage", () => {
    expect(slashingPercentageForReason("double_sign")).toBe(SLASHING_DOUBLE_SIGN_PCT);
  });

  it("returns the downtime percentage for downtime and invalid_block alike", () => {
    expect(slashingPercentageForReason("downtime")).toBe(SLASHING_DOWNTIME_PCT);
    expect(slashingPercentageForReason("invalid_block")).toBe(SLASHING_DOWNTIME_PCT);
  });
});

describe("applySlashing — double_sign", () => {
  it("burns 5% of the validator's and each delegator's stake and always jails", () => {
    const v = validator();
    const { result, slashedValidator } = applySlashing(v, { reason: "double_sign" });

    expect(result.slashedPct).toBe(5);
    expect(result.jailed).toBe(true);
    expect(result.validatorAmountBurned).toBeCloseTo(50, 10); // 5% of 1000
    expect(result.delegatorSlashes.find((d) => d.address === "eq1delA")!.amountBurned).toBeCloseTo(150, 10); // 5% of 3000
    expect(result.delegatorSlashes.find((d) => d.address === "eq1delB")!.amountBurned).toBeCloseTo(300, 10); // 5% of 6000
    expect(result.totalBurned).toBeCloseTo(500, 10); // 5% of total bonded 10000

    expect(slashedValidator.selfStake).toBeCloseTo(950, 10);
    expect(slashedValidator.delegators.find((d) => d.address === "eq1delA")!.stake).toBeCloseTo(2850, 10);
    expect(slashedValidator.delegators.find((d) => d.address === "eq1delB")!.stake).toBeCloseTo(5700, 10);
  });

  it("rejects an incidentCountInWindow for double_sign", () => {
    expect(() => applySlashing(validator(), { reason: "double_sign", incidentCountInWindow: 1 })).toThrow(
      /must not be provided/,
    );
  });

  it("preserves conservation: burned + remaining bonded stake equals original bonded stake", () => {
    const v = validator();
    const originalBonded = totalBondedStake(v);
    const { result, slashedValidator } = applySlashing(v, { reason: "double_sign" });
    expect(result.totalBurned + totalBondedStake(slashedValidator)).toBeCloseTo(originalBonded, 8);
  });
});

describe("applySlashing — downtime / invalid_block", () => {
  it("burns 1% of stake per incident and does not jail below the threshold", () => {
    const v = validator();
    const { result, slashedValidator } = applySlashing(v, { reason: "downtime", incidentCountInWindow: 1 });

    expect(result.slashedPct).toBe(1);
    expect(result.jailed).toBe(false);
    expect(result.validatorAmountBurned).toBeCloseTo(10, 10); // 1% of 1000
    expect(slashedValidator.selfStake).toBeCloseTo(990, 10);
  });

  it("jails once the incident count reaches the threshold", () => {
    const v = validator();
    const belowThreshold = applySlashing(v, {
      reason: "downtime",
      incidentCountInWindow: SLASHING_JAIL_INCIDENT_THRESHOLD - 1,
    });
    expect(belowThreshold.result.jailed).toBe(false);

    const atThreshold = applySlashing(v, { reason: "downtime", incidentCountInWindow: SLASHING_JAIL_INCIDENT_THRESHOLD });
    expect(atThreshold.result.jailed).toBe(true);

    const aboveThreshold = applySlashing(v, {
      reason: "downtime",
      incidentCountInWindow: SLASHING_JAIL_INCIDENT_THRESHOLD + 5,
    });
    expect(aboveThreshold.result.jailed).toBe(true);
  });

  it("treats invalid_block identically to downtime", () => {
    const v = validator();
    const downtime = applySlashing(v, { reason: "downtime", incidentCountInWindow: 3 });
    const invalidBlock = applySlashing(v, { reason: "invalid_block", incidentCountInWindow: 3 });
    expect(invalidBlock.result.slashedPct).toBe(downtime.result.slashedPct);
    expect(invalidBlock.result.jailed).toBe(downtime.result.jailed);
    expect(invalidBlock.result.validatorAmountBurned).toBeCloseTo(downtime.result.validatorAmountBurned, 10);
  });

  it("requires incidentCountInWindow for downtime and invalid_block", () => {
    expect(() => applySlashing(validator(), { reason: "downtime" })).toThrow(/incidentCountInWindow is required/);
    expect(() => applySlashing(validator(), { reason: "invalid_block" })).toThrow(/incidentCountInWindow is required/);
  });

  it("rejects a non-positive or non-integer incidentCountInWindow", () => {
    expect(() => applySlashing(validator(), { reason: "downtime", incidentCountInWindow: 0 })).toThrow(RangeError);
    expect(() => applySlashing(validator(), { reason: "downtime", incidentCountInWindow: -1 })).toThrow(RangeError);
    expect(() => applySlashing(validator(), { reason: "downtime", incidentCountInWindow: 1.5 })).toThrow(RangeError);
  });
});

describe("applySlashing — validator input validation", () => {
  it("rejects a validator with a non-positive selfStake", () => {
    expect(() => applySlashing(validator({ selfStake: 0 }), { reason: "double_sign" })).toThrow(RangeError);
  });

  it("rejects a validator with an out-of-range commission percentage", () => {
    expect(() => applySlashing(validator({ commissionPct: 150 }), { reason: "double_sign" })).toThrow(RangeError);
  });

  it("rejects a delegator with non-positive stake", () => {
    const v = validator({ delegators: [{ address: "eq1bad", stake: -5 }] });
    expect(() => applySlashing(v, { reason: "double_sign" })).toThrow(RangeError);
  });

  it("handles a validator with no delegators", () => {
    const v = validator({ delegators: [] });
    const { result, slashedValidator } = applySlashing(v, { reason: "double_sign" });
    expect(result.delegatorSlashes).toEqual([]);
    expect(result.totalBurned).toBeCloseTo(result.validatorAmountBurned, 10);
    expect(slashedValidator.delegators).toEqual([]);
  });
});
