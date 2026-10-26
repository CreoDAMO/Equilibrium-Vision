/**
 * Black-box refusal pins for the C7-A rejection ledger.
 * applySuccessor does not return the failed clone. An assertion here never
 * reads that clone. Where the expected error is reachable only after an
 * earlier operation returns, the error is evidence of that return.
 */
import assert from "node:assert/strict";
import { WITHDRAWAL_ESCROW, signAuthority, signWithdraw } from "./authority";
import { minerReward } from "./coinomics";
import { merkleRoot } from "./crypto";
import { activityKeys, minerKey } from "./genesis";
import { challengeBinding } from "./membranes";
import {
  applySuccessor,
  cloneOmega,
  initialOmega,
  monetaryError,
  openedCouplings,
  type CanonicalInputs,
  type Omega,
} from "./constitution";
import { blankEvidence } from "./seal";
import { evaluateResidual } from "./solver";
import type { StakeEvidence, TransitionEvidence } from "./types";
import { keypairFromSeed, signTx } from "./wallet";

const CEILING = Number.MAX_SAFE_INTEGER;
const born = initialOmega("testnet");
const miner = minerKey("testnet").address;
const payer = activityKeys("testnet")[0]!;
const other = activityKeys("testnet")[1]!;
const stranger = keypairFromSeed("c7a-rejection/stranger");
assert.notEqual(payer.address, miner);
assert.notEqual(other.address, miner);
assert.equal(born.pools.some((pool) => pool.address === other.address), false);
assert.equal(born.pools.some((pool) => pool.address === stranger.address), false);

function snap(omega: Omega): string {
  return JSON.stringify({
    chainId: omega.chainId,
    height: omega.height,
    tipHash: omega.tipHash,
    tipTimestamp: omega.tipTimestamp,
    difficulty: omega.difficulty,
    finalizedHeight: omega.finalizedHeight,
    couplings: omega.couplings,
    ledger: [...omega.ledger.entries()],
    pools: omega.pools,
    btc: omega.btc,
    ethPubkey: omega.ethPubkey,
    ethCommittee: omega.ethCommittee,
    eth: omega.eth,
    wasm: [...omega.wasm.entries()],
    validators: [...omega.validators.entries()],
    delegations: omega.delegations,
    unbonding: omega.unbonding,
    withdrawals: omega.withdrawals,
    ethExecution: omega.ethExecution,
    proposals: omega.proposals,
    models: omega.models,
    settlements: omega.settlements,
  });
}

function inputs(
  omega: Omega,
  evidence?: TransitionEvidence,
  transactions: CanonicalInputs["transactions"] = [],
  nonce = 0n,
): CanonicalInputs {
  return {
    transactions,
    evidence,
    timestamp: 15,
    nonce,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}

function refuse(omega: Omega, spec: CanonicalInputs, error: string): void {
  assert.equal(monetaryError(omega), null, error);
  const before = snap(omega);
  const result = applySuccessor(omega, spec);
  assert.equal(result.ok, false, error);
  if (result.ok) throw new Error(error);
  assert.equal(result.error, error);
  assert.equal(snap(omega), before);
}

function accept(omega: Omega, spec: CanonicalInputs): void {
  assert.equal(monetaryError(omega), null);
  const before = snap(omega);
  const result = applySuccessor(omega, spec);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);
  assert.equal(snap(omega), before);
}

function evidence(omega: Omega, patch: Partial<TransitionEvidence>): TransitionEvidence {
  return { ...blankEvidence(omega.chainId), ...patch };
}

function propose(deposit: number, couplingKey?: string): StakeEvidence {
  return {
    op: "propose",
    proposer: miner,
    title: "boundary",
    deposit,
    id: 7,
    ...(couplingKey === undefined ? {} : { couplingKey: couplingKey as "hash", couplingValue: 1 }),
  };
}

const proposal = cloneOmega(born);
refuse(
  proposal,
  inputs(proposal, evidence(proposal, { stake: [propose(1, "nope")] })),
  "coupling is not a coupling",
);
accept(cloneOmega(born), inputs(born, evidence(born, { stake: [propose(1)] })));

