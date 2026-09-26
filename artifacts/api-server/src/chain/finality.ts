/**
 * EQ-10. The public kernel finalizes height − 2 when live bonded stake
 * is at least 2/3 of total bonded stake. Jailed and slashed stake stays
 * in the denominator and out of the numerator. This function does not
 * invent votes and it does not burn stake.
 */
export const FINALITY_QUORUM = 2 / 3;
export const FINALITY_LAG = 2;

export function nextFinalizedHeight(
  height: number,
  finalizedHeight: number,
  liveStake: number,
  totalStake: number,
): number {
  if (!(totalStake > 0)) return finalizedHeight;
  if (!(liveStake / totalStake >= FINALITY_QUORUM)) return finalizedHeight;
  const cutoff = height - FINALITY_LAG;
  return cutoff > finalizedHeight ? cutoff : finalizedHeight;
}

export function stakeForFinality(
  validators: Iterable<{ bondedStake: number; jailed: boolean; slashed: boolean }>,
): { liveStake: number; totalStake: number } {
  let liveStake = 0;
  let totalStake = 0;
  for (const v of validators) {
    totalStake += v.bondedStake;
    if (!v.jailed && !v.slashed) liveStake += v.bondedStake;
  }
  return { liveStake, totalStake };
}
