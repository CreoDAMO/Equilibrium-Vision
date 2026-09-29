/**
 * EQ-09 at the candidate boundary. This does not install anything.
 * A chain is a contiguous list of blocks whose parent is already canonical.
 * Weight is the sum of residualFp on that list, not a float sum.
 */
export function chainWeight(blocks: ReadonlyArray<{ residualFp: number }>): bigint {
  return blocks.reduce((sum, block) => sum + BigInt(block.residualFp), 0n);
}

/** Lower weight wins. Equal weight: the lexicographically smaller tip hash wins. */
export function preferChain(
  candidate: { weight: bigint; tipHash: string },
  incumbent: { weight: bigint; tipHash: string },
): boolean {
  if (candidate.weight < incumbent.weight) return true;
  if (candidate.weight > incumbent.weight) return false;
  return candidate.tipHash < incumbent.tipHash;
}
