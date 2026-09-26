/**
 * What the state root binds, and what it does not.
 * A validator-only change moves the omega digest and not the state root.
 * A balance change moves both. The header hash is the same function the
 * artifacts node seals. The residual grid is the same one Rust admits.
 * Issuance creates no more than the declared reward.
 */
import assert from "node:assert/strict";
import { canonicalHeaderHash } from "./crypto";
import { applySuccessor, cloneOmega, initialOmega, omegaDigest, stateRootOf } from "./constitution";
import { evaluateResidual } from "./solver";

const born = initialOmega("testnet");
const root = stateRootOf(born);
const omega = omegaDigest(born);

const stakeOnly = cloneOmega(born);
const validator = stakeOnly.validators.values().next().value;
assert.ok(validator, "genesis has a validator");
validator.bondedStake += 1;
assert.equal(stateRootOf(stakeOnly), root, "a validator-only change moved the state root");
assert.notEqual(omegaDigest(stakeOnly), omega, "a validator-only change did not move the omega digest");

const paid = cloneOmega(born);
const addr = paid.ledger.keys().next().value;
assert.ok(addr, "genesis has an account");
const acc = paid.ledger.get(addr)!;
paid.ledger.set(addr, { balance: acc.balance + 1, nonce: acc.nonce });
assert.notEqual(stateRootOf(paid), root, "a balance change did not move the state root");
assert.notEqual(omegaDigest(paid), omega, "a balance change did not move the omega digest");

const header = canonicalHeaderHash({
  prevHash: "11".repeat(32),
  merkleRoot: "22".repeat(32),
  stateRoot: "33".repeat(32),
  timestamp: 1_700_000_000,
  nonce: 7,
  difficulty: 1_000_000,
  residualFp: 201_100_202_523_998,
  miner: "ab".repeat(20),
  height: 3,
  committedPressure: 0,
});
assert.equal(header, "836ce07ec08403bf07acc120a50163b48c5910b4bfa7c1de1c08200f1f09f306");
const nudged = canonicalHeaderHash({
  prevHash: "11".repeat(32),
  merkleRoot: "22".repeat(32),
  stateRoot: "33".repeat(32),
  timestamp: 1_700_000_000,
  nonce: 8,
  difficulty: 1_000_000,
  residualFp: 201_100_202_523_998,
  miner: "ab".repeat(20),
  height: 3,
  committedPressure: 0,
});
assert.notEqual(nudged, header);

const grid: Array<[string, number, number, number, number, number, { hash: string; fee: number }[], number]> = [
  ["nonce0", 1_700_000_000, 0, 1_000_000, 1, 0, [], 0.02519000125198503],
  ["nonce1", 1_700_000_000, 1, 1_000_000, 1, 0, [], 0.09076955982638274],
  ["nonce1-100k", 1_700_000_000, 1, 100_000, 1, 0, [], 0.086836478057786756],
  ["nonce6", 1_700_000_000, 6, 1_000_000, 1, 0, [], 0.0002011002025239986],
  ["nonce7", 1_700_000_000, 7, 1_000_000, 1, 0, [], 0.043329506709598564],
  ["work0", 1_700_000_000, 6, 1_000_000, 0, 0, [], 1.000201100202524],
  ["pressure", 1_700_000_000, 6, 1_000_000, 1, 1, [], 2.0002011002025242],
  ["ts0", 0, 6, 1_000_000, 1, 0, [], 0.16225219837223626],
  ["nonceHi", 1_700_000_000, 9007199254740991, 1_000_000, 1, 0, [], 0.098695867101580084],
  ["tx", 1_700_000_000, 6, 1_000_000, 1, 0.5, [{ hash: "ab".repeat(32), fee: 1000 }], 0.5191116242016731],
];
for (const [name, timestamp, nonce, difficulty, work, pressure, txs, expected] of grid) {
  const got = evaluateResidual(
    { prevHash: "00".repeat(32), merkleRoot: "00".repeat(32), timestamp, nonce, difficulty },
    txs,
    { cumulativeWork: work, mempoolPressure: pressure },
  ).canonical;
  assert.ok(Math.abs(got - expected) < 1e-12, `${name}: kernel ${got} expected ${expected}`);
}

const miner = [...born.validators.keys()][0];
assert.ok(miner, "genesis has a miner");
const issuing = cloneOmega(born);
issuing.tipHash = "00".repeat(32);
issuing.difficulty = 1_000_000;
issuing.height = 0;
issuing.tipTimestamp = 1_699_999_999;
const beforeLedger = [...issuing.ledger.values()].reduce((s, a) => s + a.balance, 0);
const beforeRewards = [...issuing.validators.values()].reduce((s, v) => s + v.accumulatedRewards, 0);
const step = applySuccessor(issuing, {
  transactions: [],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: { ...issuing.couplings },
  difficulty: issuing.difficulty,
  wasmAfter: null,
});
assert.equal(step.ok, true);
if (!step.ok) throw new Error("successor refused");
const ledgerDelta = [...step.next.ledger.values()].reduce((s, a) => s + a.balance, 0) - beforeLedger;
const rewardDelta = [...step.next.validators.values()].reduce((s, v) => s + v.accumulatedRewards, 0) - beforeRewards;
const created = ledgerDelta + rewardDelta;
assert.equal(ledgerDelta, step.liquid);
assert.ok(created <= step.reward, `created ${created} above reward ${step.reward}`);
assert.ok(step.reward - created < step.next.validators.size, `dust ${step.reward - created} is not floor dust`);

console.log(JSON.stringify({
  ok: true,
  stateRootUnchangedByValidator: true,
  omegaChangedByValidator: true,
  balanceMovesBoth: true,
  header,
  nonceChangesHeader: true,
  grid: grid.length,
  reward: step.reward,
  liquid: step.liquid,
  staked: rewardDelta,
  created,
  dust: step.reward - created,
}));
