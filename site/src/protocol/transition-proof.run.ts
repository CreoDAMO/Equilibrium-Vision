/**
 * The statement distinguishes FS1 from omegaDigest, and the verifier
 * accepts nothing. Adoption is not wired.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySuccessor, initialOmega, omegaDigest, openedCouplings, type CanonicalInputs, type Omega } from "./constitution";
import { minerKey } from "./genesis";
import { blankEvidence, sealFromSuccessor } from "./seal";
import { fullStateId } from "./fullstate";
import { NETWORKS } from "./networks";
import {
  ADOPTION_REQUIRES_TRANSITION_PROOF,
  encodeContext,
  encodeInputs,
  predecessorBytes,
  statementId,
  transitionStatement,
  verifyTransitionProof,
} from "./transition-proof";
import { sha256Hex } from "./crypto";

function inputs(omega: Omega): CanonicalInputs {
  return {
    transactions: [],
    evidence: blankEvidence(omega.chainId),
    timestamp: omega.tipTimestamp + 1,
    nonce: 1n,
    miner: minerKey("mainnet").address,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}

const before = initialOmega("mainnet");
const digest = omegaDigest(before);
const spec = inputs(before);
const stepped = applySuccessor(before, spec);
assert.equal(stepped.ok, true);
if (!stepped.ok) throw new Error(stepped.error);
const sealed = sealFromSuccessor(before, spec, stepped);
const statement = transitionStatement(before, spec, stepped, sealed);

assert.equal(statement.predecessor, fullStateId(before));
assert.notEqual(statement.predecessor, digest);
assert.notEqual(statement.successor, statement.carried);
assert.equal(statement.header.length, 64);
assert.equal(statementId(statement), statementId(statement));
assert.notEqual(sha256Hex(encodeContext(NETWORKS.mainnet)), sha256Hex(encodeContext(NETWORKS.testnet)));

const emptyAfter = encodeInputs({ ...spec, wasmAfter: new Map([["k", "v"]]) });
assert.equal(Buffer.from(encodeInputs(spec)).toString("hex"), Buffer.from(emptyAfter).toString("hex"));

const missing = initialOmega("mainnet");
delete (missing as { ethExecution?: unknown }).ethExecution;
const empty = initialOmega("mainnet");
empty.ethExecution = [];
assert.equal(omegaDigest(missing), omegaDigest(empty));
assert.notEqual(fullStateId(missing), fullStateId(empty));
assert.notEqual(
  Buffer.from(predecessorBytes(missing)).toString("hex"),
  Buffer.from(predecessorBytes(empty)).toString("hex"),
);

assert.equal(ADOPTION_REQUIRES_TRANSITION_PROOF, false);
assert.deepEqual(verifyTransitionProof(statement, null), {
  ok: false,
  reason: "no complete transition proof is defined",
});
assert.equal(
  verifyTransitionProof(statement, { system: "stationarity", bytes: Uint8Array.of(1) }).ok,
  false,
);

const chain = readFileSync(new URL("./chain.ts", import.meta.url), "utf8");
assert.equal(chain.includes("verifyTransitionProof"), false);

console.log("transition statement refuses every proof");
console.log(statementId(statement));
