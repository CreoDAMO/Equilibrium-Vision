/**
 * Admission, rollback, a failed reorg, and a snapshot all keep one Ω.
 * A refused successor changes neither body.
 */
import assert from "node:assert/strict";
import { ChainState } from "../../../artifacts/api-server/src/chain/state";
import type { BlockRecord } from "../../../artifacts/api-server/src/chain/types";
import { kernelParty } from "../../../artifacts/api-server/src/chain/kernel-genesis";
import { applySuccessor, omegaDigest, openedCouplings } from "./constitution";
import { sealFromSuccessor } from "./seal";

function block(partial: Partial<BlockRecord> & Pick<BlockRecord, "hash" | "height" | "prevHash" | "miner">): BlockRecord {
  return {
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce: 6,
    difficulty: 1_000_000,
    residual: 1e-6,
    residualFp: 1,
    recursionDepth: 2,
    coinbaseReward: 0,
    txCount: 0,
    transactions: [],
    committedPressure: 0,
    ...partial,
  };
}

const state = new ChainState();
const omega = state.canonicalBody.omega;
const before = omegaDigest(omega);
const miner = kernelParty("mainnet").miner;
assert.throws(
  () => state.addBlock(block({
    hash: "ab".repeat(32),
    height: 0,
    prevHash: omega.tipHash,
    miner: "cd".repeat(20),
    difficulty: omega.difficulty,
  })),
  /live validator/,
);
assert.equal(state.blocks.length, 0);
assert.equal(omegaDigest(state.canonicalBody.omega), before);

const inputs = {
  transactions: [],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: null,
};
const stepped = applySuccessor(omega, inputs);
assert.equal(stepped.ok, true);
if (!stepped.ok) throw new Error("successor");
const sealed = sealFromSuccessor(omega, inputs, stepped);
const minerBefore = state.ledger.balance(miner);
state.addBlock(block({
  hash: "11".repeat(32),
  height: 0,
  prevHash: omega.tipHash,
  miner,
  difficulty: omega.difficulty,
  timestamp: 1_700_000_000,
}));
assert.equal(omegaDigest(state.canonicalBody.omega), omegaDigest(sealed.carried));
assert.equal(state.ledger.balance(miner), sealed.carried.ledger.get(miner)?.balance);
assert.equal(state.currentDifficulty, sealed.carried.difficulty);
assert.equal(state.finalizedHeight, sealed.carried.finalizedHeight);
assert.deepEqual(state.couplings, sealed.carried.couplings);
const embodied = omegaDigest(state.canonicalBody.omega);

state.rollbackToHeight(-1);
assert.equal(state.blocks.length, 0);
assert.equal(omegaDigest(state.canonicalBody.omega), before);
assert.equal(state.ledger.balance(miner), minerBefore);

const anchor = block({
  hash: omega.tipHash,
  height: 0,
  prevHash: "1".repeat(64),
  miner: "aa".repeat(20),
  residualFp: 50,
});
const tail = block({
  hash: "22".repeat(32),
  height: 1,
  prevHash: "1".repeat(64),
  miner: "aa".repeat(20),
  residualFp: 50,
  timestamp: 1_700_000_015,
});
state.addBlock(anchor);
state.addBlock(tail);
const parked = omegaDigest(state.canonicalBody.omega);
const refused = state.reorganize([
  block({
    hash: "33".repeat(32),
    height: 1,
    prevHash: anchor.hash,
    miner: "cd".repeat(20),
    difficulty: omega.difficulty,
    residualFp: 1,
    timestamp: 1_700_000_015,
  }),
]);
assert.equal(refused.switched, false);
assert.equal(state.blocks.length, 2);
assert.equal(state.blocks[1]?.hash, tail.hash);
assert.equal(omegaDigest(state.canonicalBody.omega), parked);

state.addBlock(block({
  hash: "44".repeat(32),
  height: 0,
  prevHash: state.canonicalBody.omega.tipHash,
  miner,
  difficulty: state.canonicalBody.omega.difficulty,
  timestamp: 1_700_000_030,
}));
const snap = state.exportRestartSnapshot();
const restarted = new ChainState();
restarted.importRestartSnapshot(snap);
assert.equal(omegaDigest(restarted.canonicalBody.omega), omegaDigest(state.canonicalBody.omega));
assert.equal(restarted.ledger.balance(miner), state.ledger.balance(miner));
assert.equal(restarted.currentDifficulty, state.currentDifficulty);

console.log(JSON.stringify({
  ok: true,
  embodied,
  rolledBack: true,
  reorgStayed: refused.reason,
  restarted: restarted.canonicalBody.omega.height,
}));
