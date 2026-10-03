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
import { ARBITRAGE_CODE } from "./evidence";
import { BTC_GENESIS_HEADER_HEX } from "./btc";
import { GENESIS_VALIDATORS } from "./genesis";

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
assert.equal(state.blocks[0]?.hash, sealed.carried.tipHash);
assert.equal(state.ledger.balance(miner), sealed.carried.ledger.get(miner)?.balance);
assert.equal(state.currentDifficulty, sealed.carried.difficulty);
assert.equal(state.finalizedHeight, sealed.carried.finalizedHeight);
assert.deepEqual(state.couplings, sealed.carried.couplings);
assert.equal(state.dexPools.get("EQU-USDC")?.reserveA, sealed.carried.pools.find((p) => p.id === "EQU-USDC")?.reserveA);
assert.equal(state.canonicalProposals.length, sealed.carried.proposals.length);
assert.equal(state.canonicalBtc.length, sealed.carried.btc.length);
const embodied = omegaDigest(state.canonicalBody.omega);

state.rollbackToHeight(-1);
assert.equal(state.blocks.length, 0);
assert.equal(omegaDigest(state.canonicalBody.omega), before);
assert.equal(state.ledger.balance(miner), minerBefore);
assert.equal(state.dexPools.size, 0);

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

const continuedAt = 1_700_000_045;
const liveNext = block({
  hash: "66".repeat(32),
  height: state.canonicalBody.omega.height + 1,
  prevHash: state.canonicalBody.omega.tipHash,
  miner,
  difficulty: state.canonicalBody.omega.difficulty,
  timestamp: continuedAt,
  nonce: 6,
});
const restartNext = block({
  ...liveNext,
  prevHash: restarted.canonicalBody.omega.tipHash,
  difficulty: restarted.canonicalBody.omega.difficulty,
});
state.addBlock(liveNext);
restarted.addBlock(restartNext);
assert.equal(omegaDigest(restarted.canonicalBody.omega), omegaDigest(state.canonicalBody.omega));
assert.equal(restarted.ledger.balance(miner), state.ledger.balance(miner));
assert.equal(restarted.currentDifficulty, state.currentDifficulty);
assert.equal(restarted.blocks.at(-1)?.hash, state.blocks.at(-1)?.hash);

const gov = new ChainState();
const voters = GENESIS_VALIDATORS.slice(0, 3).map((v) => v.address);
gov.addBlock(block({
  hash: "77".repeat(32),
  height: 0,
  prevHash: gov.canonicalBody.omega.tipHash,
  miner,
  difficulty: gov.canonicalBody.omega.difficulty,
  timestamp: 1_700_000_000,
  evidence: {
    v: 1,
    chainId: gov.canonicalBody.omega.chainId,
    wasmCode: ARBITRAGE_CODE,
    btc: [{ headerHex: BTC_GENESIS_HEADER_HEX, height: 0 }],
    eth: [],
    wasm: [],
    stake: [
      { op: "propose", proposer: miner, title: "drop structural", deposit: 0, id: 7, couplingKey: "structural", couplingValue: 0 },
      ...voters.map((voter) => ({ op: "vote" as const, voter, id: 7, option: "yes" as const })),
    ],
  },
}));
assert.equal(gov.canonicalProposals[0]?.status, "passed");
assert.equal(gov.couplings.structural, 1);
assert.equal(gov.canonicalBtc.length, 1);
assert.equal(gov.dexPools.get("EQU-WBTC")?.reserveB, gov.canonicalBody.omega.pools.find((p) => p.id === "EQU-WBTC")?.reserveB);
gov.addBlock(block({
  hash: "88".repeat(32),
  height: 1,
  prevHash: gov.canonicalBody.omega.tipHash,
  miner,
  difficulty: gov.canonicalBody.omega.difficulty,
  timestamp: 1_700_000_015,
}));
assert.equal(gov.couplings.structural, 0);
assert.equal(gov.canonicalBody.omega.couplings.structural, 0);
assert.equal(gov.canonicalProposals.find((p) => p.id === 7)?.status, "executed");
gov.kernelProposals.push({ id: "k", status: "passed", couplingKey: "structural", couplingValue: 1 });
gov.addBlock(block({
  hash: "99".repeat(32),
  height: 2,
  prevHash: "1".repeat(64),
  miner: "aa".repeat(20),
  timestamp: 1_700_000_030,
  residualFp: 9,
}));
assert.equal(gov.kernelProposals[0]?.status, "passed");
assert.equal(gov.couplings.structural, 0);

const fork = new ChainState();
fork.addBlock(block({
  hash: "a1".repeat(32),
  height: 0,
  prevHash: fork.canonicalBody.omega.tipHash,
  miner,
  difficulty: fork.canonicalBody.omega.difficulty,
  timestamp: 1_700_000_000,
}));
const ancestor = fork.blocks[0]!.hash;
const forkDiff = fork.canonicalBody.omega.difficulty;
const forkTs = 1_700_000_020;
const ranked: Array<{ nonce: number; fp: number }> = [];
for (let nonce = 0; nonce < 40; nonce++) {
  const stepped = applySuccessor(fork.canonicalBody.omega, {
    transactions: [],
    evidence: undefined,
    timestamp: forkTs,
    nonce,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(fork.canonicalBody.omega),
    difficulty: forkDiff,
    wasmAfter: null,
  });
  if (stepped.ok) ranked.push({ nonce, fp: stepped.residualFp });
}
ranked.sort((a, b) => (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0));
const low = ranked[0];
const high = ranked[ranked.length - 1];
if (!low || !high || low.fp >= high.fp) throw new Error("no residual fork");
fork.addBlock(block({
  hash: "b2".repeat(32),
  height: 1,
  prevHash: ancestor,
  miner,
  difficulty: forkDiff,
  timestamp: forkTs,
  nonce: high.nonce,
  residualFp: high.fp,
}));
const switched = fork.reorganize([
  block({
    hash: "c3".repeat(32),
    height: 1,
    prevHash: ancestor,
    miner,
    difficulty: forkDiff,
    timestamp: forkTs,
    nonce: low.nonce,
    residualFp: low.fp,
  }),
]);
assert.equal(switched.switched, true, switched.reason);
assert.equal(fork.blocks.length, 2);
assert.equal(fork.blocks[1]?.hash, fork.canonicalBody.omega.tipHash);
assert.equal(fork.currentDifficulty, fork.canonicalBody.omega.difficulty);
assert.equal(fork.ledger.balance(miner), fork.canonicalBody.omega.ledger.get(miner)?.balance);
assert.equal(fork.couplings.structural, fork.canonicalBody.omega.couplings.structural);

console.log(JSON.stringify({
  ok: true,
  embodied,
  rolledBack: true,
  reorgStayed: refused.reason,
  restarted: restarted.canonicalBody.omega.height,
  continued: state.canonicalBody.omega.height,
  coupling: gov.couplings.structural,
  switched: switched.switched,
}));
