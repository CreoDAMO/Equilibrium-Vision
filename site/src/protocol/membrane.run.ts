/**
 * S6 input expansion. Site applies the successor. Native applies the same
 * pre-state and I. A caller-supplied Ω′ is not an input.
 * Ethereum header signatures are not this file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BTC_GENESIS_HEADER_HEX } from "./btc";
import {
  applySuccessor,
  cloneOmega,
  initialOmega,
  openedCouplings,
  successor,
  type CanonicalInputs,
  type Omega,
} from "./constitution";
import { canonicalEvidence } from "./evidence";
import { activityKeys, minerKey } from "./genesis";
import { challengeBinding, modelBinding, residualBinding } from "./membranes";
import { blankEvidence, sealFromSuccessor } from "./seal";
import type { TransitionEvidence, TxRecord } from "./types";
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
    nonce: 6,
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
    eth: current.eth.map((h) => ({ ...h })),
    wasm: [...current.wasm.entries()],
    validators: [...current.validators.values()].map((v) => ({ ...v })),
    delegations: current.delegations.map((d) => ({ ...d })),
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
assert.equal(delegateSite.ok, true);

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
];

const oracle = join(tmpdir(), "eq-membrane-oracle.json");
writeFileSync(oracle, JSON.stringify({ cases }));
const rust = execFileSync(
  "cargo",
  ["test", "--manifest-path", join(repo, "equilibrium/Cargo.toml"), "--lib", "--", "--nocapture", "native_successor_expands_the_input"],
  { encoding: "utf8", env: { ...process.env, EQ_MEMBRANE_ORACLE: oracle } },
);
assert.match(rust, /membrane: rows 18/);
assert.match(rust, /native_successor_expands_the_input \.\.\. ok/);
assert.match(rust, /membrane: signature refused/);
assert.match(rust, /membrane: wasm executed/);
assert.match(rust, /membrane: btc admitted/);

console.log(JSON.stringify({
  ok: true,
  rows: cases.length,
  txMoved: txSite.ok && otherSite.ok && txSite.omegaRoot !== otherSite.omegaRoot,
  wasmPaused: wasmStepped.ok ? wasmStepped.next.wasm.get("owner") ?? null : null,
  level: "A for signed transfers, stake, canonical wasm, a bitcoin header, a model, a bind, a challenge, and settlement, each derived from the pre-state and I. Not A for an Ethereum signature, every remaining input, or Android.",
}));
