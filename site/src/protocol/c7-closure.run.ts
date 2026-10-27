/**
 * The four transition states are different objects, and adoption does not verify a proof of any of them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initialOmega,
  omegaDigest,
} from "./constitution";
import { canonicalEvidence } from "./evidence";
import { fullStateId } from "./fullstate";
import { blankEvidence } from "./seal";
import { executeTransition } from "./executor";
import { encodeEvidence, structuredInputId } from "./ctp1";
import { c007Status } from "./ctp1";
import {
  ADOPTION_REQUIRES_TRANSITION_PROOF,
  encodeInputs,
  transitionStatement,
  verifyTransitionProof,
} from "./transition-proof";
import { minerKey } from "./genesis";

const before = initialOmega("testnet");
const miner = minerKey("testnet").address;
const spec = {
  transactions: [],
  timestamp: 15,
  nonce: 0n,
  miner,
  committedPressure: 0,
  couplings: { ...before.couplings },
  difficulty: before.difficulty,
  wasmAfter: null,
};
const executed = executeTransition(before, spec);
assert.equal(executed.ok, true);
if (!executed.ok) throw new Error(executed.error);
const stepped = executed.execution.stepped;
const sealed = executed.execution.sealed;
const statement = transitionStatement(executed.execution);

assert.equal(statement.predecessor, fullStateId(before));
assert.equal(statement.successor, fullStateId(stepped.next));
assert.equal(statement.carried, fullStateId(sealed.carried));
assert.equal(sealed.carried.tipHash, sealed.hash);
assert.equal(stepped.next.tipHash, before.tipHash);
assert.notEqual(statement.predecessor, statement.successor);
assert.notEqual(statement.successor, statement.carried);
assert.notEqual(statement.stateRoot, statement.omegaRoot);
assert.notEqual(omegaDigest(before), statement.predecessor);
assert.equal(statement.inputId, executed.execution.inputId);
assert.equal(statement.stateRootStateId, stepped.stateRootStateId);
assert.notEqual(statement.stateRootStateId, statement.successor);
assert.throws(() => transitionStatement({ ...executed.execution, inputId: "0".repeat(64) }), /input is not this execution/);

const absent = blankEvidence(before.chainId);
const emptyLists = { ...absent, cognition: [], settle: [], withdraw: [] };
assert.equal(canonicalEvidence(absent), canonicalEvidence(emptyLists));
assert.equal(encodeInputs({ ...spec, evidence: absent }).length, encodeInputs({ ...spec, evidence: emptyLists }).length);
assert.equal(
  Buffer.from(encodeInputs({ ...spec, evidence: absent })).toString("hex"),
  Buffer.from(encodeInputs({ ...spec, evidence: emptyLists })).toString("hex"),
);
assert.notEqual(Buffer.from(encodeEvidence(absent)).toString("hex"), Buffer.from(encodeEvidence(emptyLists)).toString("hex"));
assert.notEqual(
  structuredInputId({ ...spec, evidence: absent }),
  structuredInputId({ ...spec, evidence: emptyLists }),
);

assert.equal(ADOPTION_REQUIRES_TRANSITION_PROOF, false);
assert.deepEqual(verifyTransitionProof(statement, null), {
  ok: false,
  reason: "no complete transition proof is defined",
});
assert.equal(c007Status().closed, false);

const chain = readFileSync(new URL("./chain.ts", import.meta.url), "utf8");
const composeAt = chain.indexOf("private composeBlock(");
const mineAt = chain.indexOf("\n  mine(");
assert.ok(composeAt > 0 && mineAt > composeAt);
assert.equal(chain.slice(composeAt, mineAt).includes("this.pending = this.blankEvidence()"), false);
assert.match(chain, /executeTransition\(omega, inputs\)/);
assert.match(chain, /executeTransition\(this\.toOmega\(\), inputs\)/);
assert.equal(chain.includes("verifyTransitionProof"), false);
