/**
 * S1–S5 against this successor. S6 and S7 are recorded, not claimed.
 * A refusal must leave the original Ω untouched.
 */
import assert from "node:assert/strict";
import { CanonicalBody } from "../../../artifacts/api-server/src/chain/canonical-body";
import {
  applySuccessor,
  cloneOmega,
  foreignDifficultyFactor,
  initialOmega,
  monetaryError,
  omegaDigest,
  openedCouplings,
  stateRootOf,
  successor,
  transitionDigest,
  type Omega,
} from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import { activityKeys, GENESIS_ALLOCATIONS, minerKey } from "./genesis";
import { sealFromSuccessor } from "./seal";
import type { StakeEvidence } from "./types";
import { signTx } from "./wallet";

const omega = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
const payer = activityKeys("mainnet")[0]!;
const community = GENESIS_ALLOCATIONS[0]!.address;
const v1 = [...omega.validators.values()].find((v) => v.bondedStake === 1_500_000)!;
const rich = [...omega.validators.values()].filter((v) => v.address !== v1.address && v.bondedStake >= 1_000_000);

function blank(stake: StakeEvidence[] = []) {
  return {
    v: 1 as const,
    chainId: omega.chainId,
    wasmCode: ARBITRAGE_CODE,
    btc: [],
    eth: [],
    wasm: [],
    stake,
  };
}

function run(current: Omega, stake: StakeEvidence[], transactions: Omega extends never ? never : ReturnType<typeof signTx>[] = []) {
  const before = omegaDigest(current);
  const result = applySuccessor(current, {
    transactions,
    evidence: blank(stake),
    timestamp: 1_700_000_000,
    nonce: 6,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
    wasmAfter: null,
  });
  assert.equal(omegaDigest(current), before);
  return result;
}

const delegateNeg = run(omega, [{ op: "delegate", delegator: payer.address, validator: v1.address, amount: -1 }]);
assert.equal(delegateNeg.ok, false);
if (delegateNeg.ok) throw new Error("negative delegation");
assert.match(delegateNeg.error, /delegate amount/);

const delegateZero = run(omega, [{ op: "delegate", delegator: payer.address, validator: v1.address, amount: 0 }]);
assert.equal(delegateZero.ok, false);

const delegateHuge = run(omega, [{
  op: "delegate",
  delegator: payer.address,
  validator: v1.address,
  amount: Number.MAX_SAFE_INTEGER + 1,
}]);
assert.equal(delegateHuge.ok, false);

const minted = run(omega, [{ op: "propose", proposer: miner, title: "mint", deposit: -10, id: 1 }]);
assert.equal(minted.ok, false);
if (minted.ok) throw new Error("negative deposit");
assert.match(minted.error, /proposal deposit/);

const poisoned = cloneOmega(omega);
poisoned.validators.get(v1.address)!.bondedStake = -999_000;
assert.equal(monetaryError(poisoned), "bonded stake refused");
const poisonedStep = run(poisoned, []);
assert.equal(poisonedStep.ok, false);
if (poisonedStep.ok) throw new Error("negative stake entered G");

const huge = signTx(payer, {
  to: "cd".repeat(20),
  amount: Number.MAX_SAFE_INTEGER,
  fee: 1,
  nonce: 0,
  chainId: omega.chainId,
  timestamp: 1_700_000_000,
});
const unsafe = run(omega, [], [huge]);
assert.equal(unsafe.ok, false);
if (unsafe.ok) throw new Error("unsafe sum");
assert.match(unsafe.error, /amount refused/);

const delegated = run(omega, [{ op: "delegate", delegator: payer.address, validator: v1.address, amount: 10 }]);
assert.equal(delegated.ok, true);
if (!delegated.ok) throw new Error(delegated.error);
assert.equal(delegated.next.validators.get(v1.address)!.bondedStake, v1.bondedStake + 10);
assert.equal(delegated.next.ledger.get(payer.address)!.balance, 1_500_000 - 10);
assert.equal(monetaryError(delegated.next), null);

const propose: StakeEvidence = { op: "propose", proposer: miner, title: "keep", deposit: 0, id: 1 };
const stranger = run(omega, [propose, { op: "vote", voter: payer.address, id: 1, option: "yes" }]);
assert.equal(stranger.ok, false);
if (stranger.ok) throw new Error("non-validator voted");
assert.match(stranger.error, /vote refused/);

