// ── Slashing calculator ──────────────────────────────────────────────────────
//
// Implements the "Slashing" rules from the Equilibrium Mainnet Specification:
//
//   "Double-sign: 5% of validator's bonded stake permanently burned;
//    validator jailed.
//    Downtime: 1% of stake burned per incident; after 3 incidents in a
//    rolling window, jailed.
//    Invalid block: same as downtime."
//
// This module is a pure calculator: given a validator's current stake state
// and the reason for the penalty, it computes exactly how much EQU is
// burned from the validator's self-stake and from each of its delegators
// (delegators share the validator's risk pro-rata, per bonded-stake
// slashing semantics), and whether the validator should be jailed. No
// state, no I/O — callers are responsible for actually burning the EQU,
// persisting the updated stakes, and jailing the validator.

import { assertValidatorStake, type Delegator, type ValidatorStake } from "./staking.js";

export type SlashingReason = "double_sign" | "downtime" | "invalid_block";

/** % of bonded stake permanently burned for a double-sign offense. */
export const SLASHING_DOUBLE_SIGN_PCT = 5;
/** % of bonded stake burned per downtime (or invalid block) incident. */
export const SLASHING_DOWNTIME_PCT = 1;
/** Number of downtime/invalid-block incidents within a rolling window that triggers jailing. */
export const SLASHING_JAIL_INCIDENT_THRESHOLD = 3;

export interface SlashingParams {
  reason: SlashingReason;
  /**
   * Number of downtime/invalid-block incidents observed for this validator
   * within the current rolling window, including this one. Required for
   * `"downtime"` and `"invalid_block"`; ignored (and not required) for
   * `"double_sign"`, which always jails immediately.
   */
  incidentCountInWindow?: number;
}

export interface DelegatorSlash {
  address: string;
  amountBurned: number;
}

export interface SlashingResult {
  validatorAddress: string;
  reason: SlashingReason;
  /** The slashing percentage applied to bonded stake for this reason. */
  slashedPct: number;
  /** EQU burned from the validator's own self-stake. */
  validatorAmountBurned: number;
  /** EQU burned from each delegator's stake, pro-rata to the same percentage. */
  delegatorSlashes: DelegatorSlash[];
  /** Sum of validatorAmountBurned and all delegatorSlashes amounts. */
  totalBurned: number;
  /** Whether this offense results in the validator being jailed. */
  jailed: boolean;
}

export interface SlashingOutcome {
  result: SlashingResult;
  /** The validator's stake record after the slash has been deducted. */
  slashedValidator: ValidatorStake;
}

/** The slashing percentage of bonded stake burned for a given offense type. */
export function slashingPercentageForReason(reason: SlashingReason): number {
  switch (reason) {
    case "double_sign":
      return SLASHING_DOUBLE_SIGN_PCT;
    case "downtime":
    case "invalid_block":
      return SLASHING_DOWNTIME_PCT;
    default: {
      const exhaustiveCheck: never = reason;
      throw new Error(`slashingPercentageForReason: unknown slashing reason "${exhaustiveCheck}"`);
    }
  }
}

/**
 * Apply a slashing penalty to a validator (and, pro-rata, to its
 * delegators) for the given offense.
 *
 * - `double_sign` burns 5% of bonded stake and always jails the validator.
 * - `downtime` / `invalid_block` burn 1% of bonded stake per incident, and
 *   jail the validator once `incidentCountInWindow` reaches
 *   `SLASHING_JAIL_INCIDENT_THRESHOLD` (3) within the rolling window.
 *
 * Both the validator's self-stake and each delegator's stake are slashed at
 * the same percentage, reflecting that delegators share the validator's
 * slashing risk proportionally to their bonded stake.
 */
export function applySlashing(validator: ValidatorStake, params: SlashingParams): SlashingOutcome {
  assertValidatorStake(validator);

  const { reason } = params;
  const pct = slashingPercentageForReason(reason);

  if (reason === "double_sign") {
    if (params.incidentCountInWindow !== undefined) {
      throw new Error('applySlashing: incidentCountInWindow must not be provided for reason "double_sign"');
    }
  } else {
    if (params.incidentCountInWindow === undefined) {
      throw new Error(`applySlashing: incidentCountInWindow is required for reason "${reason}"`);
    }
    if (!Number.isInteger(params.incidentCountInWindow) || params.incidentCountInWindow < 1) {
      throw new RangeError(
        `applySlashing: incidentCountInWindow must be a positive integer, got ${params.incidentCountInWindow}`,
      );
    }
  }

  const validatorAmountBurned = validator.selfStake * (pct / 100);
  const delegatorSlashes: DelegatorSlash[] = validator.delegators.map((d) => ({
    address: d.address,
    amountBurned: d.stake * (pct / 100),
  }));
  const totalBurned = validatorAmountBurned + delegatorSlashes.reduce((sum, d) => sum + d.amountBurned, 0);

  const jailed = reason === "double_sign" || params.incidentCountInWindow! >= SLASHING_JAIL_INCIDENT_THRESHOLD;

  const slashedDelegators: Delegator[] = validator.delegators.map((d, i) => ({
    address: d.address,
    stake: d.stake - delegatorSlashes[i]!.amountBurned,
  }));

  const slashedValidator: ValidatorStake = {
    ...validator,
    selfStake: validator.selfStake - validatorAmountBurned,
    delegators: slashedDelegators,
  };

  return {
    result: {
      validatorAddress: validator.address,
      reason,
      slashedPct: pct,
      validatorAmountBurned,
      delegatorSlashes,
      totalBurned,
      jailed,
    },
    slashedValidator,
  };
}
