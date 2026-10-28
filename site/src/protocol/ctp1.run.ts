/**
 * The checker agrees with the production successor.
 * A changed input, a changed predecessor, and a forged claim do not.
 * The adoption flag is off. C-007 stays open.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialOmega, openedCouplings, type CanonicalInputs, type Omega } from "./constitution";
import { canonicalEvidence } from "./evidence";
import { genesisValidators, minerKey } from "./genesis";
import { blankEvidence } from "./seal";
import { admissionAllows, API_CANONICAL_ROLE, AUTHORITATIVE_MUTATION } from "./admission-policy";
import { ADOPTION_REQUIRES_TRANSITION_PROOF, verifyTransitionProof } from "./transition-proof";
import {
  adoptionGate,
  c007Status,
  encodeEvidence,
  evaluateCtp1,
  proveCtp1,
  structuredInputId,
  verifyCtp1,
} from "./ctp1";

function base(omega: Omega): CanonicalInputs {
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
const spec = base(before);
const proved = await proveCtp1({ before, inputs: spec });
assert.equal(proved.ok, true);
if (!proved.ok) throw new Error(proved.reason);
const checked = await verifyCtp1(proved.proof, { before, inputs: spec });
assert.equal(checked.ok, true);
if (!checked.ok) throw new Error(checked.reason);
assert.equal(checked.statement.header, proved.evaluation.statement.header);
assert.equal(checked.statement.stateRoot, proved.evaluation.stepped.stateRoot);
assert.notEqual(checked.statement.successor, checked.statement.carried);

const again = await evaluateCtp1({ before, inputs: spec });
assert.equal(again.ok, true);
if (!again.ok) throw new Error(again.reason);
assert.equal(again.statementId, proved.proof.statementId);

const otherMiner = genesisValidators().find((v) => v.address !== spec.miner);
assert.ok(otherMiner);
const moved = await verifyCtp1(proved.proof, { before, inputs: { ...spec, miner: otherMiner.address } });
assert.equal(moved.ok, false);

const older = initialOmega("mainnet");
older.tipTimestamp = 5;
const stale = await verifyCtp1(proved.proof, { before: older, inputs: { ...spec, timestamp: 6 } });
assert.equal(stale.ok, false);

const forged = await verifyCtp1({ ...proved.proof, statementId: "0".repeat(64) }, { before, inputs: spec });
assert.equal(forged.ok, false);
if (forged.ok) throw new Error("forged");
assert.equal(forged.reason, "statement is not this execution");

const missing = await verifyCtp1(proved.proof, null);
assert.equal(missing.ok, false);
if (missing.ok) throw new Error("missing");
assert.match(missing.reason, /not a succinct proof/);

const absent = blankEvidence(before.chainId);
const emptyLists = { ...absent, cognition: [], settle: [], withdraw: [] };
assert.equal(canonicalEvidence(absent), canonicalEvidence(emptyLists));
assert.notEqual(Buffer.from(encodeEvidence(absent)).toString("hex"), Buffer.from(encodeEvidence(emptyLists)).toString("hex"));
assert.notEqual(structuredInputId({ ...spec, evidence: absent }), structuredInputId({ ...spec, evidence: emptyLists }));

const slashed = await proveCtp1({
  before,
  inputs: {
    ...spec,
    evidence: {
      ...blankEvidence(before.chainId),
      stake: [{ op: "slash", validator: otherMiner.address, reason: "downtime" }],
    },
  },
});
assert.equal(slashed.ok, true);
if (!slashed.ok) throw new Error(slashed.reason);
assert.equal(slashed.evaluation.stepped.next.validators.get(otherMiner.address)?.slashed, true);
const unsigned = await proveCtp1({
  before,
  inputs: {
    ...spec,
    evidence: {
      ...blankEvidence(before.chainId),
      stake: [{ op: "delegate", delegator: spec.miner, validator: spec.miner, amount: 1 }],
    },
  },
});
assert.equal(unsigned.ok, false);

const wasm = await proveCtp1({
  before,
  inputs: {
    ...spec,
    evidence: { ...blankEvidence(before.chainId), wasm: [{ method: "init", caller: spec.miner }] },
  },
});
assert.equal(wasm.ok, true);
if (!wasm.ok) throw new Error(wasm.reason);
assert.equal(wasm.evaluation.stepped.next.wasm.get("owner"), spec.miner);
assert.equal(wasm.evaluation.stepped.next.wasm.get("paused"), "0");
const wrongCaller = await verifyCtp1(wasm.proof, {
  before,
  inputs: {
    ...spec,
    evidence: { ...blankEvidence(before.chainId), wasm: [{ method: "init", caller: otherMiner.address }] },
  },
});
assert.equal(wrongCaller.ok, false);

const open = await adoptionGate(false, null, null);
assert.equal(open.ok, true);
if (!open.ok) throw new Error("open");
assert.equal(open.enforced, false);
const forced = await adoptionGate(true, { before, inputs: spec }, proved.proof);
assert.equal(forced.ok, false);
if (forced.ok) throw new Error("a reexecution receipt is not a transition proof");
const blocked = await adoptionGate(true, { before, inputs: spec }, null);
assert.equal(blocked.ok, false);

assert.equal(ADOPTION_REQUIRES_TRANSITION_PROOF, false);
assert.equal(c007Status().closed, false);
assert.equal(verifyTransitionProof(proved.evaluation.statement, { system: CTP1Name(), bytes: Uint8Array.of(1) }).ok, false);

const chain = readFileSync(new URL("./chain.ts", import.meta.url), "utf8");
assert.equal(chain.includes("adoptionGate"), true);
assert.equal(chain.includes("admissionAllows(ADOPTION_REQUIRES_TRANSITION_PROOF)"), true);
assert.equal(AUTHORITATIVE_MUTATION, "site-adopt");
assert.equal(API_CANONICAL_ROLE, "operational-mirror");
assert.equal(admissionAllows(false).ok, true);
assert.equal(admissionAllows(true).ok, false);

function CTP1Name() {
  return "reexecution-v1";
}

console.log("ctp1 checker matches production; C-007 remains open");
console.log(c007Status().reason);
