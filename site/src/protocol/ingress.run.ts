/**
 * A higher fee does not jump a nonce, and a pool transfer is not an account credit.
 */
import assert from "node:assert/strict";
import { ChainState } from "../../../artifacts/api-server/src/chain/state";
import { applySuccessor, initialOmega } from "./constitution";
import { selectSuccessorTxs } from "./tx-select";
import type { TxRecord } from "./types";
import { keypairFromSeed, signTx } from "./wallet";

function tx(partial: Pick<TxRecord, "hash" | "from" | "to" | "amount" | "fee" | "nonce">): TxRecord {
  return {
    ...partial,
    status: "pending",
    timestamp: 1_700_000_000,
    blockHash: null,
    blockHeight: null,
  };
}

const aliceKey = keypairFromSeed("ingress-alice");
const alice = aliceKey.address;
const bob = "b".repeat(40);
const high = tx({ hash: "b".repeat(64), from: alice, to: bob, amount: 10, fee: 200, nonce: 1 });
const low = tx({ hash: "a".repeat(64), from: alice, to: bob, amount: 10, fee: 100, nonce: 0 });
const picked = selectSuccessorTxs(
  () => 1_000,
  () => 0,
  [high, low],
  10,
);
assert.deepEqual(picked.map((t) => t.nonce), [0, 1]);

const omega = initialOmega("mainnet");
const miner = "c".repeat(40);
omega.ledger.set(alice, { balance: 1_000, nonce: 0 });
const signedHigh = signTx(aliceKey, { to: bob, amount: 10, fee: 200, nonce: 1, chainId: omega.chainId, timestamp: 1_700_000_000 });
const signedLow = signTx(aliceKey, { to: bob, amount: 10, fee: 100, nonce: 0, chainId: omega.chainId, timestamp: 1_700_000_000 });
const jumped = applySuccessor(omega, {
  transactions: [signedHigh, signedLow],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: { ...omega.couplings },
  difficulty: omega.difficulty,
  wasmAfter: null,
});
assert.equal(jumped.ok, false);
if (jumped.ok) throw new Error("nonce jump was accepted");
assert.match(jumped.error, /nonce/);

const ordered = applySuccessor(omega, {
  transactions: [signedLow, signedHigh],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: { ...omega.couplings },
  difficulty: omega.difficulty,
  wasmAfter: null,
});
assert.equal(ordered.ok, true);

const state = new ChainState();
state.currentDifficulty = 1;
state.couplings = { hash: 0, structural: 0, continuity: 0, mempool: 0, fees: 0 };
assert.notEqual(state.currentDifficulty, state.canonicalBody.omega.difficulty);
assert.notDeepEqual(state.couplings, state.canonicalBody.omega.couplings);
const pool = state.canonicalBody.omega.pools[0]!;
state.ledger.credit(alice, 5_000);
state.addBlock({
  hash: "11".repeat(32),
  height: 0,
  prevHash: "0".repeat(64),
  merkleRoot: "0".repeat(64),
  timestamp: 1_700_000_000,
  nonce: 1,
  difficulty: state.currentDifficulty,
  residual: 0,
  recursionDepth: 2,
  coinbaseReward: 0,
  miner: alice,
  txCount: 1,
  transactions: [tx({ hash: "d".repeat(64), from: alice, to: pool.address, amount: 100, fee: 1, nonce: 0 })],
  finalized: false,
});
assert.equal(state.txIndex.get("d".repeat(64))?.status, "failed");
assert.equal(state.ledger.balance(alice), 5_000);
assert.equal(state.ledger.balance(pool.address), 0);
assert.equal(state.canonicalBody.omega.pools[0]!.reserveA, pool.reserveA);

console.log(JSON.stringify({
  ok: true,
  order: picked.map((t) => t.nonce),
  jumped: jumped.ok ? null : jumped.error,
  operationalDifficulty: state.currentDifficulty,
  canonicalDifficulty: state.canonicalBody.omega.difficulty,
}));
