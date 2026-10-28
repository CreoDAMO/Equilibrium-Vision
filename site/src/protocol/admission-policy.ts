/**
 * Production admission is the site replay of applySuccessor.
 * Rust consensus is not a gate. A stationarity proof is not this relation.
 *
 * The authoritative mutation is site adopt(). Local commit() and peer absorb()
 * both ask admissionAllows() before they reach it. A block this node mines is
 * not exempt.
 *
 * The API server replays the same relation and installs an operational copy.
 * That copy is not a second constitution and not the C-007 gate. It does not
 * carry the site statement. Refusing it here would stop block submission
 * before a statement exists on that wire.
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
export const AUTHORITATIVE_MUTATION = "site-adopt";
export const API_CANONICAL_ROLE = "operational-mirror";
export const PROOF_COMPOSITION = "staged-hybrid";
export const PROOF_UNAVAILABLE = "stop";

export function admissionAllows(requireProof: boolean): { ok: true } | { ok: false; reason: string } {
  if (!requireProof) return { ok: true };
  if (PROOF_UNAVAILABLE !== "stop") return { ok: false, reason: "proof policy is not stop" };
  return { ok: false, reason: "no complete transition proof is defined" };
}
