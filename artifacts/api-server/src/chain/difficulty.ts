/**
 * The public kernel's difficulty law.
 * No tip is 1/1. A tip's last byte is the integer ratio [9950, 10050] / 10000.
 * Off the 0.8 and 1.2 rails the step is integer division, not a float product.
 */
export function foreignTipFactor(
  btcTip: string | null | undefined,
  ethTip: string | null | undefined,
): { num: number; den: number } {
  let num = 1;
  let den = 1;
  const apply = (hash: string | null | undefined) => {
    if (!hash || hash.length < 2) return;
    const byte = Number.parseInt(hash.slice(-2), 16);
    if (!Number.isFinite(byte)) return;
    const bump = Math.round((byte / 255) * 100);
    num *= 9950 + bump;
    den *= 10_000;
  };
  apply(btcTip);
  apply(ethTip);
  return { num, den };
}

export function adjustDifficultySeconds(
  difficulty: number,
  blockTime: number,
  targetSeconds: number,
  foreign: { num: number; den: number } = { num: 1, den: 1 },
): number {
  if (blockTime <= 0) return difficulty;
  const unclamped = (targetSeconds / blockTime) * (foreign.num / foreign.den);
  const factor = Math.max(0.8, Math.min(1.2, unclamped));
  if (factor === 0.8 || factor === 1.2) {
    return Math.max(100_000, Math.floor(difficulty * factor));
  }
  const scaled = Math.floor((difficulty * targetSeconds * foreign.num) / (blockTime * foreign.den));
  return Math.max(100_000, scaled);
}
