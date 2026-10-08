/**
 * One evidence-bearing transition, checked in both bodies.
 * The kernel computes Ω and the 13-field header.
 * The artifacts hash function and the artifacts difficulty law must return the same values.
 * This does not make the UTXO set part of Ω.
 */
import assert from "node:assert/strict";
import { canonicalHeaderHash as artifactsHeaderHash } from "../../../artifacts/api-server/src/chain/crypto";
import { adjustDifficultySeconds, foreignTipFactor } from "../../../artifacts/api-server/src/chain/difficulty";
import { applySuccessor, adjustDifficulty, cloneOmega, foreignDifficultyFactor } from "./constitution";
import { canonicalHeaderHash } from "./crypto";
import { ARBITRAGE_CODE, evidenceRoot } from "./evidence";
import { NETWORKS } from "./networks";
import type { BtcHeaderRecord, Omega, TransitionEvidence, ValidatorRecord } from "./types";

const tip = "0".repeat(64);
const hot = `${"0".repeat(62)}ff`;

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

function omega(): Omega {
  const miner = "a".repeat(40);
  const other = "b".repeat(40);
  return {
    chainId: NETWORKS.mainnet.chainId,
    height: 0,
    tipHash: tip,
    tipTimestamp: 1_700_000_000 - 15,
    difficulty: 1_000_000,
    couplings: { hash: 1, structural: 1, continuity: 1, mempool: 1, fees: 1 },
    ledger: new Map(),
    pools: [],
    btc: [],
    ethPubkey: "",
    ethCommittee: "",
    eth: [],
    wasm: new Map(),
    validators: new Map([
      [miner, validator(miner)],
      [other, validator(other)],
    ]),
    delegations: [],
    unbonding: [],
    withdrawals: [],
    proposals: [],
    models: [],
    settlements: [],
    finalizedHeight: -1,
  };
}

function btc(hash: string): BtcHeaderRecord {
  return { hash, height: 0, prevHash: tip, merkleRoot: tip, bits: 0 };
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

const born = omega();
const step = applySuccessor(born, {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: "a".repeat(40),
  committedPressure: 0,
  couplings: born.couplings,
  difficulty: born.difficulty,
  wasmAfter: null,
});
assert.equal(step.ok, true);
if (!step.ok) throw new Error("unreachable");

const created =
  [...step.next.ledger.values()].reduce((s, a) => s + a.balance, 0) +
  [...step.next.validators.values()].reduce((s, v) => s + v.accumulatedRewards, 0);
assert.equal(step.reward, 99);
assert.equal(step.liquid, 9);
assert.equal(step.next.validators.get("a".repeat(40))?.accumulatedRewards, 45);
assert.equal(step.next.validators.get("b".repeat(40))?.accumulatedRewards, 45);
assert.equal(created, 99);
assert.equal(step.next.difficulty, 1_000_000);

const tipped = omega();
tipped.btc = [btc(tip)];
const foreignStep = applySuccessor(tipped, {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: "a".repeat(40),
  committedPressure: 0,
  couplings: tipped.couplings,
  difficulty: tipped.difficulty,
  wasmAfter: null,
});
assert.equal(foreignStep.ok, true);
if (!foreignStep.ok) throw new Error("unreachable");
assert.equal(foreignStep.next.difficulty, 995_000);

const root = evidenceRoot(evidence);
const parts = {
  prevHash: tip,
  merkleRoot: tip,
  stateRoot: step.stateRoot,
  timestamp: 1_700_000_000,
  nonce: 6,
  difficulty: 1_000_000,
  residualFp: step.residualFp,
  miner: "a".repeat(40),
  height: 1,
  committedPressure: 0,
};
const kernelHash = canonicalHeaderHash({ ...parts, chainId: evidence.chainId, evidenceRoot: root, omegaRoot: step.omegaRoot });
const artifactsHash = artifactsHeaderHash({ ...parts, chainId: evidence.chainId, evidenceRoot: root, omegaRoot: step.omegaRoot });
const tenField = canonicalHeaderHash(parts);
assert.equal(artifactsHash, kernelHash);
assert.notEqual(tenField, kernelHash);

const again = applySuccessor(cloneOmega(born), {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: "a".repeat(40),
  committedPressure: 0,
  couplings: born.couplings,
  difficulty: born.difficulty,
  wasmAfter: null,
});
assert.equal(again.ok && again.omegaRoot, step.omegaRoot);

for (const blockTime of [1, 8, 14, 15, 16, 100]) {
  const kernel = adjustDifficulty(1_000_000, blockTime, NETWORKS.mainnet, { num: 1, den: 1 });
  const artifacts = adjustDifficultySeconds(1_000_000, blockTime, 15, { num: 1, den: 1 });
  assert.equal(artifacts, kernel, `blockTime ${blockTime}`);
}
for (const hash of [tip, hot]) {
  const kernelForeign = foreignDifficultyFactor({ btc: [btc(hash)], eth: [] });
  const artifactsForeign = foreignTipFactor(hash, null);
  assert.deepEqual(artifactsForeign, kernelForeign);
  assert.equal(
    adjustDifficultySeconds(1_000_000, 15, 15, artifactsForeign),
    adjustDifficulty(1_000_000, 15, NETWORKS.mainnet, kernelForeign),
    hash,
  );
}

console.log(JSON.stringify({
  ok: true,
  reward: step.reward,
  liquid: step.liquid,
  created,
  difficulty: step.next.difficulty,
  foreignDifficulty: foreignStep.next.difficulty,
  header: kernelHash,
  tenFieldDiffers: true,
  residualFp: step.residualFp,
  evidenceRoot: root,
  omegaRoot: step.omegaRoot,
  stateRoot: step.stateRoot,
}));
