/**
 * Port of lib/coinomics (CreoDAMO/Equilibrium-Vision).
 * Territory left this body out of the public runtime; it is now the reward law.
 *
 *   reward(height) = base * (1/2)^(height / halving_interval)
 *   quality        = min(1, target / (R + 1e-9))
 *   payout         = reward * quality
 */

export interface RewardCurveParams {
  baseReward: number;
  halvingInterval: number;
}

export const MAINNET_REWARD_PARAMS: RewardCurveParams = {
  baseReward: 100,
  halvingInterval: 2_100_000,
};

export function blockReward(height: number, params: RewardCurveParams = MAINNET_REWARD_PARAMS): number {
  if (!Number.isFinite(height) || height < 0) return 0;
  if (params.halvingInterval <= 0) return params.baseReward;
  return params.baseReward * Math.pow(0.5, height / params.halvingInterval);
}

export function qualityMultiplier(actualResidual: number, targetResidual: number): number {
  if (!Number.isFinite(actualResidual) || actualResidual < 0) return 0;
  if (!Number.isFinite(targetResidual) || targetResidual < 0) return 0;
  return Math.min(1, targetResidual / (actualResidual + 1e-9));
}

export function minerReward(
  height: number,
  actualResidual: number,
  targetResidual: number,
  params: RewardCurveParams = MAINNET_REWARD_PARAMS,
): number {
  return blockReward(height, params) * qualityMultiplier(actualResidual, targetResidual);
}

export const SLASH_DOUBLE_SIGN = 0.05;
export const SLASH_DOWNTIME = 0.01;

export function slashAmount(bonded: number, reason: "double_sign" | "downtime"): number {
  const pct = reason === "double_sign" ? SLASH_DOUBLE_SIGN : SLASH_DOWNTIME;
  return Math.floor(bonded * pct);
}