const destination = `p2pkh:${"ab".repeat(20)}`;
const open = signWithdraw(payer, {
  chainId: born.chainId,
  amount: 1,
  network: "btc",
  asset: "btc",
  destination,
  nonce: 0,
});
const openItem = {
  op: "open" as const,
  sender: payer.address,
  amount: 1,
  network: "btc" as const,
  asset: "btc",
  destination,
  nonce: 0,
  publicKey: open.publicKey,
  signature: open.signature,
};
const escrowFull = cloneOmega(born);
escrowFull.ledger.set(WITHDRAWAL_ESCROW, { balance: CEILING, nonce: 0 });
refuse(
  escrowFull,
  inputs(escrowFull, evidence(escrowFull, { withdraw: [openItem] })),
  "withdrawal funds refused",
);
accept(cloneOmega(born), inputs(born, evidence(born, { withdraw: [openItem] })));
const broke = keypairFromSeed("c7a-rejection/broke");
const brokeOpen = signWithdraw(broke, {
  chainId: born.chainId,
  amount: 1,
  network: "btc",
  asset: "btc",
  destination,
  nonce: 0,
});
refuse(cloneOmega(born), inputs(born, evidence(born, {
  withdraw: [{
    op: "open",
    sender: broke.address,
    amount: 1,
    network: "btc",
    asset: "btc",
    destination,
    nonce: 0,
    publicKey: brokeOpen.publicKey,
    signature: brokeOpen.signature,
  }],
})), "balance refused");

function transfer(from: typeof payer, to: string, nonce = 0) {
  return signTx(from, { to, amount: 1, fee: 1, nonce, chainId: born.chainId, timestamp: 15 });
}

const feeCeiling = cloneOmega(born);
const minerAccount = feeCeiling.ledger.get(miner);
assert.ok(minerAccount);
minerAccount.balance = CEILING;
const feeTx = transfer(payer, stranger.address);
refuse(feeCeiling, inputs(feeCeiling, undefined, [feeTx]), "amount refused");
accept(cloneOmega(born), inputs(born, undefined, [feeTx]));

const recipientCeiling = cloneOmega(born);
recipientCeiling.ledger.set(other.address, { balance: CEILING, nonce: 0 });
const recipientTx = transfer(payer, other.address);
refuse(recipientCeiling, inputs(recipientCeiling, undefined, [recipientTx]), "amount refused");
accept(cloneOmega(born), inputs(born, undefined, [transfer(payer, other.address)]));

const firstPay = "11".repeat(20);
const secondPay = "22".repeat(20);
const bothUnbond = cloneOmega(born);
bothUnbond.unbonding = [
  { delegator: firstPay, validator: miner, amount: 1, matureAt: 0 },
  { delegator: secondPay, validator: miner, amount: 1, matureAt: 0 },
];
bothUnbond.ledger.set(secondPay, { balance: CEILING, nonce: 0 });
refuse(bothUnbond, inputs(bothUnbond), "unbond payout refused");
const firstOnly = cloneOmega(born);
firstOnly.unbonding = [{ delegator: firstPay, validator: miner, amount: 1, matureAt: 0 }];
accept(firstOnly, inputs(firstOnly));

const refundA = "aa".repeat(32);
const refundB = "bb".repeat(32);
const refunds = cloneOmega(born);
refunds.ledger.set(WITHDRAWAL_ESCROW, { balance: 2, nonce: 0 });
refunds.ledger.set(secondPay, { balance: CEILING, nonce: 0 });
refunds.withdrawals = [
  {
    id: refundA,
    sender: firstPay,
    amount: 1,
    network: "btc",
    asset: "btc",
    destination,
    nonce: 0,
    createdHeight: 0,
    expiryHeight: 0,
    status: "locked",
    effectLocator: null,
  },
  {
    id: refundB,
    sender: secondPay,
    amount: 1,
    network: "btc",
    asset: "btc",
    destination,
    nonce: 1,
    createdHeight: 0,
    expiryHeight: 0,
    status: "locked",
    effectLocator: null,
  },
];
refuse(refunds, inputs(refunds), "withdrawal refund refused");
const oneRefund = cloneOmega(born);
oneRefund.ledger.set(WITHDRAWAL_ESCROW, { balance: 1, nonce: 0 });
oneRefund.withdrawals = [refunds.withdrawals[0]!];
accept(oneRefund, inputs(oneRefund));

const support = "ab".repeat(32);
const disagreed = "cd".repeat(32);
const challenged = cloneOmega(born);
challenged.models = [{
  id: 7,
  uri: "ipfs://model",
  residualFp: 1,
  supportHash: support,
  status: "bound",
  proposedAt: 15,
}];
refuse(challenged, inputs(challenged, evidence(challenged, {
  cognition: [
    { kind: "challenge", id: 7, supportHash: disagreed, proof: challengeBinding(born.chainId, 7, disagreed) },
    { kind: "challenge", id: 7, supportHash: "ef".repeat(32), proof: challengeBinding(born.chainId, 7, "ef".repeat(32)) },
  ],
})), "model is not bound");

