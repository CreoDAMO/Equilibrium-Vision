import assert from "node:assert/strict";
import { applySuccessor, initialOmega, openedCouplings } from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import { minerKey } from "./genesis";
import { stage1OptionA, stage1Order, STAGE1_EXCLUDES, STAGE1_OPTION_A_ID, retainOutcomes } from "./stage1-option-a";
import { ADOPTION_REQUIRES_TRANSITION_PROOF, verifyTransitionProof } from "./transition-proof";

assert.deepEqual(retainOutcomes(), Array(6).fill("RETAIN-WITH-DISCLAIMER"));
assert.equal(ADOPTION_REQUIRES_TRANSITION_PROOF, false);
assert.equal(verifyTransitionProof({ version: 1 } as never, null).ok, false);
assert.equal(STAGE1_EXCLUDES.includes("C-007"), true);

const higherSecond = [
  { hash: "b", from: "a", to: "c", amount: 1, fee: 1, nonce: 0 },
  { hash: "a", from: "a", to: "c", amount: 1, fee: 2, nonce: 0 },
];
assert.equal(
  stage1Order(() => 10, () => 0, higherSecond, 8, [higherSecond[1]!]),
  true,
);
assert.equal(
  stage1Order(() => 10, () => 0, higherSecond, 8, [higherSecond[0]!]),
  false,
);

const omega = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
const before = omega.ledger.get(miner)?.balance ?? 0;
const bonded = omega.validators.get(miner)?.bondedStake;
const dry = applySuccessor(omega, {
  transactions: [],
  timestamp: 1_700_000_000,
  nonce: 1n,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: null,
});
assert.equal(dry.ok, true);
if (!dry.ok) throw new Error("dry");
const balance = dry.next.ledger.get(miner)?.balance;
assert.equal(balance, before + dry.liquid);
const claim = {
  id: STAGE1_OPTION_A_ID,
  reward: dry.reward,
  liquid: dry.liquid,
  miner,
  minerBalance: balance!,
};
assert.equal(stage1OptionA(dry, claim).ok, true);
assert.equal(stage1OptionA(dry, { ...claim, liquid: claim.liquid + 1 }).ok, false);
assert.equal(stage1OptionA(dry, { ...claim, id: "faithful-v1" }).ok, false);

const slashed = applySuccessor(omega, {
  transactions: [],
  timestamp: 1_700_000_000,
  nonce: 1n,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: null,
  evidence: {
    v: 1,
    chainId: omega.chainId,
    wasmCode: ARBITRAGE_CODE,
    btc: [],
    eth: [],
    wasm: [],
    stake: [{ op: "slash", validator: miner, reason: "downtime" }],
  },
});
assert.equal(slashed.ok, false);
if (slashed.ok) throw new Error("slash");
assert.equal(slashed.error, "downtime is not punishable");
assert.equal(stage1OptionA(slashed, claim).ok, false);
assert.equal(omega.validators.get(miner)?.bondedStake, bonded);

console.log("stage1 option A checks the production split and does not adopt");