const unauthorized = run(omega, [{ op: "propose", proposer: community, title: "open", deposit: 0, id: 4 }]);
assert.equal(unauthorized.ok, false);
if (unauthorized.ok) throw new Error("stranger proposed");
assert.match(unauthorized.error, /unauthorized/);

const once = run(omega, [propose, { op: "vote", voter: v1.address, id: 1, option: "yes" }]);
assert.equal(once.ok, true);
if (!once.ok) throw new Error(once.error);
const onceProposal = once.next.proposals.find((p) => p.id === 1)!;
assert.equal(onceProposal.yes, v1.bondedStake);
assert.equal(onceProposal.ballots?.length, 1);
assert.notEqual(onceProposal.status, "passed");

const repeated = run(omega, [
  propose,
  { op: "vote", voter: v1.address, id: 1, option: "yes" },
  { op: "vote", voter: v1.address, id: 1, option: "yes" },
]);
assert.equal(repeated.ok, false);
if (repeated.ok) throw new Error("vote was reused");
assert.match(repeated.error, /vote already cast/);

const amplified = run(omega, [
  propose,
  { op: "delegate", delegator: community, validator: v1.address, amount: 10_000_000 },
  { op: "vote", voter: v1.address, id: 1, option: "yes" },
]);
assert.equal(amplified.ok, true);
if (!amplified.ok) throw new Error(amplified.error);
const amplifiedProposal = amplified.next.proposals.find((p) => p.id === 1)!;
assert.equal(amplifiedProposal.yes, v1.bondedStake);
assert.equal(amplified.next.validators.get(v1.address)!.bondedStake, v1.bondedStake + 10_000_000);
assert.notEqual(amplifiedProposal.status, "passed");

const slashedThenVoted = run(omega, [
  propose,
  { op: "slash", validator: rich[0]!.address, reason: "double_sign" },
  { op: "slash", validator: rich[1]!.address, reason: "double_sign" },
  { op: "vote", voter: v1.address, id: 1, option: "yes" },
]);
assert.equal(slashedThenVoted.ok, true);
if (!slashedThenVoted.ok) throw new Error(slashedThenVoted.error);
assert.equal(slashedThenVoted.next.proposals.find((p) => p.id === 1)!.yes, v1.bondedStake);
assert.notEqual(slashedThenVoted.next.proposals.find((p) => p.id === 1)!.status, "passed");

const doubleSlash = run(omega, [
  { op: "slash", validator: v1.address, reason: "double_sign" },
  { op: "slash", validator: v1.address, reason: "double_sign" },
]);
assert.equal(doubleSlash.ok, false);

const already = cloneOmega(omega);
already.validators.get(v1.address)!.slashed = true;
const slashedVote = run(already, [propose, { op: "vote", voter: v1.address, id: 1, option: "yes" }]);
assert.equal(slashedVote.ok, false);

const jailed = cloneOmega(omega);
jailed.validators.get(v1.address)!.jailed = true;
const jailedVote = run(jailed, [propose, { op: "vote", voter: v1.address, id: 1, option: "yes" }]);
assert.equal(jailedVote.ok, false);

const rewarded = cloneOmega(omega);
rewarded.validators.get(miner)!.accumulatedRewards = 10_000_000;
const claimed = run(rewarded, [
  { op: "claim", address: miner },
  { op: "delegate", delegator: miner, validator: miner, amount: 10_000_000 },
  { op: "propose", proposer: miner, title: "after claim", deposit: 0, id: 3 },
  { op: "vote", voter: miner, id: 3, option: "yes" },
]);
assert.equal(claimed.ok, true);
if (!claimed.ok) throw new Error(claimed.error);
assert.equal(claimed.next.proposals.find((p) => p.id === 3)!.yes, 500_000);
assert.notEqual(claimed.next.proposals.find((p) => p.id === 3)!.status, "passed");
assert.equal(claimed.next.validators.get(miner)!.bondedStake, 500_000 + 10_000_000);

const titled = cloneOmega(omega);
titled.proposals.push({
  id: 8,
  title: "a",
  proposer: miner,
  deposit: 0,
  yes: 0,
  no: 0,
  abstain: 0,
  status: "open",
  ballots: [],
});
const retitled = cloneOmega(titled);
retitled.proposals[0]!.title = "b";
assert.notEqual(omegaDigest(titled), omegaDigest(retitled));
assert.equal(stateRootOf(titled), stateRootOf(retitled));

