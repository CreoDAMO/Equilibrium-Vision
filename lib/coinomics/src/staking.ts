// ── Staking / delegation reward-splitting calculator ────────────────────────
//
// Implements the "Staking rewards" rules from the Equilibrium Mainnet
// Specification:
//
//   "Validators earn block rewards proportional to bonded stake.
//    Delegators earn a share of their validator's reward, minus a
//    validator-defined commission."
//
// This module is a pure calculator: given a total block reward and a set of
// validators (each with their own self-bonded stake, a list of delegators,
// and a commission percentage), it computes exactly how much EQU each
// validator and each delegator is owed for that block. No state, no I/O —
// callers are responsible for actually crediting balances.

export interface Delegator {
  address: string;
  /** Amount of EQU this delegator has bonded to the validator. */
  stake: number;
}

export interface ValidatorStake {
  address: string;
  /** The validator's own bonded stake (excludes delegated stake). */
  selfStake: number;
  /** Commission the validator keeps from its delegators' share, 0-100 (%). */
  commissionPct: number;
  delegators: Delegator[];
}

export interface DelegatorPayout {
  address: string;
  amount: number;
}

export interface ValidatorPayout {
  address: string;
  /** Total EQU paid to the validator: its self-stake share + commission earned from delegators. */
  validatorAmount: number;
  /** Per-delegator payouts, net of the validator's commission. */
  delegatorPayouts: DelegatorPayout[];
}

/** Sum of a validator's self-bonded stake plus all of its delegators' stake. */
export function totalBondedStake(validator: ValidatorStake): number {
  return validator.selfStake + validator.delegators.reduce((sum, d) => sum + d.stake, 0);
}

export function assertValidatorStake(validator: ValidatorStake): void {
  if (!validator.address.trim()) {
    throw new Error("assertValidatorStake: validator address must be non-empty");
  }
  if (!Number.isFinite(validator.selfStake) || validator.selfStake <= 0) {
    throw new RangeError(
      `assertValidatorStake: validator "${validator.address}" selfStake must be positive, got ${validator.selfStake}`,
    );
  }
  if (!Number.isFinite(validator.commissionPct) || validator.commissionPct < 0 || validator.commissionPct > 100) {
    throw new RangeError(
      `assertValidatorStake: validator "${validator.address}" commissionPct must be between 0 and 100, got ${validator.commissionPct}`,
    );
  }
  for (const d of validator.delegators) {
    if (!d.address.trim()) {
      throw new Error(`assertValidatorStake: validator "${validator.address}" has a delegator with an empty address`);
    }
    if (!Number.isFinite(d.stake) || d.stake <= 0) {
      throw new RangeError(
        `assertValidatorStake: delegator "${d.address}" of validator "${validator.address}" must have positive stake, got ${d.stake}`,
      );
    }
  }
}

/**
 * Allocate a total block reward across validators, proportional to each
 * validator's total bonded stake (self + delegated) relative to the network's
 * total bonded stake. Returns a map of validator address -> reward share
 * (before that validator's own commission split is applied).
 */
export function allocateValidatorRewards(
  totalBlockReward: number,
  validators: ValidatorStake[],
): Map<string, number> {
  if (!Number.isFinite(totalBlockReward) || totalBlockReward < 0) {
    throw new RangeError(`allocateValidatorRewards: totalBlockReward must be non-negative, got ${totalBlockReward}`);
  }
  if (validators.length === 0) {
    throw new Error("allocateValidatorRewards: at least one validator is required");
  }
  validators.forEach(assertValidatorStake);

  const networkStake = validators.reduce((sum, v) => sum + totalBondedStake(v), 0);
  if (networkStake <= 0) {
    throw new Error("allocateValidatorRewards: total network bonded stake must be positive");
  }

  const allocations = new Map<string, number>();
  for (const validator of validators) {
    const share = totalBondedStake(validator) / networkStake;
    allocations.set(validator.address, totalBlockReward * share);
  }
  return allocations;
}

/**
 * Split a single validator's reward share between the validator itself and
 * its delegators, per the spec's commission rule:
 *
 *   1. The reward is first divided between the validator's self-stake and
 *      its delegated stake, proportional to each's share of the validator's
 *      total bonded stake.
 *   2. The validator keeps `commissionPct`% of the delegated-stake portion
 *      as commission (in addition to its full self-stake portion).
 *   3. The remaining delegated-stake portion is distributed to delegators
 *      proportional to their individual stake.
 */
export function splitValidatorReward(validatorReward: number, validator: ValidatorStake): ValidatorPayout {
  if (!Number.isFinite(validatorReward) || validatorReward < 0) {
    throw new RangeError(`splitValidatorReward: validatorReward must be non-negative, got ${validatorReward}`);
  }
  assertValidatorStake(validator);

  const bonded = totalBondedStake(validator);
  const delegatedStake = validator.delegators.reduce((sum, d) => sum + d.stake, 0);

  const selfShare = validatorReward * (validator.selfStake / bonded);
  const delegatedPortion = validatorReward * (delegatedStake / bonded);
  const commission = delegatedPortion * (validator.commissionPct / 100);
  const delegatorPool = delegatedPortion - commission;

  const delegatorPayouts: DelegatorPayout[] = validator.delegators.map((d) => ({
    address: d.address,
    amount: delegatedStake > 0 ? delegatorPool * (d.stake / delegatedStake) : 0,
  }));

  return {
    address: validator.address,
    validatorAmount: selfShare + commission,
    delegatorPayouts,
  };
}

/**
 * End-to-end staking reward distribution for a single block: allocates the
 * total block reward across validators by bonded stake, then splits each
 * validator's share between itself and its delegators by commission.
 * Returns one `ValidatorPayout` per validator, in the same order as the
 * input `validators` array.
 */
export function distributeStakingRewards(
  totalBlockReward: number,
  validators: ValidatorStake[],
): ValidatorPayout[] {
  const perValidatorReward = allocateValidatorRewards(totalBlockReward, validators);
  return validators.map((validator) => splitValidatorReward(perValidatorReward.get(validator.address)!, validator));
}
