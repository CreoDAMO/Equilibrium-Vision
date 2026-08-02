/**
 * Mining policy — random-residual fallback is OFF by default.
 *
 * Only ALLOW_RANDOM_MINING=true enables Math.random() mining (unit tests / demos).
 * Production, development, and unset env all require the real solver unless that
 * flag is set. CI Vitest must set ALLOW_RANDOM_MINING=true if it still exercises
 * the sync helper or async fallback.
 */

export function allowRandomMiningFallback(): boolean {
  return process.env["ALLOW_RANDOM_MINING"] === "true";
}

export function requireRealSolver(): boolean {
  return !allowRandomMiningFallback();
}

export function assertRandomMiningAllowed(caller?: string): void {
  if (!allowRandomMiningFallback()) {
    const who = caller ? `${caller}: ` : "";
    throw new Error(
      `${who}RNG mining is forbidden. ` +
        "Use the consensus-api / variational-ai solver, or set " +
        "ALLOW_RANDOM_MINING=true for tests only.",
    );
  }
}