const named = cloneOmega(omega);
named.validators.get(v1.address)!.moniker = "other";
assert.notEqual(omegaDigest(omega), omegaDigest(named));
named.validators.get(v1.address)!.moniker = v1.moniker;
named.validators.get(v1.address)!.uptime = 0;
assert.notEqual(omegaDigest(omega), omegaDigest(named));

const foreign = cloneOmega(omega);
foreign.btc.push({ hash: "ab".repeat(32), height: 0, prevHash: "00".repeat(32), merkleRoot: "11".repeat(32), bits: 1 });
const bits = cloneOmega(foreign);
bits.btc[0]!.bits = 9;
bits.btc[0]!.merkleRoot = "22".repeat(32);
bits.btc[0]!.prevHash = "33".repeat(32);
assert.notEqual(omegaDigest(foreign), omegaDigest(bits));
assert.equal(stateRootOf(foreign), stateRootOf(bits));
assert.deepEqual(foreignDifficultyFactor(foreign), foreignDifficultyFactor(bits));
const participants = cloneOmega(omega);
participants.eth.push({
  slot: 1,
  hash: "aa".repeat(32),
  parentRoot: "bb".repeat(32),
  stateRoot: "cc".repeat(32),
  bodyRoot: "dd".repeat(32),
  participants: 342,
});
const committee = cloneOmega(participants);
committee.eth[0]!.participants = 400;
assert.notEqual(omegaDigest(participants), omegaDigest(committee));
const tipped = cloneOmega(omega);
tipped.tipHash = "ff".repeat(32);
assert.equal(omegaDigest(omega), omegaDigest(tipped));

const forgedWasm = applySuccessor(omega, {
  transactions: [],
  evidence: { ...blank(), wasm: [{ method: "init", caller: miner }] },
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: new Map([["cell", "forged"]]),
});
assert.equal(forgedWasm.ok, false);
if (forgedWasm.ok) throw new Error("forged wasm installed");
const executed = await successor(omega, {
  transactions: [],
  evidence: { ...blank(), wasm: [{ method: "init", caller: miner }] },
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
});
assert.equal(executed.ok, true);
if (!executed.ok) throw new Error(executed.error);
assert.equal(executed.next.wasm.has("cell"), false);
assert.equal(executed.next.wasm.get("owner"), miner);

const body = new CanonicalBody("mainnet");
const inputs = {
  transactions: [] as [],
  evidence: blank(),
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(body.omega),
  difficulty: body.omega.difficulty,
};
const stepped = await successor(body.omega, inputs);
assert.equal(stepped.ok, true);
if (!stepped.ok) throw new Error(stepped.error);
const sealed = sealFromSuccessor(body.omega, { ...inputs, wasmAfter: null }, stepped);
assert.equal(sealed.transitionRoot, transitionDigest(body.omega, { ...inputs, wasmAfter: null }));
const liar = new CanonicalBody("mainnet");
const lied = await liar.replay({
  hash: sealed.hash,
  evidence: sealed.evidence,
  transactions: [],
  timestamp: inputs.timestamp,
  nonce: inputs.nonce,
  miner,
  difficulty: inputs.difficulty,
  committedPressure: 0,
  stateRoot: stepped.stateRoot,
  omegaRoot: stepped.omegaRoot,
  transitionRoot: "ab".repeat(32),
});
assert.equal(lied, "transition is not this input");
assert.equal(liar.omega.height, -1);
const fresh = new CanonicalBody("mainnet");
const admitted = await fresh.replay({
  hash: sealed.hash,
  evidence: sealed.evidence,
  transactions: [],
  timestamp: inputs.timestamp,
  nonce: inputs.nonce,
  miner,
  difficulty: inputs.difficulty,
  committedPressure: 0,
  stateRoot: stepped.stateRoot,
  omegaRoot: stepped.omegaRoot,
  transitionRoot: sealed.transitionRoot,
});
assert.equal(admitted, null);
assert.equal(fresh.omega.height, 0);

const protocol = 201_100_202_523_998;
const reference = 201_100_202_523_995;
const thresholdFp = Math.floor(8e-4 * 1e18);

console.log(JSON.stringify({
  ok: true,
  s1: "refused",
  s2: amplifiedProposal.yes,
  s3: "distinct",
  s4: executed.next.wasm.get("paused"),
  s5: sealed.transitionRoot.slice(0, 16),
  s6: "open: site owns the residual, header, and coinbase contract. Rust reads it and does not reconstruct G. Android was not executed.",
  s7: "open: no APK was built, two builds were not compared, and the deployment does not name the commit.",
  sameAdmission: protocol < thresholdFp && reference < thresholdFp,
}));
