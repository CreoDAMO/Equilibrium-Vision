/**
 * Production admission is the site replay of applySuccessor.
 * Rust consensus is not a gate. A stationarity proof is not this relation.
 *
 * Composition is staged. One step is one statement. Component circuits are not
 * collected into an admission. The accumulated proof is the later bootstrap of
 * this same chain.
 *
 * When a transition proof is required and it is missing, invalid, or only a
 * reexecution receipt, admission stops. There is no compatibility path for a
 * new block.
 */
export const PRODUCTION_ADMISSION = "site-replay";
export const PROOF_COMPOSITION = "staged-hybrid";
export const PROOF_UNAVAILABLE = "stop";
