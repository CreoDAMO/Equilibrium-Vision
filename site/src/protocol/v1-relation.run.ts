/**
 * The descriptor pin. A changed byte fails. The old identifier keeps its old bytes.
 * This is not a proof of the transition.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { descriptorDigest, FAITHFUL_V1, V1_RELATION, V1_RELATION_ID } from "./v1-relation";
import { verifyTransitionProof } from "./transition-proof";

const PINS = {
  "faithful-v1": "2073254801bb642e5918bc7e0de5e1915377d09e08f118ec2cded28b3f8878e3",
  "faithful-v1.1": "83ea7e2c265abe5911667eb47724a5c47f227afdcdacc3f20fd5105e9a114bb2",
} as const;

assert.equal(V1_RELATION_ID, "faithful-v1.1");
assert.equal(V1_RELATION.id, V1_RELATION_ID);
assert.equal(descriptorDigest(FAITHFUL_V1), PINS["faithful-v1"]);
assert.equal(descriptorDigest(V1_RELATION), PINS[V1_RELATION_ID]);
assert.equal(
  PINS["faithful-v1.1"],
  "83ea7e2c265abe5911667eb47724a5c4" + "7f227afdcdacc3f20fd5105e9a114bb2",
);

assert.equal("claims" in V1_RELATION.ethBeacon, false);
assert.equal(V1_RELATION.ethBeacon.bootstrap.claims.includes("first committee"), true);
assert.equal(V1_RELATION.ethBeacon.subsequent.claims.includes("later header"), true);
assert.equal(V1_RELATION.ethBeacon.bootstrap.excludes, V1_RELATION.ethBeacon.subsequent.excludes);

const trimmed = {
  ...V1_RELATION,
  couplings: { ...V1_RELATION.couplings, claims: V1_RELATION.couplings.claims.trim() + " " },
};
assert.notEqual(descriptorDigest(trimmed), PINS[V1_RELATION_ID]);

const added = { ...V1_RELATION, extra: "no" };
assert.notEqual(descriptorDigest(added), PINS[V1_RELATION_ID]);

const swapped = {
  ...V1_RELATION,
  btcHeaders: { ...V1_RELATION.btcHeaders, claims: V1_RELATION.ethExecution.claims },
};
assert.notEqual(descriptorDigest(swapped), PINS[V1_RELATION_ID]);

const fields = [
  "version",
  "v1",
  "numericModel",
  "predecessor",
  "inputId",
  "contextId",
  "stateRoot",
  "stateRootStateId",
  "omegaRoot",
  "successor",
  "carried",
  "evidenceRoot",
  "transitionRoot",
  "header",
  "residualFp",
  "wasm",
];
const writer = readFileSync(new URL("./transition-proof.ts", import.meta.url), "utf8");
const body = writer.slice(writer.indexOf("export function statementBytes"), writer.indexOf("export function statementId"));
let at = 0;
for (const field of fields) {
  const next = body.indexOf(field, at);
  assert.ok(next > at, field);
  at = next;
}

assert.equal(verifyTransitionProof({ ...FAITHFUL_V1, version: 1 } as never, null).ok, false);

console.log("v1 descriptor is pinned; the circuit is not this pin");
