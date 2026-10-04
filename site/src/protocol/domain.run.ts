/**
 * 2^53+1 is a different constitutional integer from 2^53.
 * A JavaScript number is not that integer.
 * The block nonce stays that integer through G, the transition digest, and the header.
 */
import assert from "node:assert/strict";
import { canonicalHeaderHash } from "./crypto";
import { applySuccessor, initialOmega, openedCouplings, transitionDigest } from "./constitution";
import { decodeU64, decodeU64Decimal, encodeU64, participationBytes, popcount } from "./domain";
import { participationMask } from "./eth-light";
import { minerKey } from "./genesis";
import { evaluateResidual } from "./solver";
import { blankEvidence } from "./seal";

const above = (1n << 53n) + 1n;
assert.equal(decodeU64(encodeU64(above)), above);
assert.equal(Number(above), Number(1n << 53n));
assert.throws(() => encodeU64(-1n), /u64 refused/);
assert.throws(() => decodeU64(new Uint8Array(7)), /u64 refused/);
assert.equal(decodeU64Decimal("18446744073709551615"), (1n << 64n) - 1n);
assert.throws(() => decodeU64Decimal("-1"), /u64 refused/);
assert.throws(() => decodeU64Decimal("1.5"), /u64 refused/);
assert.throws(() => decodeU64Decimal("01"), /u64 refused/);
assert.throws(() => decodeU64Decimal("18446744073709551616"), /u64 refused/);

const bits = participationBytes(Buffer.from(participationMask(342)).toString("hex"));
assert.equal(popcount(bits), 342);
assert.equal(popcount(participationBytes(Buffer.from(participationMask(400)).toString("hex"))), 400);
assert.throws(() => participationBytes("ff"), /participation refused/);

console.log(JSON.stringify({
  ok: true,
  above: above.toString(),
  collapsedInNumber: Number(above) === Number(1n << 53n),
  participantsDerived: popcount(bits),
}));

const n1 = 1n << 53n;
const n2 = n1 + 1n;
assert.equal(Number(n1), Number(n2));
const omega = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
function inputs(nonce: bigint) {
  return {
    transactions: [],
    evidence: blankEvidence(omega.chainId),
    timestamp: 1_700_000_000,
    nonce,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}
const a = inputs(n1);
const b = inputs(n2);
assert.notEqual(transitionDigest(omega, a), transitionDigest(omega, b));
const steppedA = applySuccessor(omega, a);
const steppedB = applySuccessor(omega, b);
assert.equal(steppedA.ok, true);
assert.equal(steppedB.ok, true);
if (!steppedA.ok || !steppedB.ok) throw new Error("successor");
const hashA = canonicalHeaderHash({
  prevHash: omega.tipHash,
  merkleRoot: "0".repeat(64),
  stateRoot: steppedA.stateRoot,
  timestamp: a.timestamp,
  nonce: a.nonce,
  difficulty: a.difficulty,
  residualFp: steppedA.residualFp,
  miner,
  height: 0,
  committedPressure: 0,
  chainId: omega.chainId,
  evidenceRoot: "00",
  omegaRoot: steppedA.omegaRoot,
  transitionRoot: transitionDigest(omega, a),
});
const hashB = canonicalHeaderHash({
  prevHash: omega.tipHash,
  merkleRoot: "0".repeat(64),
  stateRoot: steppedB.stateRoot,
  timestamp: b.timestamp,
  nonce: b.nonce,
  difficulty: b.difficulty,
  residualFp: steppedB.residualFp,
  miner,
  height: 0,
  committedPressure: 0,
  chainId: omega.chainId,
  evidenceRoot: "00",
  omegaRoot: steppedB.omegaRoot,
  transitionRoot: transitionDigest(omega, b),
});
assert.notEqual(hashA, hashB);
const header = {
  prevHash: "00".repeat(32),
  merkleRoot: "00".repeat(32),
  timestamp: 1_700_000_000,
  difficulty: 1_000_000,
};
const bytesA = evaluateResidual({ ...header, nonce: n1 }, [], { cumulativeWork: 1, mempoolPressure: 0 }).hashVal;
const bytesB = evaluateResidual({ ...header, nonce: n2 }, [], { cumulativeWork: 1, mempoolPressure: 0 }).hashVal;
assert.notEqual(bytesA, bytesB);
const fp6 = evaluateResidual({ ...header, nonce: 6n }, [], { cumulativeWork: 1, mempoolPressure: 0 }).canonicalFp;
const fp6number = evaluateResidual({ ...header, nonce: 6 }, [], { cumulativeWork: 1, mempoolPressure: 0 }).canonicalFp;
assert.equal(fp6, 201_100_202_523_998);
assert.equal(fp6number, fp6);
const collapsed = applySuccessor(omega, { ...a, nonce: Number(n2) as unknown as bigint });
assert.equal(collapsed.ok, false);
if (collapsed.ok) throw new Error("collapsed nonce entered");
assert.equal(collapsed.error, "nonce is not a u64");
console.log(JSON.stringify({
  nonceDistinct: true,
  transitionDistinct: true,
  headerDistinct: true,
  digestDistinct: true,
  nonce6Fp: fp6,
  numberRefused: collapsed.error,
}));