const aged = cloneOmega(born);
aged.height = 0;
aged.tipTimestamp = 1;
const root = merkleRoot(["0".repeat(64)]);
let chosen: bigint | null = null;
for (let n = 0; n < 50_000; n++) {
  const breakdown = evaluateResidual(
    { prevHash: aged.tipHash, merkleRoot: root, timestamp: 15, nonce: n, difficulty: aged.difficulty },
    [],
    { cumulativeWork: 1, mempoolPressure: 0 },
    openedCouplings(aged),
  );
  const reward = Math.max(0, Math.floor(minerReward(1, breakdown.canonical, 2e-3, {
    baseReward: 100,
    halvingInterval: 2_100_000,
  })));
  if (reward - Math.floor(reward * 0.1) >= 4) {
    chosen = BigInt(n);
    break;
  }
}
assert.notEqual(chosen, null);
if (chosen === null) throw new Error("no paying nonce");
const probe = applySuccessor(cloneOmega(aged), inputs(aged, undefined, [], chosen));
assert.equal(probe.ok, true);
if (!probe.ok) throw new Error(probe.error);
const staked = probe.reward - probe.liquid;
assert.ok(staked > 0, `reward ${probe.reward}`);
const live = [...aged.validators.values()].filter((validator) => !validator.jailed && !validator.slashed && validator.bondedStake > 0);
let total = 0;
for (const validator of live) total += validator.bondedStake;
const shares = live.map((validator) => Math.floor((staked * validator.bondedStake) / total));
const later = shares.findIndex((share, index) => share >= 1 && shares.slice(0, index).some((earlier) => earlier >= 1));
assert.ok(later > 0, `no later share: reward ${probe.reward} liquid ${probe.liquid} shares ${shares.join(",")}`);
const overflowing = cloneOmega(aged);
const target = [...overflowing.validators.values()][later]!;
target.accumulatedRewards = CEILING;
assert.ok(Number.isSafeInteger(staked * target.bondedStake));
refuse(overflowing, inputs(overflowing, undefined, [], chosen), "reward refused");
accept(cloneOmega(aged), inputs(aged, undefined, [], chosen));

const highNonce = cloneOmega(born);
const paying = highNonce.ledger.get(payer.address);
assert.ok(paying);
paying.nonce = CEILING;
const nonceTx = transfer(payer, stranger.address, CEILING);
refuse(highNonce, inputs(highNonce, undefined, [nonceTx]), "balance refused");

const firstDelegate = signAuthority(payer, { op: "delegate", chainId: born.chainId, validator: miner, amount: 1 });
const secondDelegate = signAuthority(payer, { op: "delegate", chainId: born.chainId, validator: "00".repeat(20), amount: 1 });
const delegates = cloneOmega(born);
refuse(delegates, inputs(delegates, evidence(delegates, {
  stake: [
    { op: "delegate", delegator: payer.address, validator: miner, amount: 1, publicKey: firstDelegate.publicKey, signature: firstDelegate.signature },
    { op: "delegate", delegator: payer.address, validator: "00".repeat(20), amount: 1, publicKey: secondDelegate.publicKey, signature: secondDelegate.signature },
  ],
})), "delegate refused");

const observed = "ab".repeat(32);
const known = cloneOmega(born);
known.btc = [{ hash: observed, height: 0, prevHash: "00".repeat(32), merkleRoot: "11".repeat(32), bits: 1 }];
const locks = evidence(known, {
  settle: [
    { op: "lock", id: 1, asset: "btc", foreignRef: observed, from: payer.address, to: other.address, amount: 1 },
    { op: "lock", id: 2, asset: "btc", foreignRef: "ff".repeat(32), from: payer.address, to: other.address, amount: 1 },
  ],
});
refuse(known, inputs(known, locks), "foreign observation is not in Ω");

const secondOpen = signWithdraw(payer, {
  chainId: born.chainId,
  amount: 1,
  network: "btc",
  asset: "btc",
  destination,
  nonce: 1,
});
const badOpen = { ...openItem, nonce: 1, amount: 1, publicKey: secondOpen.publicKey, signature: "00".repeat(64) };
refuse(
  cloneOmega(born),
  inputs(born, evidence(born, { withdraw: [openItem, badOpen] })),
  "withdraw authority refused",
);

const ordered = cloneOmega(born);
refuse(ordered, inputs(ordered, evidence(ordered, {
  stake: [
    { op: "delegate", delegator: payer.address, validator: miner, amount: 1, publicKey: firstDelegate.publicKey, signature: firstDelegate.signature },
  ],
  btc: [{ height: 0, headerHex: "00" }],
})), "btc header is not 80 bytes");
