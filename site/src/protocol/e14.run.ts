/**
 * E14. Same canonical inputs through applySuccessor and through addBlock.
 * Canonical Ω moves only when addBlock installs that successor.
 */
import assert from "node:assert/strict";
import { ChainState } from "../../../artifacts/api-server/src/chain/state";
import type { BlockRecord, TxRecord as OpTx } from "../../../artifacts/api-server/src/chain/types";
import { applySuccessor, omegaDigest, openedCouplings, type Omega } from "./constitution";
import { activityKeys } from "./genesis";
import { sealFromSuccessor } from "./seal";
import { signTx } from "./wallet";
import type { TxRecord } from "./types";

function liveMiner(omega: Omega): string {
  const miner = [...omega.validators.values()].find((v) => !v.jailed && !v.slashed && v.bondedStake > 0);
  if (!miner) throw new Error("no live validator");
  return miner.address;
}

function asOp(tx: TxRecord): OpTx {
  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    nonce: tx.nonce,
    blockHash: null,
    blockHeight: null,
    timestamp: tx.timestamp,
    status: "pending",
    signature: tx.signature,
    publicKey: tx.publicKey,
  };
}

function ordinary(omega: Omega, miner: string, nonce: number, pressure: number, txs: TxRecord[]): BlockRecord {
  return {
    hash: "11".repeat(32),
    height: Math.max(0, omega.height + 1),
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce,
    difficulty: omega.difficulty,
    residual: 1e-6,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner,
    txCount: txs.length,
    transactions: txs.map(asOp),
    committedPressure: pressure,
  };
}

function arm(pressure: number, txs: TxRecord[], miner?: string) {
  const state = new ChainState();
  const omega = state.canonicalBody.omega;
  const who = miner ?? liveMiner(omega);
  const inputs = {
    transactions: txs,
    evidence: undefined,
    timestamp: 1_700_000_000,
    nonce: 6n,
    miner: who,
    committedPressure: pressure,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
  const stepped = applySuccessor(omega, inputs);
  assert.equal(stepped.ok, true, stepped.ok ? "" : stepped.error);
  if (!stepped.ok) throw new Error("successor");
  const sealed = sealFromSuccessor(omega, inputs, stepped);
  const before = omegaDigest(omega);
  state.addBlock(ordinary(omega, who, 6, pressure, txs));
  return { state, sealed, before, stepped };
}

const empty = arm(0, []);
assert.equal(omegaDigest(empty.state.canonicalBody.omega), omegaDigest(empty.sealed.carried));
assert.equal(empty.state.canonicalBody.omega.tipHash, empty.sealed.carried.tipHash);
assert.equal(empty.state.canonicalBody.omega.height, empty.sealed.carried.height);
assert.equal(empty.state.canonicalBody.omega.difficulty, empty.sealed.carried.difficulty);
assert.equal(empty.state.canonicalBody.omega.finalizedHeight, empty.sealed.carried.finalizedHeight);
assert.notEqual(omegaDigest(empty.state.canonicalBody.omega), empty.before);

const payer = activityKeys("mainnet")[0]!;
const signed = signTx(payer, {
  to: "cd".repeat(20),
  amount: 1_000,
  fee: 10,
  nonce: 0,
  chainId: 1,
  timestamp: 1_700_000_000,
});
const paid = arm(0, [signed]);
assert.equal(omegaDigest(paid.state.canonicalBody.omega), omegaDigest(paid.sealed.carried));
assert.equal(
  paid.state.canonicalBody.omega.ledger.get("cd".repeat(20))?.balance,
  paid.sealed.carried.ledger.get("cd".repeat(20))?.balance,
);

const pressured = arm(0.25, []);
assert.equal(omegaDigest(pressured.state.canonicalBody.omega), omegaDigest(pressured.sealed.carried));
assert.notEqual(pressured.stepped.residualFp, empty.stepped.residualFp);

const strangerState = new ChainState();
const strangerOmega = strangerState.canonicalBody.omega;
const strangerBefore = omegaDigest(strangerOmega);
const refused = applySuccessor(strangerOmega, {
  transactions: [],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: "ab".repeat(20),
  committedPressure: 0,
  couplings: openedCouplings(strangerOmega),
  difficulty: strangerOmega.difficulty,
  wasmAfter: null,
});
assert.equal(refused.ok, false);
assert.throws(() => strangerState.addBlock(ordinary(strangerOmega, "ab".repeat(20), 6, 0, [])), /live validator/);
assert.equal(strangerState.blocks.length, 0);
assert.equal(omegaDigest(strangerState.canonicalBody.omega), strangerBefore);

console.log(JSON.stringify({
  ok: true,
  e14_0: empty.state.canonicalBody.omega.height,
  e14_1: paid.state.canonicalBody.omega.ledger.get("cd".repeat(20))?.balance,
  e14_2: [empty.stepped.residualFp, pressured.stepped.residualFp],
  e14_3: "stranger did not move Ω",
}));
