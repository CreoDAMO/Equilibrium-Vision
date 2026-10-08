/**
 * S6 input expansion. Site applies the successor. Native applies the same
 * pre-state and I. A caller-supplied Ω′ is not an input.
 * Ethereum is the site BLS check. One case carries several classes at once.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "./bytes";
import { BTC_GENESIS_HEADER_HEX, parseBtcHeader } from "./btc";
import {
  applySuccessor,
  cloneOmega,
  initialOmega,
  openedCouplings,
  successor,
  type CanonicalInputs,
  type Omega,
} from "./constitution";
import { poolAddress } from "./dex";
import { jsonText } from "./domain";
import { canonicalEvidence } from "./evidence";
import { committeeAggregate, hashEthHeader, hexOf, participationMask, signRotation, signSelected, syncCommittee } from "./eth-light";
import { activityKeys, minerKey } from "./genesis";
import { challengeBinding, modelBinding, residualBinding } from "./membranes";
import { blankEvidence, sealFromSuccessor } from "./seal";
import type { TransitionEvidence, TxRecord } from "./types";
import { signAuthority } from "./authority";
import { signTx } from "./wallet";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const miner = minerKey("mainnet").address;
const payer = activityKeys("mainnet")[0]!;
const other = "34".repeat(20);
const other2 = "56".repeat(20);

function spec(current: Omega, evidence: TransitionEvidence = blankEvidence(current.chainId)): CanonicalInputs {
  return {
    transactions: [],
    evidence,
    timestamp: 1_700_000_000,
    nonce: 6n,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
    wasmAfter: null,
  };
}

function pay(nonce: number, amount: number, fee: number, to: string): TxRecord {
  return signTx(payer, { to, amount, fee, nonce, chainId: 1, timestamp: 1_700_000_000 });
}

function provedDelegate(amount = 10) {
  const proof = signAuthority(payer, { op: "delegate", chainId: 1, validator: miner, amount });
  return {
    op: "delegate" as const,
    delegator: payer.address,
    validator: miner,
    amount,
    publicKey: proof.publicKey,
    signature: proof.signature,
  };
}

function snap(current: Omega) {
  return {
    tipHash: current.tipHash,
    chainId: current.chainId,
    height: current.height,
    tipTimestamp: current.tipTimestamp,
    difficulty: current.difficulty,
    finalizedHeight: current.finalizedHeight,
    couplings: current.couplings,
    ledger: [...current.ledger.entries()].map(([address, acc]) => ({
      address,
      balance: acc.balance,
      nonce: acc.nonce,
    })),
    pools: current.pools.map((p) => ({
      id: p.id,
      address: p.address,
      reserveA: p.reserveA,
      reserveB: p.reserveB,
      txCount: p.txCount,
      fee: p.fee,
    })),
    btc: current.btc.map((h) => ({ ...h })),
    ethPubkey: current.ethPubkey,
    ethCommittee: current.ethCommittee ?? "",
    eth: current.eth.map((h) => ({ ...h })),
    wasm: [...current.wasm.entries()],
    validators: [...current.validators.values()].map((v) => ({ ...v })),
    delegations: current.delegations.map((d) => ({ ...d })),
    unbonding: current.unbonding.map((u) => ({ ...u })),
    withdrawals: current.withdrawals.map((w) => ({ ...w })),
    ethExecution: (current.ethExecution ?? []).map((h) => ({ ...h })),
    proposals: current.proposals.map((p) => ({
      id: p.id,
      status: p.status,
      title: p.title,
      proposer: p.proposer,
      deposit: p.deposit,
      yes: p.yes,
      no: p.no,
      abstain: p.abstain,
      couplingKey: p.couplingKey ?? null,
      couplingValue: p.couplingValue ?? null,
      ballots: p.ballots ?? [],
    })),
    models: current.models.map((m) => ({ ...m })),
    settlements: current.settlements.map((s) => ({ ...s })),
  };
}

function transitionOf(current: Omega, input: CanonicalInputs) {
  return {
    txs: input.transactions.map((t) => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
      signature: t.signature,
      publicKey: t.publicKey,
    })),
    evidence: input.evidence ? canonicalEvidence(input.evidence) : "",
    timestamp: input.timestamp,
    nonce: input.nonce,
    miner: input.miner,
    pressure: input.committedPressure,
    difficulty: input.difficulty,
    couplings: input.couplings,
    body: input.evidence ?? null,
    wasmAfter: [["paused", "999"]],
  };
}

type SiteResult = { ok: true; omegaRoot: string; transitionRoot: string; header: string; stateRoot: string } | { ok: false; error: string };

function run(current: Omega, input: CanonicalInputs): SiteResult {
  const stepped = applySuccessor(current, input);
  if (!stepped.ok) return { ok: false, error: stepped.error };
  const seal = sealFromSuccessor(current, input, stepped);
  return {
    ok: true,
    omegaRoot: stepped.omegaRoot,
    transitionRoot: seal.transitionRoot,
    header: seal.hash,
    stateRoot: stepped.stateRoot,
  };
}

function pack(
  name: string,
  current: Omega,
  input: CanonicalInputs,
  site: SiteResult,
  decoyBalance?: number,
) {
  return {
    name,
    pre: snap(current),
    transition: transitionOf(current, input),
    site: site.ok
      ? {
          omegaRoot: site.omegaRoot,
          transitionRoot: site.transitionRoot,
          header: site.header,
          stateRoot: site.stateRoot,
        }
      : null,
    refuse: site.ok ? null : site.error,
    decoyBalance: decoyBalance ?? null,
  };
}

const born = initialOmega("mainnet");
const txIn = spec(born);
txIn.transactions = [pay(0, 5, 1, other)];
const txSite = run(born, txIn);
assert.equal(txSite.ok, true);
if (!txSite.ok) throw new Error("tx");

const alteredIn = spec(born);
const altered = pay(0, 5, 1, other);
altered.amount = 9;
alteredIn.transactions = [altered];
const alteredSite = run(born, alteredIn);
assert.equal(alteredSite.ok, false);
if (alteredSite.ok) throw new Error("altered");
assert.equal(alteredSite.error, "signature refused");

const otherIn = spec(born);
otherIn.transactions = [pay(0, 9, 1, other)];
const otherSite = run(born, otherIn);
assert.equal(otherSite.ok, true);
if (!otherSite.ok || !txSite.ok) throw new Error("other");
assert.notEqual(otherSite.omegaRoot, txSite.omegaRoot);
assert.notEqual(otherSite.transitionRoot, txSite.transitionRoot);

const orderIn = spec(born);
orderIn.transactions = [pay(1, 4, 2, other2), pay(0, 5, 1, other)];
const orderSite = run(born, orderIn);
assert.equal(orderSite.ok, false);
if (orderSite.ok) throw new Error("order");
assert.equal(orderSite.error, "transactions are not the canonical selection");

const voteOmega = cloneOmega(born);
voteOmega.proposals.push({
  id: 1,
  title: "x",
  proposer: miner,
  deposit: 0,
  yes: 0,
  no: 0,
  abstain: 0,
  status: "open",
  ballots: [],
});
const voteIn = spec(voteOmega, {
  ...blankEvidence(1),
  stake: [{ op: "vote", voter: miner, id: 1, option: "yes" }],
});
const voteSite = run(voteOmega, voteIn);
assert.equal(voteSite.ok, true);

const strangerIn = spec(voteOmega, {
  ...blankEvidence(1),
  stake: [{ op: "vote", voter: "0".repeat(40), id: 1, option: "yes" }],
});
const strangerSite = run(voteOmega, strangerIn);
assert.equal(strangerSite.ok, false);
if (strangerSite.ok) throw new Error("stranger");
assert.equal(strangerSite.error, "vote refused");

const delegateIn = spec(born, {
  ...blankEvidence(1),
  stake: [{ op: "delegate", delegator: payer.address, validator: miner, amount: 10 }],
});
const delegateSite = run(born, delegateIn);
assert.equal(delegateSite.ok, false);
if (delegateSite.ok) throw new Error("bare delegate");
assert.equal(delegateSite.error, "delegate authority refused");

const slashIn = spec(born, {
  ...blankEvidence(1),
  stake: [{ op: "slash", validator: "cec6a4f606263f462db50d853f599b758cede73b", reason: "downtime" }],
});
const slashSite = run(born, slashIn);
assert.equal(slashSite.ok, true);

const claimIn = spec(born, {
  ...blankEvidence(1),
  stake: [{ op: "claim", address: miner }],
});
const claimSite = run(born, claimIn);
assert.equal(claimSite.ok, false);
if (claimSite.ok) throw new Error("claim");
assert.equal(claimSite.error, "claim refused");

const wasmOmega = cloneOmega(born);
const wasmEvidence = { ...blankEvidence(1), wasm: [{ method: "init" as const, caller: miner }] };
const wasmSpec = spec(wasmOmega, wasmEvidence);
const { wasmAfter: _ignored, ...wasmInput } = wasmSpec;
const wasmStepped = await successor(wasmOmega, wasmInput);
assert.equal(wasmStepped.ok, true, wasmStepped.ok ? "" : wasmStepped.error);
if (!wasmStepped.ok) throw new Error(wasmStepped.error);
const wasmSeal = sealFromSuccessor(wasmOmega, wasmSpec, wasmStepped);
assert.equal(wasmStepped.next.wasm.get("owner"), miner);
assert.notEqual(wasmStepped.next.wasm.get("owner"), "999");
const wasmSite = {
  ok: true as const,
  omegaRoot: wasmStepped.omegaRoot,
  transitionRoot: wasmSeal.transitionRoot,
  header: wasmSeal.hash,
  stateRoot: wasmStepped.stateRoot,
};

const btcIn = spec(born, { ...blankEvidence(1), btc: [{ height: 0, headerHex: BTC_GENESIS_HEADER_HEX }] });
const btcSite = run(born, btcIn);
assert.equal(btcSite.ok, true);
if (!btcSite.ok) throw new Error("btc");
const btcStepped = applySuccessor(born, btcIn);
if (!btcStepped.ok) throw new Error(btcStepped.error);

const forgedHex = `${BTC_GENESIS_HEADER_HEX.slice(0, -1)}d`;
const forgedIn = spec(born, { ...blankEvidence(1), btc: [{ height: 0, headerHex: forgedHex }] });
const forgedSite = run(born, forgedIn);
assert.equal(forgedSite.ok, false);
if (forgedSite.ok) throw new Error("forged btc");
assert.equal(forgedSite.error, "btc proof of work refused");

const support = "ab".repeat(32);
const modelClaim = { id: 7, uri: "ipfs://m", residualFp: 3, supportHash: support };
const modelIn = spec(born, {
  ...blankEvidence(1),
  cognition: [{ kind: "model", ...modelClaim, proof: modelBinding(1, modelClaim) }],
});
const modelSite = run(born, modelIn);
assert.equal(modelSite.ok, true);
const modelStepped = applySuccessor(born, modelIn);
if (!modelStepped.ok) throw new Error(modelStepped.error);

const badModelIn = spec(born, {
  ...blankEvidence(1),
  cognition: [{ kind: "model", ...modelClaim, proof: "00".repeat(32) }],
});
const badModelSite = run(born, badModelIn);
assert.equal(badModelSite.ok, false);
if (badModelSite.ok) throw new Error("bad model");
assert.equal(badModelSite.error, "model commitment refused");

const quiet = cloneOmega(born);
quiet.proposals.push({
  id: 3,
  title: "drop continuity",
  proposer: miner,
  deposit: 0,
  yes: 1,
  no: 0,
  abstain: 0,
  status: "passed",
  ballots: [],
  couplingKey: "continuity",
  couplingValue: 0,
});
const quietIn = spec(quiet);
const quietStepped = applySuccessor(quiet, quietIn);
assert.equal(quietStepped.ok, true);
if (!quietStepped.ok) throw new Error(quietStepped.error);
const bind = {
  kind: "bind" as const,
  residualFp: quietStepped.residualFp,
  proof: residualBinding(quietStepped.residualFp, quietStepped.stateRoot),
};
const bindIn = spec(quiet, { ...blankEvidence(1), cognition: [bind] });
const bindSite = run(quiet, bindIn);
assert.equal(bindSite.ok, true);
if (bindSite.ok && quietStepped.ok) {
  assert.equal(bindSite.omegaRoot, quietStepped.omegaRoot);
  assert.notEqual(bindSite.transitionRoot, sealFromSuccessor(quiet, quietIn, quietStepped).transitionRoot);
}

const challengeSupport = "cd".repeat(32);
const challengeIn = spec(modelStepped.next, {
  ...blankEvidence(1),
  cognition: [{
    kind: "challenge",
    id: 7,
    supportHash: challengeSupport,
    proof: challengeBinding(1, 7, challengeSupport),
  }],
});
const challengeSite = run(modelStepped.next, challengeIn);
assert.equal(challengeSite.ok, true);

const btcHash = btcStepped.next.btc[0]!.hash;
const lockIn = spec(btcStepped.next, {
  ...blankEvidence(1),
  settle: [{
    op: "lock",
    id: 4,
    asset: "btc",
    foreignRef: btcHash,
    from: payer.address,
    to: miner,
    amount: 10,
  }],
});
const lockSite = run(btcStepped.next, lockIn);
assert.equal(lockSite.ok, true);
const lockStepped = applySuccessor(btcStepped.next, lockIn);
if (!lockStepped.ok) throw new Error(lockStepped.error);

const releaseIn = spec(lockStepped.next, {
  ...blankEvidence(1),
  settle: [{ op: "release", id: 4 }],
});
const releaseSite = run(lockStepped.next, releaseIn);
assert.equal(releaseSite.ok, true);

const committee = syncCommittee(1);
const otherCommittee = syncCommittee(2);
const ethFields = {
  slot: 7,
  proposerIndex: 3,
  parentRoot: "11".repeat(32),
  stateRoot: "22".repeat(32),
  bodyRoot: "33".repeat(32),
};
const bits342 = participationMask(342);
const ethSig = hexOf(signSelected(committee.secrets, ethFields, bits342));
const ethBoot = { op: "bootstrap" as const, committee: committee.committee, aggregate: committee.aggregate };
function ethHeader(count: number, fields = ethFields, signature?: string) {
  const bits = participationMask(count);
  const signed =
    signature ??
    (fields === ethFields && count === 342
      ? ethSig
      : hexOf(signSelected(committee.secrets, fields, bits)));
  return {
    op: "header" as const,
    ...fields,
    participation: hexOf(bits),
    signature: signed,
  };
}
function ethEvidence(count: number, fields = ethFields, signature?: string): TransitionEvidence {
  return {
    ...blankEvidence(1),
    eth: [ethBoot, ethHeader(count, fields, signature)],
  };
}
const ethIn = spec(born, ethEvidence(342));
const ethSite = run(born, ethIn);
assert.equal(ethSite.ok, true);
if (!ethSite.ok) throw new Error("eth");
const ethStepped = applySuccessor(born, ethIn);
if (!ethStepped.ok) throw new Error(ethStepped.error);
assert.equal(ethStepped.next.eth.length, 1);
assert.equal(ethStepped.next.eth[0]!.participants, 342);
assert.equal(ethStepped.next.eth[0]!.hash, hexOf(hashEthHeader(ethFields, bits342)));
assert.equal(ethStepped.next.ethPubkey, committee.aggregate);
assert.equal(ethStepped.next.ethCommittee, committee.committee);

const badSig = ethSig.slice(0, -1) + (ethSig.endsWith("a") ? "b" : "a");
const badSigIn = spec(born, ethEvidence(342, ethFields, badSig));
const badSigSite = run(born, badSigIn);
assert.equal(badSigSite.ok, false);
if (badSigSite.ok) throw new Error("bad eth sig");
assert.equal(badSigSite.error, "eth signature refused");

const badFields = { ...ethFields, stateRoot: "44".repeat(32) };
const badFieldIn = spec(born, ethEvidence(342, badFields, ethSig));
const badFieldSite = run(born, badFieldIn);
assert.equal(badFieldSite.ok, false);
if (badFieldSite.ok) throw new Error("bad eth field");
assert.equal(badFieldSite.error, "eth signature refused");

const quorumIn = spec(born, ethEvidence(341, ethFields, "11".repeat(96)));
const quorumSite = run(born, quorumIn);
assert.equal(quorumSite.ok, false);
if (quorumSite.ok) throw new Error("quorum");
assert.equal(quorumSite.error, "eth quorum not met");

const swappedIn = spec(born, ethEvidence(400));
const swappedSite = run(born, swappedIn);
assert.equal(swappedSite.ok, true);
if (!swappedSite.ok || !ethSite.ok) throw new Error("participants");
assert.equal(swappedSite.ok && swappedSite.omegaRoot !== ethSite.omegaRoot, true);
assert.notEqual(swappedSite.transitionRoot, ethSite.transitionRoot);
assert.notEqual(swappedSite.header, ethSite.header);

const forgedBits = ethEvidence(342);
const forgedHeader = forgedBits.eth[1];
if (forgedHeader?.op !== "header") throw new Error("forged bits");
forgedHeader.participation = hexOf(participationMask(400));
const forgedBitsIn = spec(born, forgedBits);
const forgedBitsSite = run(born, forgedBitsIn);
assert.equal(forgedBitsSite.ok, false);
if (forgedBitsSite.ok) throw new Error("forged bits");
assert.equal(forgedBitsSite.error, "eth signature refused");

const genesisBtcHash = parseBtcHeader(hexToBytes(BTC_GENESIS_HEADER_HEX)).hash;
function composedEvidence(headerHex: string): TransitionEvidence {
  return {
    ...blankEvidence(1),
    btc: [{ height: 0, headerHex }],
    eth: [
      { op: "bootstrap", committee: committee.committee, aggregate: committee.aggregate },
      { op: "header", ...ethFields, participation: hexOf(bits342), signature: ethSig },
    ],
    wasm: [{ method: "init", caller: miner }],
    stake: [provedDelegate()],
    settle: [{
      op: "lock",
      id: 4,
      asset: "btc",
      foreignRef: genesisBtcHash,
      from: payer.address,
      to: miner,
      amount: 10,
    }],
  };
}
const composeQuiet = cloneOmega(born);
composeQuiet.proposals.push({
  id: 9,
  title: "drop continuity",
  proposer: miner,
  deposit: 0,
  yes: 1,
  no: 0,
  abstain: 0,
  status: "passed",
  ballots: [],
  couplingKey: "continuity",
  couplingValue: 0,
});
const composeIn = spec(composeQuiet, composedEvidence(BTC_GENESIS_HEADER_HEX));
composeIn.transactions = [pay(0, 5, 1, other)];
const { wasmAfter: _composeIgnored, ...composeRest } = composeIn;
const composeStepped = await successor(composeQuiet, composeRest);
assert.equal(composeStepped.ok, true, composeStepped.ok ? "" : composeStepped.error);
if (!composeStepped.ok) throw new Error(composeStepped.error);
assert.equal(composeStepped.next.couplings.continuity, 0);
assert.equal(composeStepped.next.eth.length, 1);
assert.equal(composeStepped.next.btc.length, 1);
assert.equal(composeStepped.next.settlements.length, 1);
assert.equal(composeStepped.next.wasm.get("owner"), miner);
assert.notEqual(composeStepped.next.wasm.get("owner"), "999");
const composeSeal = sealFromSuccessor(composeQuiet, composeIn, composeStepped);
const composeSite = {
  ok: true as const,
  omegaRoot: composeStepped.omegaRoot,
  transitionRoot: composeSeal.transitionRoot,
  header: composeSeal.hash,
  stateRoot: composeStepped.stateRoot,
};

const loudIn = spec(born, composedEvidence(BTC_GENESIS_HEADER_HEX));
loudIn.transactions = [pay(0, 5, 1, other)];
const { wasmAfter: _loudIgnored, ...loudRest } = loudIn;
const loudStepped = await successor(born, loudRest);
assert.equal(loudStepped.ok, true, loudStepped.ok ? "" : loudStepped.error);
if (!loudStepped.ok) throw new Error(loudStepped.error);
assert.equal(loudStepped.next.couplings.continuity, 1);
const loudSeal = sealFromSuccessor(born, loudIn, loudStepped);
const loudSite = {
  ok: true as const,
  omegaRoot: loudStepped.omegaRoot,
  transitionRoot: loudSeal.transitionRoot,
  header: loudSeal.hash,
  stateRoot: loudStepped.stateRoot,
};
assert.notEqual(loudSite.omegaRoot, composeSite.omegaRoot);
assert.notEqual(loudSite.transitionRoot, composeSite.transitionRoot);
assert.notEqual(loudSite.header, composeSite.header);

const forgedComposeIn = spec(composeQuiet, composedEvidence(`${BTC_GENESIS_HEADER_HEX.slice(0, -1)}d`));
forgedComposeIn.transactions = [pay(0, 5, 1, other)];
const { wasmAfter: _forgedIgnored, ...forgedRest } = forgedComposeIn;
const forgedComposeStepped = await successor(composeQuiet, forgedRest);
assert.equal(forgedComposeStepped.ok, false);
if (forgedComposeStepped.ok) throw new Error("forged compose");
assert.equal(forgedComposeStepped.error, "btc proof of work refused");
const forgedComposeSite = { ok: false as const, error: forgedComposeStepped.error };

const proposeIn = spec(born, {
  ...blankEvidence(1),
  stake: [{
    op: "propose",
    proposer: miner,
    title: "drop continuity",
    deposit: 0,
    id: 11,
    couplingKey: "continuity",
    couplingValue: 0,
  }],
});
const proposeSite = run(born, proposeIn);
assert.equal(proposeSite.ok, true);
if (!proposeSite.ok) throw new Error("propose");
const proposeStepped = applySuccessor(born, proposeIn);
if (!proposeStepped.ok) throw new Error(proposeStepped.error);
assert.equal(proposeStepped.next.couplings.continuity, 1);
assert.equal(proposeStepped.next.proposals.find((p) => p.id === 11)?.status, "open");

const passOmega = cloneOmega(born);
passOmega.proposals.push({
  id: 12,
  title: "seat",
  proposer: miner,
  deposit: 0,
  yes: 0,
  no: 0,
  abstain: 0,
  status: "open",
  ballots: [],
});
const passIn = spec(passOmega, {
  ...blankEvidence(1),
  stake: [
    { op: "vote", voter: "6ea341f4f8d62cd427434c89d35d3fc6340a8bb1", id: 12, option: "yes" },
    { op: "vote", voter: "736d0217b01cdaec6288ced8ddb8be7435f711e0", id: 12, option: "yes" },
    { op: "vote", voter: "cec6a4f606263f462db50d853f599b758cede73b", id: 12, option: "yes" },
  ],
});
const passSite = run(passOmega, passIn);
assert.equal(passSite.ok, true);
if (!passSite.ok) throw new Error("pass");
const passStepped = applySuccessor(passOmega, passIn);
if (!passStepped.ok) throw new Error(passStepped.error);
assert.equal(passStepped.next.proposals.find((p) => p.id === 12)?.status, "passed");
assert.equal(passStepped.next.couplings.continuity, 1);

const doubleIn = spec(born, {
  ...blankEvidence(1),
  stake: [{ op: "slash", validator: "cec6a4f606263f462db50d853f599b758cede73b", reason: "double_sign" }],
});
const doubleSite = run(born, doubleIn);
assert.equal(doubleSite.ok, true);
if (!doubleSite.ok) throw new Error("double");
const doubleStepped = applySuccessor(born, doubleIn);
if (!doubleStepped.ok) throw new Error(doubleStepped.error);
assert.equal(doubleStepped.next.validators.get("cec6a4f606263f462db50d853f599b758cede73b")?.jailed, true);

const paid = applySuccessor(quiet, spec(quiet));
assert.equal(paid.ok, true);
if (!paid.ok) throw new Error(paid.error);
assert.ok((paid.next.validators.get(miner)?.accumulatedRewards ?? 0) > 0);
const claimPaidIn = spec(paid.next, {
  ...blankEvidence(1),
  stake: [{ op: "claim", address: miner }],
});
const claimPaidSite = run(paid.next, claimPaidIn);
assert.equal(claimPaidSite.ok, true);
if (!claimPaidSite.ok) throw new Error("claim paid");

async function executed(current: Omega, input: CanonicalInputs) {
  const { wasmAfter: _ignored, ...rest } = input;
  const stepped = await successor(current, rest);
  if (!stepped.ok) return { ok: false as const, error: stepped.error };
  const seal = sealFromSuccessor(current, input, stepped);
  return {
    ok: true as const,
    omegaRoot: stepped.omegaRoot,
    transitionRoot: seal.transitionRoot,
    header: seal.hash,
    stateRoot: stepped.stateRoot,
    next: stepped.next,
  };
}

const pauseIn = spec(wasmStepped.next, {
  ...blankEvidence(1),
  wasm: [{ method: "pause", caller: miner }],
});
const pauseRan = await executed(wasmStepped.next, pauseIn);
assert.equal(pauseRan.ok, true, pauseRan.ok ? "" : pauseRan.error);
if (!pauseRan.ok) throw new Error(pauseRan.error);
assert.equal(pauseRan.next.wasm.get("paused"), "1");
const pauseSite = pauseRan;

const unpauseIn = spec(pauseRan.next, {
  ...blankEvidence(1),
  wasm: [{ method: "unpause", caller: miner }],
});
const unpauseRan = await executed(pauseRan.next, unpauseIn);
assert.equal(unpauseRan.ok, true, unpauseRan.ok ? "" : unpauseRan.error);
if (!unpauseRan.ok) throw new Error(unpauseRan.error);
assert.equal(unpauseRan.next.wasm.get("paused"), "0");
const unpauseSite = unpauseRan;

const swapIn = spec(born);
swapIn.transactions = [pay(0, 200_000, 1, poolAddress("EQU-WBTC"))];
const swapSite = run(born, swapIn);
assert.equal(swapSite.ok, true);
if (!swapSite.ok || !txSite.ok) throw new Error("swap");
const swapStepped = applySuccessor(born, swapIn);
if (!swapStepped.ok) throw new Error(swapStepped.error);
const wbtc = swapStepped.next.pools.find((p) => p.id === "EQU-WBTC");
assert.ok(wbtc);
assert.equal(wbtc.reserveA, 10_200_000);
assert.equal(wbtc.reserveB, 99);
assert.equal(wbtc.txCount, 1);
assert.notEqual(swapSite.stateRoot, txSite.stateRoot);

const firstHash = hexOf(hashEthHeader(ethFields, bits342));
const extendFields = {
  slot: 8,
  proposerIndex: 3,
  parentRoot: firstHash,
  stateRoot: "55".repeat(32),
  bodyRoot: "66".repeat(32),
};
const extendIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    { op: "bootstrap", committee: committee.committee, aggregate: committee.aggregate },
    { op: "header", ...ethFields, participation: hexOf(bits342), signature: ethSig },
    { op: "header", ...extendFields, participation: hexOf(bits342), signature: hexOf(signSelected(committee.secrets, extendFields, bits342)) },
  ],
});
const extendSite = run(born, extendIn);
assert.equal(extendSite.ok, true);
if (!extendSite.ok || !ethSite.ok) throw new Error("extend");
const extendStepped = applySuccessor(born, extendIn);
if (!extendStepped.ok) throw new Error(extendStepped.error);
assert.equal(extendStepped.next.eth.length, 2);
assert.equal(extendStepped.next.eth[1]!.parentRoot, extendStepped.next.eth[0]!.hash);
assert.notEqual(extendSite.omegaRoot, ethSite.omegaRoot);

const nonceIn = spec(born);
nonceIn.nonce = 7n;
const nonceSite = run(born, nonceIn);
assert.equal(nonceSite.ok, true);
if (!nonceSite.ok) throw new Error("nonce");
const nonce6 = run(born, spec(born));
assert.equal(nonce6.ok, true);
if (!nonce6.ok) throw new Error("nonce6");
assert.notEqual(nonceSite.header, nonce6.header);
assert.notEqual(nonceSite.transitionRoot, nonce6.transitionRoot);

const pressureIn = spec(born);
pressureIn.committedPressure = 0.25;
const pressureSite = run(born, pressureIn);
assert.equal(pressureSite.ok, true);
if (!pressureSite.ok) throw new Error("pressure");
assert.notEqual(pressureSite.header, nonce6.header);

const timeIn = spec(born);
timeIn.timestamp = 1_700_000_100;
const timeSite = run(born, timeIn);
assert.equal(timeSite.ok, true);
if (!timeSite.ok) throw new Error("time");
assert.notEqual(timeSite.omegaRoot, nonce6.omegaRoot);

const difficultyIn = spec(born);
difficultyIn.difficulty = born.difficulty + 1;
const difficultySite = run(born, difficultyIn);
assert.equal(difficultySite.ok, false);
if (difficultySite.ok) throw new Error("difficulty");
assert.equal(difficultySite.error, "difficulty is not the next difficulty");

const minerIn = spec(born);
minerIn.miner = "00".repeat(20);
const minerSite = run(born, minerIn);
assert.equal(minerSite.ok, false);
if (minerSite.ok) throw new Error("stranger miner");
assert.equal(minerSite.error, "miner is not a live validator");

const ethLockIn = spec(ethStepped.next, {
  ...blankEvidence(1),
  settle: [{
    op: "lock",
    id: 8,
    asset: "eth",
    foreignRef: ethStepped.next.eth[0]!.hash,
    from: payer.address,
    to: miner,
    amount: 10,
  }],
});
const ethLockSite = run(ethStepped.next, ethLockIn);
assert.equal(ethLockSite.ok, true);
if (!ethLockSite.ok) throw new Error("eth lock");

const btcExtendIn = spec(btcStepped.next, {
  ...blankEvidence(1),
  btc: [{ height: 1, headerHex: BTC_GENESIS_HEADER_HEX }],
});
const btcExtendSite = run(btcStepped.next, btcExtendIn);
assert.equal(btcExtendSite.ok, false);
if (btcExtendSite.ok) throw new Error("btc extend");
assert.equal(btcExtendSite.error, "btc prev does not match the tip");

const badParent = { ...extendFields, parentRoot: "00".repeat(32) };
const ethParentIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    { op: "bootstrap", committee: committee.committee, aggregate: committee.aggregate },
    { op: "header", ...ethFields, participation: hexOf(bits342), signature: ethSig },
    { op: "header", ...badParent, participation: hexOf(bits342), signature: hexOf(signSelected(committee.secrets, badParent, bits342)) },
  ],
});
const ethParentSite = run(born, ethParentIn);
assert.equal(ethParentSite.ok, false);
if (ethParentSite.ok) throw new Error("eth parent");
assert.equal(ethParentSite.error, "eth parent does not match the tip");

const mismatchIn = spec(modelStepped.next, {
  ...blankEvidence(1),
  cognition: [{ kind: "model", ...modelClaim, supportHash: "cd".repeat(32), proof: modelBinding(1, { ...modelClaim, supportHash: "cd".repeat(32) }) }],
});
const mismatchSite = run(modelStepped.next, mismatchIn);
assert.equal(mismatchSite.ok, false);
if (mismatchSite.ok) throw new Error("model mismatch");
assert.equal(mismatchSite.error, "model claim does not match the registry");

function flipHex(hex: string): string {
  const tail = hex.slice(-2) === "00" ? "01" : "00";
  return hex.slice(0, -2) + tail;
}

const wrongAgg = flipHex(committee.aggregate);
const wrongIn = spec(born, {
  ...blankEvidence(1),
  eth: [{ op: "bootstrap", committee: committee.committee, aggregate: wrongAgg }],
});
const wrongSite = run(born, wrongIn);
assert.equal(wrongSite.ok, false);
if (wrongSite.ok) throw new Error("wrong aggregate");
assert.equal(wrongSite.error, "eth aggregate is not the committee");

const permRaw = new Uint8Array(committee.raw);
const permFirst = permRaw.slice(0, 48);
permRaw.set(permRaw.subarray(48, 96), 0);
permRaw.set(permFirst, 48);
const permHex = hexOf(permRaw);
const permAggregate = committeeAggregate(permHex);
if (!permAggregate) throw new Error("permuted committee");
assert.equal(permAggregate, committee.aggregate);
const permIn = spec(born, {
  ...blankEvidence(1),
  eth: [{ op: "bootstrap", committee: permHex, aggregate: permAggregate }],
});
const permSite = run(born, permIn);
assert.equal(permSite.ok, true);
if (!permSite.ok) throw new Error("perm");
const plainBoot = run(born, {
  ...spec(born),
  evidence: { ...blankEvidence(1), eth: [ethBoot] },
});
assert.equal(plainBoot.ok, true);
if (!plainBoot.ok) throw new Error("plain boot");
assert.notEqual(permSite.omegaRoot, plainBoot.omegaRoot);

const extraIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    ethBoot,
    { op: "header", ...ethFields, participation: hexOf(participationMask(343)), signature: ethSig },
  ],
});
const extraSite = run(born, extraIn);
assert.equal(extraSite.ok, false);
if (extraSite.ok) throw new Error("extra bit");
assert.equal(extraSite.error, "eth signature refused");

const replacedRaw = new Uint8Array(committee.raw);
replacedRaw.set(otherCommittee.raw.subarray(0, 48), 0);
const replacedHex = hexOf(replacedRaw);
const replacedAgg = committeeAggregate(replacedHex);
if (!replacedAgg) throw new Error("replaced committee");
assert.notEqual(replacedAgg, committee.aggregate);
const replacedSecrets = committee.secrets.map((secret) => new Uint8Array(secret));
replacedSecrets[0] = otherCommittee.secrets[0]!;
const replacedSig = hexOf(signSelected(replacedSecrets, ethFields, bits342));
const replacedOldIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    { op: "bootstrap", committee: replacedHex, aggregate: replacedAgg },
    { op: "header", ...ethFields, participation: hexOf(bits342), signature: ethSig },
  ],
});
const replacedOldSite = run(born, replacedOldIn);
assert.equal(replacedOldSite.ok, false);
if (replacedOldSite.ok) throw new Error("replaced old");
assert.equal(replacedOldSite.error, "eth signature refused");
const replacedIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    { op: "bootstrap", committee: replacedHex, aggregate: replacedAgg },
    { op: "header", ...ethFields, participation: hexOf(bits342), signature: replacedSig },
  ],
});
const replacedSite = run(born, replacedIn);
assert.equal(replacedSite.ok, true);
if (!replacedSite.ok) throw new Error("replaced");

const rotSig = hexOf(signRotation(committee.secrets, bits342, otherCommittee.raw));
const rotateIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    ethBoot,
    {
      op: "rotate",
      committee: otherCommittee.committee,
      aggregate: otherCommittee.aggregate,
      participation: hexOf(bits342),
      signature: rotSig,
    },
  ],
});
const rotateSite = run(born, rotateIn);
assert.equal(rotateSite.ok, true);
if (!rotateSite.ok) throw new Error("rotate");
const rotateStepped = applySuccessor(born, rotateIn);
if (!rotateStepped.ok) throw new Error(rotateStepped.error);
assert.equal(rotateStepped.next.ethCommittee, otherCommittee.committee);
assert.equal(rotateStepped.next.ethPubkey, otherCommittee.aggregate);
const rotateWrongIn = spec(born, {
  ...blankEvidence(1),
  eth: [
    ethBoot,
    {
      op: "rotate",
      committee: otherCommittee.committee,
      aggregate: flipHex(otherCommittee.aggregate),
      participation: hexOf(bits342),
      signature: rotSig,
    },
  ],
});
const rotateWrongSite = run(born, rotateWrongIn);
assert.equal(rotateWrongSite.ok, false);
if (rotateWrongSite.ok) throw new Error("rotate wrong");
assert.equal(rotateWrongSite.error, "eth aggregate is not the committee");

const surviveFields = {
  slot: 8,
  proposerIndex: 3,
  parentRoot: ethStepped.next.eth[0]!.hash,
  stateRoot: "77".repeat(32),
  bodyRoot: "88".repeat(32),
};
const surviveIn = spec(ethStepped.next, {
  ...blankEvidence(1),
  eth: [{
    op: "header" as const,
    ...surviveFields,
    participation: hexOf(bits342),
    signature: hexOf(signSelected(committee.secrets, surviveFields, bits342)),
  }],
});
const surviveSite = run(ethStepped.next, surviveIn);
assert.equal(surviveSite.ok, true);
if (!surviveSite.ok) throw new Error("survive");
const surviveStepped = applySuccessor(ethStepped.next, surviveIn);
if (!surviveStepped.ok) throw new Error(surviveStepped.error);
assert.equal(surviveStepped.next.ethCommittee, committee.committee);
assert.equal(surviveStepped.next.eth.length, 2);

const cases = [
  pack("tx-pay", born, txIn, txSite, 1),
  pack("tx-altered", born, alteredIn, alteredSite),
  pack("tx-other", born, otherIn, otherSite),
  pack("tx-order", born, orderIn, orderSite),
  pack("stake-vote", voteOmega, voteIn, voteSite),
  pack("stake-stranger", voteOmega, strangerIn, strangerSite),
  pack("stake-delegate", born, delegateIn, delegateSite),
  pack("stake-slash", born, slashIn, slashSite),
  pack("stake-claim", born, claimIn, claimSite),
  pack("wasm-pause", wasmOmega, wasmSpec, wasmSite),
  pack("btc-genesis", born, btcIn, btcSite),
  pack("btc-forged", born, forgedIn, forgedSite),
  pack("model", born, modelIn, modelSite),
  pack("model-forged", born, badModelIn, badModelSite),
  pack("bind", quiet, bindIn, bindSite),
  pack("challenge", modelStepped.next, challengeIn, challengeSite),
  pack("settle-lock", btcStepped.next, lockIn, lockSite),
  pack("settle-release", lockStepped.next, releaseIn, releaseSite),
  pack("eth-header", born, ethIn, ethSite),
  pack("eth-bad-sig", born, badSigIn, badSigSite),
  pack("eth-bad-field", born, badFieldIn, badFieldSite),
  pack("eth-quorum", born, quorumIn, quorumSite),
  pack("eth-participants", born, swappedIn, swappedSite),
  pack("eth-forged-bits", born, forgedBitsIn, forgedBitsSite),
  pack("compose", composeQuiet, composeIn, composeSite),
  pack("compose-loud", born, loudIn, loudSite),
  pack("compose-forged", composeQuiet, forgedComposeIn, forgedComposeSite),
  pack("stake-propose", born, proposeIn, proposeSite),
  pack("stake-pass", passOmega, passIn, passSite),
  pack("stake-double", born, doubleIn, doubleSite),
  pack("stake-claim-paid", paid.next, claimPaidIn, claimPaidSite),
  pack("wasm-pause-call", wasmStepped.next, pauseIn, pauseSite),
  pack("wasm-unpause", pauseRan.next, unpauseIn, unpauseSite),
  pack("tx-swap", born, swapIn, swapSite),
  pack("eth-extend", born, extendIn, extendSite),
  pack("scalar-nonce", born, nonceIn, nonceSite),
  pack("scalar-pressure", born, pressureIn, pressureSite),
  pack("scalar-time", born, timeIn, timeSite),
  pack("difficulty-refused", born, difficultyIn, difficultySite),
  pack("miner-stranger", born, minerIn, minerSite),
  pack("settle-eth", ethStepped.next, ethLockIn, ethLockSite),
  pack("btc-extend-refused", btcStepped.next, btcExtendIn, btcExtendSite),
  pack("eth-parent", born, ethParentIn, ethParentSite),
  pack("model-mismatch", modelStepped.next, mismatchIn, mismatchSite),
  pack("eth-wrong-aggregate", born, wrongIn, wrongSite),
  pack("eth-perm", born, permIn, permSite),
  pack("eth-extra-bit", born, extraIn, extraSite),
  pack("eth-replaced-old", born, replacedOldIn, replacedOldSite),
  pack("eth-replaced", born, replacedIn, replacedSite),
  pack("eth-rotate", born, rotateIn, rotateSite),
  pack("eth-rotate-wrong", born, rotateWrongIn, rotateWrongSite),
  pack("eth-survive", ethStepped.next, surviveIn, surviveSite),
];

const oracle = join(tmpdir(), "eq-membrane-oracle.json");
writeFileSync(oracle, jsonText({ cases }));
const rust = execFileSync(
  "cargo",
  ["test", "--manifest-path", join(repo, "equilibrium/Cargo.toml"), "--lib", "--", "--nocapture", "native_successor_expands_the_input"],
  { encoding: "utf8", env: { ...process.env, EQ_MEMBRANE_ORACLE: oracle } },
);
assert.match(rust, /membrane: rows 52/);
assert.match(rust, /native_successor_expands_the_input \.\.\. ok/);
assert.match(rust, /membrane: signature refused/);
assert.match(rust, /membrane: wasm executed/);
assert.match(rust, /membrane: btc admitted/);
assert.match(rust, /membrane: eth admitted/);
assert.match(rust, /membrane: eth signature refused/);
assert.match(rust, /membrane: composed/);

console.log(JSON.stringify({
  ok: true,
  rows: cases.length,
  txMoved: txSite.ok && otherSite.ok && txSite.omegaRoot !== otherSite.omegaRoot,
  ethMoved: ethSite.ok && swappedSite.ok && ethSite.omegaRoot !== swappedSite.omegaRoot,
  composeMoved: composeSite.omegaRoot !== loudSite.omegaRoot,
  wasmOwner: composeStepped.ok ? composeStepped.next.wasm.get("owner") ?? null : null,
  level: "S6 is closed on the mainnet surface this file enumerates: native derives Ω′ from Ω and I, and the listed refusals match. Ethereum participants are the popcount of the signed participation bitset. The committee is 512 keys; the aggregate is derived from those keys; a header verifies the aggregate of the keys the bitset selects; rotation installs the next committee only when that aggregate matches. Block nonce is a u64 bigint through the transition digest and the header. 2^53 and 2^53+1 stay distinct, and the nonce-6 fingerprint is still 201100202523998. Outside that surface: this is not Ethereum mainnet's sync-committee keys, no valid second Bitcoin header was available, other networks were not run, Android was not executed, S7 is the normalized digest 4743ee74f910f0f34d94457956aebcc8288a0bde3e531a4a7798f43f223a6a8f of this source and not of a later commit, and this is not a proof about every byte string. Admission remains the named binary64 fingerprint.",
}));
