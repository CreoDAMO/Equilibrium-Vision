/**
 * Who is allowed to decide the next canonical value.
 * A local store may change. It may not move Ω unless the transition says so.
 */
import assert from "node:assert/strict";
import { btcHeaderHash, BTC_GENESIS_HEADER_HEX as artifactsGenesis } from "../../../artifacts/api-server/src/chain/btc-header";
import { nextFinalizedHeight, stakeForFinality } from "../../../artifacts/api-server/src/chain/finality";
import { kernelParty } from "../../../artifacts/api-server/src/chain/kernel-genesis";
import { wasmLeafOf as artifactsWasmLeaf } from "../../../artifacts/api-server/src/chain/wasm-leaf";
import { BTC_GENESIS_HEADER_HEX, decodeHeaderHex, parseBtcHeader, verifyBtcPow } from "./btc";
import { applySuccessor, cloneOmega, openedCouplings, stateRootOf, wasmLeafOf } from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import { activityKeys, minerKey, treasuryKey } from "./genesis";
import { NETWORKS } from "./networks";
import type { Omega, TransitionEvidence, ValidatorRecord } from "./types";

const raw = decodeHeaderHex(BTC_GENESIS_HEADER_HEX);
assert.ok(raw, "genesis header decodes");
assert.equal(verifyBtcPow(raw), true);
const kernelHash = parseBtcHeader(raw).hash;
assert.equal(artifactsGenesis, BTC_GENESIS_HEADER_HEX);
assert.equal(btcHeaderHash(BTC_GENESIS_HEADER_HEX), kernelHash);
assert.equal(btcHeaderHash("00".repeat(80)), null);
assert.equal(kernelHash, "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000");

for (const network of ["mainnet", "testnet"] as const) {
  const party = kernelParty(network);
  assert.equal(party.treasury, treasuryKey(network).address);
  assert.equal(party.miner, minerKey(network).address);
  assert.deepEqual(party.activity, activityKeys(network).map((key) => key.address));
}
const wasmSample = new Map([["b", "2"], ["a", "1"]]);
assert.equal(artifactsWasmLeaf(wasmSample.entries()), wasmLeafOf(wasmSample));
assert.equal(artifactsWasmLeaf([]), "none");
assert.equal(wasmLeafOf(wasmSample), "a=1|b=2");

function validator(address: string): ValidatorRecord {
  return {
    address,
    moniker: address.slice(0, 4),
    bondedStake: 1_000,
    accumulatedRewards: 0,
    slashed: false,
    jailed: false,
    uptime: 1,
    blocksProposed: 0,
    commission: 0.1,
  };
}

function omega(height: number): Omega {
  const names = ["a", "b", "c"].map((ch) => ch.repeat(40));
  return {
    chainId: NETWORKS.mainnet.chainId,
    height,
    tipHash: "0".repeat(64),
    tipTimestamp: height < 0 ? 0 : 1_700_000_000 - 15,
    difficulty: 1_000_000,
    couplings: { hash: 1, structural: 1, continuity: 1, mempool: 1, fees: 1 },
    ledger: new Map(),
    pools: [],
    btc: [],
    ethPubkey: "",
    eth: [],
    wasm: new Map(),
    validators: new Map(names.map((address) => [address, validator(address)])),
    delegations: [],
    proposals: [],
    finalizedHeight: -1,
  };
}

const evidence: TransitionEvidence = {
  v: 1,
  chainId: NETWORKS.mainnet.chainId,
  wasmCode: ARBITRAGE_CODE,
  btc: [],
  eth: [],
  wasm: [],
  stake: [],
};

function step(current: Omega, wasmAfter: Map<string, string> | null, ev: TransitionEvidence = evidence) {
  return applySuccessor(current, {
    transactions: [],
    evidence: ev,
    timestamp: 1_700_000_000,
    nonce: 6,
    miner: "a".repeat(40),
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
    wasmAfter,
  });
}

const blank = omega(0);
const cached = step(cloneOmega(blank), new Map([["cell", "local"]]));
const empty = step(cloneOmega(blank), null);
assert.equal(cached.ok, true);
assert.equal(empty.ok, true);
if (!cached.ok || !empty.ok) throw new Error("unreachable");
assert.equal(cached.next.wasm.size, 0);
assert.equal(cached.omegaRoot, empty.omegaRoot);
assert.equal(cached.next.finalizedHeight, -1);

const called: TransitionEvidence = {
  ...evidence,
  wasm: [{ method: "pause", caller: "a".repeat(40) }],
};
const executed = step(cloneOmega(blank), new Map([["cell", "from-call"]]), called);
assert.equal(executed.ok, true);
if (!executed.ok) throw new Error("unreachable");
assert.equal(executed.next.wasm.get("cell"), "from-call");
assert.notEqual(stateRootOf(executed.next), stateRootOf(empty.next));
assert.notEqual(executed.omegaRoot, empty.omegaRoot);

