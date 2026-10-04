/**
 * Committee identity. C is the only key source.
 * K is Aggregate(C). A header verifies Aggregate(C_B), not K.
 * Rotation authorizes C_next. A bare K is not an operation.
 * The nonce-6 fingerprint is not part of this change.
 */
import assert from "node:assert/strict";
import { CanonicalBody } from "../../../artifacts/api-server/src/chain/canonical-body";
import { OrganismNode } from "./chain";
import { applySuccessor, initialOmega, omegaDigest, openedCouplings } from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import {
  committeeAggregate,
  hexOf,
  participationMask,
  signRotation,
  signSelected,
  syncCommittee,
} from "./eth-light";
import { minerKey } from "./genesis";
import { blankEvidence, omegaRecord } from "./seal";
import { evaluateResidual } from "./solver";
import type { CanonicalInputs, EthEvidence } from "./types";

const born = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
const c = syncCommittee(1);
const c2 = syncCommittee(2);
const bits342 = participationMask(342);
const fields = {
  slot: 1,
  proposerIndex: 0,
  parentRoot: "11".repeat(32),
  stateRoot: "22".repeat(32),
  bodyRoot: "33".repeat(32),
};

function inputs(evidence: CanonicalInputs["evidence"]): CanonicalInputs {
  return {
    transactions: [],
    evidence,
    timestamp: 1_700_000_000,
    nonce: 6n,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(born),
    difficulty: born.difficulty,
    wasmAfter: null,
  };
}

function flipHex(hex: string): string {
  return hex.slice(0, -2) + (hex.slice(-2) === "00" ? "01" : "00");
}

const honest = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [{ op: "bootstrap", committee: c.committee, aggregate: c.aggregate }],
}));
assert.equal(honest.ok, true);
if (!honest.ok) throw new Error(honest.error);
assert.equal(honest.next.ethPubkey, c.aggregate);
assert.equal(honest.next.ethCommittee, c.committee);
assert.equal(committeeAggregate(honest.next.ethCommittee), honest.next.ethPubkey);

const wrong = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [{ op: "bootstrap", committee: c.committee, aggregate: flipHex(c.aggregate) }],
}));
assert.equal(wrong.ok, false);
if (wrong.ok) throw new Error("wrong aggregate entered");
assert.equal(wrong.error, "eth aggregate is not the committee");

const permRaw = new Uint8Array(c.raw);
const first = permRaw.slice(0, 48);
permRaw.set(permRaw.subarray(48, 96), 0);
permRaw.set(first, 48);
const permHex = hexOf(permRaw);
const permAggregate = committeeAggregate(permHex);
assert.equal(permAggregate, c.aggregate);
const permuted = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [{ op: "bootstrap", committee: permHex, aggregate: permAggregate! }],
}));
assert.equal(permuted.ok, true);
if (!permuted.ok) throw new Error(permuted.error);
assert.equal(permuted.next.ethPubkey, honest.next.ethPubkey);
assert.notEqual(permuted.next.ethCommittee, honest.next.ethCommittee);
assert.notEqual(omegaDigest(permuted.next), omegaDigest(honest.next));

const sig342 = hexOf(signSelected(c.secrets, fields, bits342));
const headerOf = (bits: Uint8Array, signature: string): EthEvidence => ({
  op: "header",
  ...fields,
  participation: hexOf(bits),
  signature,
});
const admitted = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [{ op: "bootstrap", committee: c.committee, aggregate: c.aggregate }, headerOf(bits342, sig342)],
}));
assert.equal(admitted.ok, true);
if (!admitted.ok) throw new Error(admitted.error);
assert.equal(admitted.next.eth[0]!.participants, 342);

const short = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [
    { op: "bootstrap", committee: c.committee, aggregate: c.aggregate },
    headerOf(participationMask(341), "11".repeat(96)),
  ],
}));
assert.equal(short.ok, false);
if (short.ok) throw new Error("341 entered");
assert.equal(short.error, "eth quorum not met");

const extra = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [
    { op: "bootstrap", committee: c.committee, aggregate: c.aggregate },
    headerOf(participationMask(343), sig342),
  ],
}));
assert.equal(extra.ok, false);
if (extra.ok) throw new Error("unsigned extra bit entered");
assert.equal(extra.error, "eth signature refused");

const replacedRaw = new Uint8Array(c.raw);
replacedRaw.set(c2.raw.subarray(0, 48), 0);
const replacedHex = hexOf(replacedRaw);
const replacedAgg = committeeAggregate(replacedHex)!;
assert.notEqual(replacedAgg, c.aggregate);
const oldMember = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [
    { op: "bootstrap", committee: replacedHex, aggregate: replacedAgg },
    headerOf(bits342, sig342),
  ],
}));
assert.equal(oldMember.ok, false);
if (oldMember.ok) throw new Error("old member signature entered");
assert.equal(oldMember.error, "eth signature refused");
const replacedSecrets = c.secrets.map((secret) => new Uint8Array(secret));
replacedSecrets[0] = c2.secrets[0]!;
const replacedSig = hexOf(signSelected(replacedSecrets, fields, bits342));
const replaced = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [
    { op: "bootstrap", committee: replacedHex, aggregate: replacedAgg },
    headerOf(bits342, replacedSig),
  ],
}));
assert.equal(replaced.ok, true);
if (!replaced.ok) throw new Error(replaced.error);
assert.equal(replaced.next.ethPubkey, replacedAgg);

