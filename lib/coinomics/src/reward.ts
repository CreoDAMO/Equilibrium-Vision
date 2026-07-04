// ── Block reward curve + PoS quality multiplier ─────────────────────────────
//
// Implements the coinomics formulas from the Equilibrium Mainnet Specification
// ("Coinomics" section):
//
//   reward(height) = base_reward * (1/2)^(height / halving_interval)
//   quality_factor  = min(1.0, target_residual / (actual_residual + 1e-9))
//   payout          = reward(height) * quality_factor
//
// The reward curve decays continuously (not in discrete step-halvings) so that
// every block height maps to a unique, deterministic reward. `1e-9` is added
// to the residual denominator to avoid division by zero for a perfect (zero)
// residual, matching the mainnet spec exactly.

export interface RewardCurveParams {
  /** Reward paid at block height 0, in whole EQU. */
  baseReward: number;
  /** Number of blocks between halvings. */
  halvingInterval: number;
}

/** Mainnet defaults from the Coinomics spec: 100 EQU base reward, halving every 2.1M blocks (~1 year at 15s blocks). */
export const MAINNET_REWARD_PARAMS: RewardCurveParams = {
  baseReward: 100,
  halvingInterval: 2_100_000,
};

/**
 * Compute the base block reward (before the quality multiplier) at a given
 * block height, in whole EQU.
 *
 * reward(height) = base_reward * (1/2)^(height / halving_interval)
 */
export function blockReward(
  height: number,
  params: RewardCurveParams = MAINNET_REWARD_PARAMS,
): number {
  if (!Number.isFinite(height) || height < 0) {
    throw new RangeError(`blockReward: height must be a non-negative finite number, got ${height}`);
  }
  if (params.halvingInterval <= 0) {
    throw new RangeError(`blockReward: halvingInterval must be positive, got ${params.halvingInterval}`);
  }
  return params.baseReward * Math.pow(0.5, height / params.halvingInterval);
}

/**
 * Compute the Proof-of-Stationarity quality multiplier for a solved block.
 *
 * quality_factor = min(1.0, target_residual / (actual_residual + 1e-9))
 *
 * A residual at or below the target yields the full 1.0 multiplier; a worse
 * (larger) residual scales the reward down proportionally. Residual values
 * must be non-negative — the PoS residual is defined as a magnitude and
 * cannot be negative.
 */
export function qualityMultiplier(actualResidual: number, targetResidual: number): number {
  if (!Number.isFinite(actualResidual) || actualResidual < 0) {
    throw new RangeError(`qualityMultiplier: actualResidual must be a non-negative finite number, got ${actualResidual}`);
  }
  if (!Number.isFinite(targetResidual) || targetResidual < 0) {
    throw new RangeError(`qualityMultiplier: targetResidual must be a non-negative finite number, got ${targetResidual}`);
  }
  return Math.min(1.0, targetResidual / (actualResidual + 1e-9));
}

/**
 * Compute the final miner payout for a solved block: the height-based base
 * reward scaled by the residual-based quality multiplier.
 *
 * payout = blockReward(height) * qualityMultiplier(actualResidual, targetResidual)
 */
export function minerReward(
  height: number,
  actualResidual: number,
  targetResidual: number,
  params: RewardCurveParams = MAINNET_REWARD_PARAMS,
): number {
  return blockReward(height, params) * qualityMultiplier(actualResidual, targetResidual);
}

/**
 * Total EQU emitted by mining rewards from genesis (height 0) up to but not
 * including `uptoHeight`, computed as the exact sum of the geometric-decay
 * reward curve (assuming a perfect 1.0 quality multiplier on every block).
 * Useful for projecting emission schedules and verifying the supply cap.
 */
export function cumulativeEmission(
  uptoHeight: number,
  params: RewardCurveParams = MAINNET_REWARD_PARAMS,
): number {
  if (!Number.isFinite(uptoHeight) || uptoHeight < 0) {
    throw new RangeError(`cumulativeEmission: uptoHeight must be a non-negative finite number, got ${uptoHeight}`);
  }
  let total = 0;
  for (let h = 0; h < uptoHeight; h++) {
    total += blockReward(h, params);
  }
  return total;
}
