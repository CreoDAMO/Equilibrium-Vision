/**
 * Mining policy — governs whether random-residual fallback is permitted.
 *
 * Random fallback is blocked only when NODE_ENV=production (or when
 * REQUIRE_REAL_SOLVER=true is set explicitly).  In all other environments
 * (development, test, unset) the fallback is allowed so the server starts
 * without the Rust consensus-api binary.
 *
 * Rationale: the important invariant is that *mainnet / production deploys*
 * never emit blocks whose residuals came from Math.random().  Development
 * and CI environments legitimately run without the Rust binary.
 *
 * Overrides:
 *   NODE_ENV=production        → require real solver (default fail-closed)
 *   REQUIRE_REAL_SOLVER=true   → require real solver (explicit opt-in on any env)
 *   ALLOW_RANDOM_MINING=true   → always allow random (overrides production lock)
 *   REQUIRE_REAL_SOLVER=false  → always allow random (complementary name)
 */

export function allowRandomMiningFallback(): boolean {
  // Explicit allow overrides everything (demo / migration scenarios).
  if (process.env["ALLOW_RANDOM_MINING"] === "true") return true;
  if (process.env["REQUIRE_REAL_SOLVER"] === "false") return true;

  // Only enforce fail-closed in production or when explicitly demanded.
  const env = process.env["NODE_ENV"];
  if (env === "production") return false;
  if (process.env["REQUIRE_REAL_SOLVER"] === "true") return false;

  // development / test / unset — allow fallback.
  return true;
}

/** Inverse of allowRandomMiningFallback — true when the real solver is required. */
export function requireRealSolver(): boolean {
  return !allowRandomMiningFallback();
}

/**
 * Assert that random-residual mining is permitted in the current environment.
 * Throws with a clear message when it is not.
 *
 * Call this at the top of any sync mining helper that uses Math.random() so
 * production code paths fail loudly instead of silently emitting fake blocks.
 *
 * @param caller - optional name included in the error message for diagnostics.
 */
export function assertRandomMiningAllowed(caller?: string): void {
  if (!allowRandomMiningFallback()) {
    const who = caller ? `${caller}: ` : "";
    throw new Error(
      `${who}RNG mining is forbidden in this environment. ` +
      "Build the equilibrium consensus-api binary for real PoS, or set " +
      "ALLOW_RANDOM_MINING=true / NODE_ENV=test for non-production use only.",
    );
  }
}
