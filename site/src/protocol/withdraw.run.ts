/**
 * A signed withdrawal locks EQU, then settles only when a Bitcoin output matches it.
 * Ethereum execution is refused. lock/release still pays an internal recipient.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "./bytes";
import { buildP2pkhTx, parseBtcTx, sha256d } from "./btc";
import {
  WITHDRAWAL_ESCROW,
  signAuthority,
  signWithdraw,
  verifyWithdrawEvidence,
  withdrawPreimage,
  withdrawalCommitment,
  withdrawalId,
} from "./authority";
import { applySuccessor, cloneOmega, initialOmega, omegaDigest, openedCouplings, stateRootOf, type Omega, type Successor } from "./constitution";
import { canonicalEvidence } from "./evidence";
import { NETWORKS } from "./networks";
import { blankEvidence } from "./seal";
import type { TransitionEvidence, WithdrawalEvidence } from "./types";
import { keypairFromSeed, signTx } from "./wallet";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const born = initialOmega("mainnet");
const chainId = born.chainId;
const payer = keypairFromSeed("eq-withdraw-lifecycle-v1");
const other = keypairFromSeed("eq-withdraw-lifecycle-other");
const live = [...born.validators.values()].filter((v) => !v.jailed && !v.slashed && v.bondedStake > 0);
const miner = live[0]?.address;
if (!miner) throw new Error("need a miner");
assert.equal(NETWORKS.mainnet.withdrawalTimeout, 10);
assert.equal(NETWORKS.testnet.withdrawalTimeout, 10);
assert.equal(canonicalEvidence(blankEvidence(chainId)).split("|").length, 7);
assert.equal(omegaDigest(born), omegaDigest(cloneOmega(born)));

const hash160 = "cd".repeat(20);
const destination = `p2pkh:${hash160}`;
const raw = buildP2pkhTx(1000, hash160);
if (!raw) throw new Error("tx");
const parsed = parseBtcTx(raw);
if (!parsed || parsed.outputs[0]?.destination !== destination || parsed.outputs[0]?.value !== 1000) {
  throw new Error("p2pkh output was not derived");
}
const headerHash = "22".repeat(32);

const witness = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
  ...new Array(32).fill(0),
  0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff,
  0x01, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x16, 0x00, 0x14, ...new Array(20).fill(0xcd),
  0x01, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
const witnessParsed = parseBtcTx(witness);
assert.equal(witnessParsed?.outputs[0]?.destination, `p2wpkh:${"cd".repeat(20)}`);
assert.equal(witnessParsed?.outputs[0]?.value, 1000);
assert.notEqual(witnessParsed?.txid, bytesToHex(sha256d(witness)));

const opreturn = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x01,
  ...new Array(32).fill(0),
  0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff,
  0x01, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x6a,
  0x00, 0x00, 0x00, 0x00,
]);
assert.equal(parseBtcTx(opreturn)?.outputs[0]?.destination, null);

const proof = signWithdraw(payer, { chainId, amount: 1000, network: "btc", asset: "btc", destination, nonce: 0 });
const claim = { chainId, sender: payer.address, amount: 1000, network: "btc" as const, asset: "btc", destination, nonce: 0 };
assert.equal(proof.id, withdrawalId(claim));
assert.equal(withdrawPreimage(claim).includes("|withdraw|"), true);
assert.notEqual(withdrawPreimage(claim), withdrawalCommitment(claim));

const delegate = signAuthority(payer, { op: "delegate", chainId, validator: miner, amount: 1000 });
const unbond = signAuthority(payer, { op: "unbond", chainId, validator: miner, amount: 1000 });
const transfer = signTx(payer, { to: other.address, amount: 1000, fee: 1, nonce: 0, chainId });
for (const signature of [delegate.signature, unbond.signature, transfer.signature]) {
  assert.equal(verifyWithdrawEvidence(chainId, { ...claim, publicKey: payer.publicKey, signature }), "withdraw authority refused");
}
const eth = signWithdraw(payer, { chainId, amount: 1000, network: "eth", asset: "eth", destination, nonce: 1 });

function evidence(withdraw: WithdrawalEvidence[]): TransitionEvidence {
  return { ...blankEvidence(chainId), withdraw };
}

function base(): Omega {
  const omega = cloneOmega(born);
  omega.height = 0;
  omega.tipTimestamp = 1_700_000_000;
  omega.ledger.set(payer.address, { balance: 5000, nonce: 0 });
  omega.btc.push({ hash: headerHash, height: 1, prevHash: "00".repeat(32), merkleRoot: parsed.txid, bits: 1 });
  return omega;
}

function step(current: Omega, withdraw: WithdrawalEvidence[] = [], settle: TransitionEvidence["settle"] = []) {
  const before = omegaDigest(current);
  const result = applySuccessor(current, {
    transactions: [],
    evidence: { ...evidence(withdraw), settle },
    timestamp: current.tipTimestamp + 1,
    nonce: 6n,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
    wasmAfter: null,
  });
  assert.equal(omegaDigest(current), before);
  return result;
}

function must(result: Successor): Extract<Successor, { ok: true }> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

const openOp: WithdrawalEvidence = {
  op: "open",
  sender: payer.address,
  amount: 1000,
  network: "btc",
  asset: "btc",
  destination,
  nonce: 0,
  publicKey: proof.publicKey,
  signature: proof.signature,
};
const settleOp: WithdrawalEvidence = {
  op: "settle",
  id: proof.id,
  rawTx: bytesToHex(raw),
  vout: 0,
  headerHash,
  merkle: [],
};
const openLine = `o:${payer.address}:1000:btc:btc:${destination}:0:${proof.publicKey}:${proof.signature}`;
assert.equal(canonicalEvidence(evidence([openOp])).endsWith(`|||${openLine}`), true);

const opened = must(step(base(), [openOp]));
assert.equal(opened.next.withdrawals.length, 1);
assert.equal(opened.next.withdrawals[0]?.id, proof.id);
assert.equal(opened.next.withdrawals[0]?.status, "locked");
assert.equal(opened.next.withdrawals[0]?.createdHeight, 0);
assert.equal(opened.next.withdrawals[0]?.expiryHeight, 10);
assert.equal(opened.next.withdrawals[0]?.effectLocator, null);
assert.equal(opened.next.ledger.get(payer.address)?.balance, 4000);
assert.equal(opened.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 1000);
assert.equal(opened.next.ledger.get(other.address)?.balance, undefined);
const stripped = cloneOmega(opened.next);
stripped.withdrawals = [];
assert.equal(stateRootOf(opened.next), stateRootOf(stripped));
assert.notEqual(omegaDigest(opened.next), omegaDigest(stripped));

const again = step(opened.next, [openOp]);
assert.equal(again.ok, false);
if (again.ok) throw new Error("second open");
assert.equal(again.error, "withdrawal exists");

const settled = must(step(opened.next, [settleOp]));
assert.equal(settled.next.withdrawals[0]?.status, "settled");
assert.equal(settled.next.withdrawals[0]?.effectLocator, `${parsed.txid}:0`);
assert.equal(settled.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 0);
assert.equal(settled.next.ledger.get(payer.address)?.balance, 4000);
assert.equal(settled.next.ledger.get(other.address)?.balance, undefined);
const replay = step(settled.next, [settleOp]);
assert.equal(replay.ok, false);
if (replay.ok) throw new Error("replay");
assert.equal(replay.error, "withdrawal is not locked");

const second = signWithdraw(payer, { chainId, amount: 1000, network: "btc", asset: "btc", destination, nonce: 2 });
const secondOpen: WithdrawalEvidence = { ...openOp, nonce: 2, publicKey: second.publicKey, signature: second.signature };
const both = must(step(settled.next, [secondOpen]));
const claimed = step(both.next, [{ ...settleOp, id: second.id }]);
assert.equal(claimed.ok, false);
if (claimed.ok) throw new Error("locator");
assert.equal(claimed.error, "effect already settled");
assert.equal(both.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 1000);

const wrongAmount = signWithdraw(payer, { chainId, amount: 1001, network: "btc", asset: "btc", destination, nonce: 3 });
const mismatched = must(step(base(), [{
  ...openOp,
  amount: 1001,
  nonce: 3,
  publicKey: wrongAmount.publicKey,
  signature: wrongAmount.signature,
}]));
const bound = step(mismatched.next, [{ ...settleOp, id: wrongAmount.id }]);
assert.equal(bound.ok, false);
if (bound.ok) throw new Error("binding");
assert.equal(bound.error, "withdrawal binding refused");
assert.equal(mismatched.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 1001);

const unknown = must(step(base(), [openOp]));
const script = step(unknown.next, [{ ...settleOp, rawTx: bytesToHex(opreturn) }]);
assert.equal(script.ok, false);
if (script.ok) throw new Error("script");
assert.equal(script.error, "btc script refused");

const merkle = step(unknown.next, [{ ...settleOp, merkle: ["11".repeat(32)] }]);
assert.equal(merkle.ok, false);
if (merkle.ok) throw new Error("merkle");
assert.equal(merkle.error, "btc merkle refused");

const ethStep = step(base(), [{
  op: "open",
  sender: payer.address,
  amount: 1000,
  network: "eth",
  asset: "eth",
  destination,
  nonce: 1,
  publicKey: eth.publicKey,
  signature: eth.signature,
}]);
assert.equal(ethStep.ok, false);
if (ethStep.ok) throw new Error("eth");
assert.equal(ethStep.error, "eth execution proof refused");
assert.equal(base().ledger.get(payer.address)?.balance, 5000);

let cursor = must(step(base(), [openOp])).next;
let refundedAt = 0;
for (let i = 0; i < 12 && cursor.withdrawals[0]?.status === "locked"; i += 1) {
  const late = step(cursor, [settleOp]);
  if (cursor.height + 1 >= 10) {
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.error, "withdrawal expired");
  }
  cursor = must(step(cursor)).next;
  if (cursor.withdrawals[0]?.status === "refunded") refundedAt = cursor.height;
}
assert.equal(refundedAt, 10);
assert.equal(cursor.withdrawals[0]?.status, "refunded");
assert.equal(cursor.ledger.get(payer.address)?.balance, 5000);
assert.equal(cursor.ledger.get(WITHDRAWAL_ESCROW)?.balance, 0);
const twice = must(step(cursor));
assert.equal(twice.next.ledger.get(payer.address)?.balance, 5000);

const escrowed = base();
const locked = must(step(escrowed, [], [{
  op: "lock",
  id: 7,
  asset: "btc",
  foreignRef: headerHash,
  from: payer.address,
  to: other.address,
  amount: 25,
}]));
assert.equal(locked.next.ledger.get(payer.address)?.balance, 4975);
assert.equal(locked.next.ledger.get(other.address)?.balance, undefined);
assert.equal(locked.next.withdrawals.length, 0);
const released = must(step(locked.next, [], [{ op: "release", id: 7 }]));
assert.equal(released.next.settlements[0]?.status, "settled");
assert.equal(released.next.ledger.get(other.address)?.balance, 25);
assert.equal(released.next.ledger.get(payer.address)?.balance, 4975);
assert.equal(released.next.withdrawals.length, 0);

const oracle = {
  wasmCode: blankEvidence(chainId).wasmCode,
  chainId,
  sender: payer.address,
  publicKey: proof.publicKey,
  signature: proof.signature,
  delegateSignature: delegate.signature,
  transferSignature: transfer.signature,
  ethSignature: eth.signature,
  amount: 1000,
  destination,
  nonce: 0,
  id: proof.id,
  preimage: withdrawPreimage(claim),
  evidence: canonicalEvidence(evidence([openOp])),
  rawTx: bytesToHex(raw),
  txid: parsed.txid,
  headerHash,
  locator: `${parsed.txid}:0`,
  opreturn: bytesToHex(opreturn),
};
const path = join(tmpdir(), "eq-withdraw-oracle.json");
writeFileSync(path, JSON.stringify(oracle));
const rust = execFileSync(
  "cargo",
  ["test", "--manifest-path", join(repo, "equilibrium/Cargo.toml"), "--lib", "--", "--nocapture", "withdraw_lifecycle_tests"],
  { encoding: "utf8", env: { ...process.env, EQ_WITHDRAW_ORACLE: path } },
);
assert.match(rust, /withdraw_settles_a_bitcoin_output_and_refunds_the_lock \.\.\. ok/);
assert.match(rust, /withdraw-oracle: settled/);

console.log(JSON.stringify({
  ok: true,
  id: proof.id,
  escrow: WITHDRAWAL_ESCROW,
  settled: settled.next.withdrawals[0]?.effectLocator,
  refundedAt,
  senderAfterSettle: 4000,
  senderAfterRefund: 5000,
  eth: "refused",
}));
