import assert from "node:assert/strict";
import {
  TRANSITION_PROOF_MISSING,
  transitionProofCoversRelation,
  verifyTransitionProof,
  type TransitionStatement,
} from "./transition-proof";

const statement = {
  version: 1,
  numericModel: "ECMA-262",
  v1: "faithful-v1.1",
  predecessor: "ab".repeat(32),
  inputId: "cd".repeat(32),
  contextId: "ef".repeat(32),
  stateRoot: "01".repeat(32),
  stateRootStateId: "02".repeat(32),
  omegaRoot: "03".repeat(32),
  successor: "04".repeat(32),
  carried: "05".repeat(32),
  evidenceRoot: "06".repeat(32),
  transitionRoot: "07".repeat(32),
  header: "08".repeat(32),
  residualFp: "5",
  wasm: "09".repeat(32),
} as TransitionStatement;

assert.equal(transitionProofCoversRelation(), false);
assert.equal(TRANSITION_PROOF_MISSING.length, 10);
assert.deepEqual(verifyTransitionProof(statement, null), {
  ok: false,
  reason: "no complete transition proof is defined",
});
assert.equal(
  verifyTransitionProof(statement, { system: "transition-statement", bytes: Uint8Array.of(1) }).ok,
  false,
);

console.log("the statement proof does not cover the relation");
