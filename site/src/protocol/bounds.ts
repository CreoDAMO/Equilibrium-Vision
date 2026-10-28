/**
 * §2.5-a. The domain applySuccessor already admits.
 * A value outside this domain is a refusal, not a successor.
 * DIFFICULTY_FLOOR is the floor adjustDifficulty returns. It is not a new admission gate.
 */
export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
export const NONCE_MAX = (1n << 64n) - 1n;
export const PRESSURE_MIN = 0;
export const PRESSURE_MAX = 1;
export const DIFFICULTY_FLOOR = 100_000;

export function pressureRefused(pressure: number): boolean {
  return !Number.isFinite(pressure) || pressure < PRESSURE_MIN || pressure > PRESSURE_MAX;
}

export function timestampRefused(timestamp: number): boolean {
  return !Number.isSafeInteger(timestamp) || timestamp < 0;
}

export function nonceRefused(nonce: bigint): boolean {
  return typeof nonce !== "bigint" || nonce < 0n || nonce > NONCE_MAX;
}