const quiet = step(cloneOmega(blank), null);
const governed = cloneOmega(blank);
governed.proposals.push({
  id: 1,
  title: "drop structural coupling",
  proposer: "a".repeat(40),
  deposit: 0,
  yes: 1,
  no: 0,
  abstain: 0,
  status: "passed",
  couplingKey: "structural",
  couplingValue: 0,
});
const moved = step(governed, null);
assert.equal(quiet.ok && moved.ok, true);
if (!quiet.ok || !moved.ok) throw new Error("unreachable");
assert.notEqual(moved.residual, quiet.residual);
assert.notEqual(moved.omegaRoot, quiet.omegaRoot);
assert.equal(moved.next.couplings.structural, 0);
assert.equal(quiet.next.couplings.structural, 1);

function follow(current: Omega) {
  return applySuccessor(current, {
    transactions: [],
    evidence,
    timestamp: current.tipTimestamp + 15,
    nonce: 6,
    miner: "a".repeat(40),
    committedPressure: 0,
    couplings: { ...current.couplings },
    difficulty: current.difficulty,
    wasmAfter: null,
  });
}
const followedQuiet = follow(quiet.next);
const followedMoved = follow(moved.next);
assert.equal(followedQuiet.ok && followedMoved.ok, true);
if (!followedQuiet.ok || !followedMoved.ok) throw new Error("unreachable");
assert.notEqual(followedMoved.residual, followedQuiet.residual);
assert.notEqual(followedMoved.reward, followedQuiet.reward);

let cursor = omega(-1);
const finals: number[] = [];
for (let i = 0; i < 3; i++) {
  const next = applySuccessor(cursor, {
    transactions: [],
    evidence,
    timestamp: 1_700_000_000 + i * 15,
    nonce: 6,
    miner: "a".repeat(40),
    committedPressure: 0,
    couplings: { ...cursor.couplings },
    difficulty: cursor.difficulty,
    wasmAfter: null,
  });
  assert.equal(next.ok, true);
  if (!next.ok) throw new Error("unreachable");
  const stake = stakeForFinality(next.next.validators.values());
  assert.equal(
    next.next.finalizedHeight,
    nextFinalizedHeight(next.next.height, cursor.finalizedHeight, stake.liveStake, stake.totalStake),
  );
  finals.push(next.next.finalizedHeight);
  cursor = next.next;
}
assert.deepEqual(finals, [-1, -1, 0]);
assert.equal(cursor.height, 2);

const atTwo = omega(2);
const third = applySuccessor(atTwo, {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner: "a".repeat(40),
  committedPressure: 0,
  couplings: { ...atTwo.couplings },
  difficulty: atTwo.difficulty,
  wasmAfter: null,
});
assert.equal(third.ok, true);
if (!third.ok) throw new Error("unreachable");
assert.equal(third.next.height, 3);
assert.equal(third.next.finalizedHeight, 1);
assert.equal(nextFinalizedHeight(3, -1, 3_000, 3_000), 1);

const oneJailed = omega(2);
oneJailed.validators.get("c".repeat(40))!.jailed = true;
const twoThirds = applySuccessor(oneJailed, {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner: "a".repeat(40),
  committedPressure: 0,
  couplings: { ...oneJailed.couplings },
  difficulty: oneJailed.difficulty,
  wasmAfter: null,
});
assert.equal(twoThirds.ok, true);
if (!twoThirds.ok) throw new Error("unreachable");
assert.equal(twoThirds.next.finalizedHeight, 1);
assert.equal(nextFinalizedHeight(3, -1, 2_000, 3_000), 1);

const twoJailed = omega(2);
twoJailed.validators.get("b".repeat(40))!.jailed = true;
twoJailed.validators.get("c".repeat(40))!.slashed = true;
const short = applySuccessor(twoJailed, {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner: "a".repeat(40),
  committedPressure: 0,
  couplings: { ...twoJailed.couplings },
  difficulty: twoJailed.difficulty,
  wasmAfter: null,
});
assert.equal(short.ok, true);
if (!short.ok) throw new Error("unreachable");
assert.equal(short.next.finalizedHeight, -1);
assert.equal(nextFinalizedHeight(3, -1, 1_000, 3_000), -1);

console.log(JSON.stringify({
  ok: true,
  btcTip: kernelHash,
  bareHeaderRefused: true,
  partyTreasury: kernelParty("mainnet").treasury,
  partyMiner: kernelParty("mainnet").miner,
  wasmLeaf: wasmLeafOf(wasmSample),
  wasmCacheIgnored: true,
  wasmCallChangesState: true,
  couplingResidual: followedMoved.residual,
  quietResidual: followedQuiet.residual,
  couplingReward: followedMoved.reward,
  quietReward: followedQuiet.reward,
  sameBlockResidual: quiet.residual,
  finals,
  finalizedAtHeight3: third.next.finalizedHeight,
  twoThirdsFinalized: twoThirds.next.finalizedHeight,
  shortStakeFinalized: short.next.finalizedHeight,
}));
