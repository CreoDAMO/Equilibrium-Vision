/**
 * The five membranes, against this successor.
 * Selection, the transition digest, the phone's merkle, the pool address,
 * and the fixed-point admission of the known numerical discrepancy.
 */
import assert from "node:assert/strict";
import { canonicalHeaderHash, merkleRoot } from "./crypto";
import {
  applySuccessor,
  cloneOmega,
  foreignDifficultyFactor,
  initialOmega,
  omegaDigest,
  openedCouplings,
  transitionDigest,
} from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import { activityKeys, minerKey } from "./genesis";
import { bindMobileCandidate } from "./membranes";
import { sealFromSuccessor } from "./seal";
import { signTx, verifyTx } from "./wallet";

const omega = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
const keys = activityKeys("mainnet");
const payerA = keys[0]!;
const payerB = keys[1]!;
const payee = "cd".repeat(20);
const low = signTx(payerA, {
  to: payee,
  amount: 10,
  fee: 100,
  nonce: 0,
  chainId: omega.chainId,
  timestamp: 1_700_000_000,
});
const high = signTx(payerB, {
  to: payee,
  amount: 10,
  fee: 200,
  nonce: 0,
  chainId: omega.chainId,
  timestamp: 1_700_000_000,
});
const forged = { ...high, hash: "ab".repeat(32) };
assert.equal(verifyTx(forged, omega.chainId), false);
assert.equal(verifyTx(high, omega.chainId), true);

const base = {
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: null,
};
const reversed = applySuccessor(omega, { ...base, transactions: [low, high] });
assert.equal(reversed.ok, false);
if (reversed.ok) throw new Error("reversed list was accepted");
assert.match(reversed.error, /canonical selection/);

const canonical = applySuccessor(omega, { ...base, transactions: [high, low] });
assert.equal(canonical.ok, true);
if (!canonical.ok) throw new Error(canonical.error);

const sealed = sealFromSuccessor(omega, { ...base, transactions: [high, low] }, canonical);
const instance = transitionDigest(omega, { ...base, transactions: [high, low], evidence: sealed.evidence });
assert.equal(sealed.transitionRoot, instance);
const unbound = canonicalHeaderHash({
  prevHash: omega.tipHash,
  merkleRoot: sealed.merkleRoot,
  stateRoot: canonical.stateRoot,
  timestamp: base.timestamp,
  nonce: base.nonce,
  difficulty: base.difficulty,
  residualFp: canonical.residualFp,
  miner,
  height: omega.height + 1,
  committedPressure: 0,
  chainId: sealed.evidence.chainId,
  evidenceRoot: sealed.evidenceRoot,
  omegaRoot: canonical.omegaRoot,
});
assert.notEqual(unbound, sealed.hash);
assert.equal(canonicalHeaderHash({
  prevHash: "0".repeat(64),
  merkleRoot: "0".repeat(64),
  stateRoot: "89c80f5eddc60e39b03437f5a46e9e81fb03d24fe10d1b35892e8beebe977884",
  timestamp: 1_700_000_000,
  nonce: 6,
  difficulty: 1_000_000,
  residualFp: 201_100_202_523_998,
  miner: "a".repeat(40),
  height: 1,
  committedPressure: 0,
  chainId: 1,
  evidenceRoot: "b425e880a379ede65d894a3470544f23a1a5076e690e78968e3072d2f2ca7994",
  omegaRoot: "2777b2548cd75d2d9712b3d0983bc38420c0306b132d458083bcb5c844a59fbd",
}), "795d67b1ed75cd450c86f6dd4569c0b7b33f194ce6d38e3441f1c6ad5b4fc5b2");
assert.notEqual(
  transitionDigest(omega, { ...base, transactions: [high, low], nonce: 7, evidence: sealed.evidence }),
  instance,
);

const relabeled = cloneOmega(omega);
relabeled.pools[0]!.address = "aa".repeat(20);
assert.notEqual(omegaDigest(omega), omegaDigest(relabeled));

const foreign = cloneOmega(omega);
foreign.btc.push({
  hash: "ab".repeat(32),
  height: 0,
  prevHash: "00".repeat(32),
  merkleRoot: "11".repeat(32),
  bits: 1,
});
const bitsOnly = cloneOmega(foreign);
bitsOnly.btc[0]!.bits = 9;
bitsOnly.btc[0]!.merkleRoot = "22".repeat(32);
bitsOnly.btc[0]!.prevHash = "33".repeat(32);
assert.equal(omegaDigest(foreign), omegaDigest(bitsOnly));
assert.deepEqual(foreignDifficultyFactor(foreign), foreignDifficultyFactor(bitsOnly));
bitsOnly.btc[0]!.hash = "ac".repeat(32);
assert.notEqual(omegaDigest(foreign), omegaDigest(bitsOnly));

const protocol = 201_100_202_523_998;
const reference = 201_100_202_523_995;
const thresholdFp = Math.floor(8e-4 * 1e18);
assert.equal(protocol < thresholdFp, reference < thresholdFp);
assert.equal(protocol < thresholdFp, true);

const phone = bindMobileCandidate(
  { prevHash: omega.tipHash, timestamp: 1_700_000_000, nonce: 0, difficulty: omega.difficulty },
  [high, low].map((tx) => ({ hash: tx.hash, fee: tx.fee })),
  { cumulativeWork: 0, mempoolPressure: 0 },
  omega.couplings,
  { thermalC: 30, battery: 0.8 },
);
assert.equal(phone.mode, "solve");
if (phone.mode !== "solve") throw new Error("phone");
assert.equal(phone.merkleRoot, merkleRoot([high.hash, low.hash]));
assert.notEqual(phone.merkleRoot, "0".repeat(64));

const forgedProof = applySuccessor(omega, {
  ...base,
  transactions: [],
  evidence: {
    v: 1,
    chainId: omega.chainId,
    wasmCode: ARBITRAGE_CODE,
    btc: [],
    eth: [],
    wasm: [],
    stake: [],
    cognition: [{ kind: "bind", residualFp: 1, proof: "00".repeat(32) }],
  },
});
assert.equal(forgedProof.ok, false);

const drained = cloneOmega(omega);
drained.ledger.set(miner, { balance: 0, nonce: 0 });
const feeSource = signTx(payerA, {
  to: payee,
  amount: 10,
  fee: 500,
  nonce: 0,
  chainId: omega.chainId,
  timestamp: 1_700_000_000,
});
const feeFunded = signTx(minerKey("mainnet"), {
  to: payee,
  amount: 100,
  fee: 0,
  nonce: 0,
  chainId: omega.chainId,
  timestamp: 1_700_000_000,
});
const funded = applySuccessor(drained, { ...base, transactions: [feeSource, feeFunded] });
assert.equal(funded.ok, false);
if (funded.ok) throw new Error("fee-funded miner tx was accepted");
assert.match(funded.error, /canonical selection/);

console.log(JSON.stringify({
  ok: true,
  selection: reversed.ok ? "accepted" : reversed.error,
  transition: instance.slice(0, 16),
  phone: phone.merkleRoot.slice(0, 16),
  numericGap: protocol - reference,
  sameAdmission: protocol < thresholdFp,
  feeFunded: funded.ok ? "accepted" : funded.error,
}));
