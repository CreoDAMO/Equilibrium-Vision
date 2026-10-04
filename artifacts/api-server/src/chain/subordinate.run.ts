/**
 * Local writers do not decide Ω. The successor does.
 */
import assert from "node:assert/strict";
import { ChainState } from "./state.js";
import { BTC_GENESIS_HEADER_HEX } from "./btc-header.js";
import { kernelParty } from "./kernel-genesis.js";
import { ARBITRAGE_CODE } from "../../../../site/src/protocol/evidence.js";

const state = new ChainState();
state.currentDifficulty = 1_000_000;
const alice = "a".repeat(40);
const validator = "b".repeat(40);
state.ledger.credit(alice, 10_000);
state.validators.set(validator, {
  address: validator,
  pubkey: "ab",
  moniker: "b",
  commission: 0.1,
  bondedStake: 1_000,
  selfStake: 1_000,
  delegatedStake: 0,
  status: "active",
  jailed: false,
  slashed: false,
  uptime: 1,
  blocksProposed: 0,
  accumulatedRewards: 0,
  registeredAt: 0,
});
assert.match(state.stake(alice, validator, 100, 1) ?? "", /successor/);
assert.equal(state.ledger.balance(alice), 10_000);
assert.equal(state.validators.get(validator)!.bondedStake, 1_000);

const admitted = state.admitBtcHeader(BTC_GENESIS_HEADER_HEX);
assert.ok(admitted);
state.blocks.push({
  hash: "11".repeat(32),
  height: 0,
  prevHash: "0".repeat(64),
  merkleRoot: "0".repeat(64),
  timestamp: 1_700_000_000,
  nonce: 1,
  difficulty: 1_000_000,
  residual: 0,
  recursionDepth: 2,
  coinbaseReward: 0,
  miner: alice,
  txCount: 0,
  transactions: [],
  finalized: false,
} as never);
state.blocks.push({
  hash: "22".repeat(32),
  height: 1,
  prevHash: "11".repeat(32),
  merkleRoot: "0".repeat(64),
  timestamp: 1_700_000_015,
  nonce: 1,
  difficulty: 1_000_000,
  residual: 0,
  recursionDepth: 2,
  coinbaseReward: 0,
  miner: alice,
  txCount: 0,
  transactions: [],
  finalized: false,
} as never);
state.updateDifficulty();
assert.equal(state.currentDifficulty, 1_000_000);
assert.equal(state.ledger.balance(alice), 10_000);

const before = state.canonicalBody.omega.difficulty;
const committed = await state.canonicalBody.commit({
  transactions: [],
  evidence: {
    v: 1,
    chainId: state.canonicalBody.omega.chainId,
    wasmCode: ARBITRAGE_CODE,
    btc: [{ headerHex: BTC_GENESIS_HEADER_HEX, height: 0 }],
    eth: [],
    wasm: [],
    stake: [],
  },
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: kernelParty("mainnet").miner,
  committedPressure: 0,
  couplings: { ...state.canonicalBody.omega.couplings },
  difficulty: before,
});
assert.equal(committed.ok, true);
if (!committed.ok) throw new Error(committed.error);
assert.notEqual(committed.record.difficulty, before);
state.alignEmbodiment();
assert.equal(state.currentDifficulty, committed.record.difficulty);
assert.equal(state.ledger.balance(kernelParty("mainnet").miner), committed.record.ledger.find((row) => row.address === kernelParty("mainnet").miner)?.balance);

state.dexPools.set("EQU-USDC", {
  id: "EQU-USDC",
  tokenA: "EQU",
  tokenB: "USDC",
  reserveA: 1_000_000,
  reserveB: 1_000_000,
  totalLiquidity: 1,
  fee: 0.003,
  volumeA: 0,
  volumeB: 0,
  txCount: 0,
  createdAt: 0,
});
const aliceHeld = state.ledger.balance(alice);
assert.equal(state.swap("EQU-USDC", alice, "EQU", 100), "a pool moves only inside the successor");
assert.equal(state.ledger.balance(alice), aliceHeld);
assert.equal(state.dexPools.get("EQU-USDC")!.reserveA, 1_000_000);

const wasm = await state.executeKernelWasm("init", alice);
assert.equal(wasm.ok, true);
assert.equal(state.canonicalWasm.size, 0);
assert.ok(wasm.storage.size > 0);

console.log(JSON.stringify({
  ok: true,
  localDifficulty: state.currentDifficulty,
  canonicalDifficulty: committed.record.difficulty,
  localTip: admitted,
  wasmStored: state.canonicalWasm.size,
  wasmReturned: wasm.storage.size,
}));
