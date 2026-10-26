/**
 * The four transition states are different objects, and adoption does not verify a proof of any of them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applySuccessor,
  initialOmega,
  omegaDigest,
} from "./constitution";
import { canonicalEvidence } from "./evidence";
import { fullStateId } from "./fullstate";
import { blankEvidence } from "./seal";
import { sealFromSuccessor } from "./seal";
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
const stepped = applySuccessor(before, spec);
assert.equal(stepped.ok, true);
if (!stepped.ok) throw new Error(stepped.error);
const sealed = sealFromSuccessor(before, spec, stepped);
const statement = transitionStatement(before, spec, stepped, sealed);

assert.equal(statement.predecessor, fullStateId(before));
assert.equal(statement.successor, fullStateId(stepped.next));
assert.equal(statement.carried, fullStateId(sealed.carried));
assert.equal(sealed.carried.tipHash, sealed.hash);
assert.equal(stepped.next.tipHash, before.tipHash);
assert.notEqual(statement.predecessor, statement.successor);
assert.notEqual(statement.successor, statement.carried);
assert.notEqual(statement.stateRoot, statement.omegaRoot);
assert.notEqual(omegaDigest(before), statement.predecessor);

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
const absorbAt = chain.indexOf("private async absorb(");
const composeAt = chain.indexOf("private composeBlock(");
assert.ok(absorbAt > composeAt);
assert.match(chain.slice(composeAt, absorbAt), /applySuccessor\(omega,/);
assert.match(chain.slice(composeAt, absorbAt), /this\.pending = this\.blankEvidence\(\)/);
assert.match(chain.slice(absorbAt), /await successor\(this\.toOmega\(\)/);
assert.match(chain.slice(absorbAt), /adoptionGate\(\s*ADOPTION_REQUIRES_TRANSITION_PROOF/);
assert.equal(chain.includes("verifyTransitionProof"), false);