const rotSig = hexOf(signRotation(c.secrets, bits342, c2.raw));
const rotated = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [
    { op: "bootstrap", committee: c.committee, aggregate: c.aggregate },
    {
      op: "rotate",
      committee: c2.committee,
      aggregate: c2.aggregate,
      participation: hexOf(bits342),
      signature: rotSig,
    },
  ],
}));
assert.equal(rotated.ok, true);
if (!rotated.ok) throw new Error(rotated.error);
assert.equal(rotated.next.ethCommittee, c2.committee);
assert.equal(rotated.next.ethPubkey, c2.aggregate);

const rotatedWrong = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [
    { op: "bootstrap", committee: c.committee, aggregate: c.aggregate },
    {
      op: "rotate",
      committee: c2.committee,
      aggregate: flipHex(c2.aggregate),
      participation: hexOf(bits342),
      signature: rotSig,
    },
  ],
}));
assert.equal(rotatedWrong.ok, false);
if (rotatedWrong.ok) throw new Error("wrong next aggregate entered");
assert.equal(rotatedWrong.error, "eth aggregate is not the committee");

const bareKey = {
  op: "rotate",
  aggregate: c2.aggregate,
  participation: hexOf(bits342),
  signature: rotSig,
} as EthEvidence;
const bare = applySuccessor(born, inputs({
  ...blankEvidence(born.chainId),
  eth: [{ op: "bootstrap", committee: c.committee, aggregate: c.aggregate }, bareKey],
}));
assert.equal(bare.ok, false);
if (bare.ok) throw new Error("bare aggregate entered");
assert.notEqual(bare.error, "");

const nextFields = {
  slot: 2,
  proposerIndex: 0,
  parentRoot: admitted.next.eth[0]!.hash,
  stateRoot: "44".repeat(32),
  bodyRoot: "55".repeat(32),
};
const carried = applySuccessor(admitted.next, {
  ...inputs({
    ...blankEvidence(born.chainId),
    eth: [{
      op: "header",
      ...nextFields,
      participation: hexOf(bits342),
      signature: hexOf(signSelected(c.secrets, nextFields, bits342)),
    }],
  }),
  timestamp: 1_700_000_015,
  couplings: openedCouplings(admitted.next),
  difficulty: admitted.next.difficulty,
});
assert.equal(carried.ok, true);
if (!carried.ok) throw new Error(carried.error);
assert.equal(carried.next.ethCommittee, c.committee);
assert.equal(carried.next.eth.length, 2);
assert.equal(omegaRecord(carried.next).ethCommittee, c.committee);

const node = new OrganismNode("mainnet", { skipBootstrap: true });
node.ethCommittee = c.committee;
node.ethPubkey = c.aggregate;
const restored = OrganismNode.restore("mainnet", node.toBody());
assert.equal(restored.ethCommittee, c.committee);
assert.equal(restored.ethPubkey, c.aggregate);
assert.equal(committeeAggregate(restored.ethCommittee), restored.ethPubkey);

const body = new CanonicalBody("mainnet");
const committed = await body.commit(inputs({
  ...blankEvidence(born.chainId),
  eth: [{ op: "bootstrap", committee: c.committee, aggregate: c.aggregate }, headerOf(bits342, sig342)],
}));
assert.equal(committed.ok, true);
if (!committed.ok) throw new Error(committed.error);
assert.equal(committed.record.ethCommittee, c.committee);
const replay = new CanonicalBody("mainnet");
const replayed = await replay.replay({
  hash: committed.hash,
  evidence: committed.evidence,
  transactions: [],
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner,
  difficulty: born.difficulty,
  committedPressure: 0,
  omegaRoot: committed.omegaRoot,
  transitionRoot: committed.evidence ? undefined : undefined,
});
assert.equal(replayed, null);
assert.equal(replay.omega.ethCommittee, c.committee);
const follow = await replay.commit({
  transactions: [],
  evidence: {
    v: 1,
    chainId: replay.omega.chainId,
    wasmCode: ARBITRAGE_CODE,
    btc: [],
    eth: [{
      op: "header",
      ...nextFields,
      parentRoot: replay.omega.eth[0]!.hash,
      participation: hexOf(bits342),
      signature: hexOf(signSelected(c.secrets, {
        ...nextFields,
        parentRoot: replay.omega.eth[0]!.hash,
      }, bits342)),
    }],
    wasm: [],
    stake: [],
  },
  timestamp: 1_700_000_015,
  nonce: 6n,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(replay.omega),
  difficulty: replay.omega.difficulty,
});
assert.equal(follow.ok, true, follow.ok ? "" : follow.error);
if (!follow.ok) throw new Error(follow.error);
assert.equal(follow.record.ethCommittee, c.committee);
assert.equal(follow.record.eth.length, 2);

const fp6 = evaluateResidual(
  {
    prevHash: "00".repeat(32),
    merkleRoot: "00".repeat(32),
    timestamp: 1_700_000_000,
    difficulty: 1_000_000,
    nonce: 6n,
  },
  [],
  { cumulativeWork: 1, mempoolPressure: 0 },
).canonicalFp;
assert.equal(fp6, 201_100_202_523_998);

console.log(JSON.stringify({
  ok: true,
  bootstrap: true,
  wrongAggregate: wrong.error,
  permutationDistinct: true,
  sameAggregate: permAggregate === c.aggregate,
  quorum342: true,
  quorum341: short.error,
  extraBit: extra.error,
  replaced: true,
  rotation: true,
  bareKey: bare.error,
  survivedSuccessor: true,
  survivedRestart: restored.ethCommittee.length,
  survivedReplay: follow.record.eth.length,
  nonce6Fp: fp6,
  notMainnetKeys: true,
  android: "not run",
  s7: "4743ee74f910f0f34d94457956aebcc8288a0bde3e531a4a7798f43f223a6a8f",
}));
