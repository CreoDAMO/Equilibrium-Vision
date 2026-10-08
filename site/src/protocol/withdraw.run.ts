/**
 * A signed withdrawal locks EQU, then settles only when the external effect matches it.
 * Bitcoin settles from an output under an admitted header.
 * Ethereum settles from a receipt under an admitted execution header.
 * An EQU beacon header is not that header. lock/release still pays an internal recipient.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "./bytes";
import { buildP2pkhTx, parseBtcTx, sha256d } from "./btc";
import {
  executionHeader,
  keccak256Hex,
  legacyReceipt,
  parseExecutionHeader,
  rlpEncode,
  rlpUint,
  rlpUintBytes,
  secureLeaf,
  TRANSFER_TOPIC,
} from "./eth-exec";
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
assert.equal(keccak256Hex(new Uint8Array()), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
assert.equal(keccak256Hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
assert.equal(keccak256Hex(Uint8Array.of(0x80)), "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
assert.equal(keccak256Hex(Uint8Array.of(0xc0)), "1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347");
assert.equal(keccak256Hex("Transfer(address,address,uint256)"), TRANSFER_TOPIC);

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
assert.equal(ethStep.error, "withdrawal destination refused");
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

function abiUint(amount: number): Uint8Array {
  const data = new Uint8Array(32);
  let n = amount;
  for (let i = 31; n > 0 && i >= 0; i -= 1) {
    data[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return data;
}

const token = "ab".repeat(20);
const recipient = "ef".repeat(20);
const ethDestination = `eth:${recipient}`;
const tokenReceipt = legacyReceipt({
  status: 1,
  cumulativeGas: 21_000,
  logs: [{
    address: token,
    topics: [TRANSFER_TOPIC, "00".repeat(32), `${"00".repeat(12)}${recipient}`],
    data: abiUint(1000),
  }],
});
const tokenLeaf = secureLeaf(rlpUint(0), tokenReceipt);
const tokenHeader = executionHeader({
  parentHash: new Uint8Array(32),
  transactionsRoot: new Uint8Array(32),
  receiptsRoot: tokenLeaf.root,
  number: 1,
});
const tokenParsed = parseExecutionHeader(tokenHeader);
if (!tokenParsed) throw new Error("execution header");
const tokenProof = signWithdraw(payer, {
  chainId, amount: 1000, network: "eth", asset: token, destination: ethDestination, nonce: 4,
});
const tokenOpen: WithdrawalEvidence = {
  op: "open",
  sender: payer.address,
  amount: 1000,
  network: "eth",
  asset: token,
  destination: ethDestination,
  nonce: 4,
  publicKey: tokenProof.publicKey,
  signature: tokenProof.signature,
};
const tokenExec: WithdrawalEvidence = { op: "exec", headerRlp: bytesToHex(tokenHeader) };
const tokenSettle: WithdrawalEvidence = {
  op: "settleEth",
  id: tokenProof.id,
  blockHash: tokenParsed.hash,
  txIndex: 0,
  receiptRlp: bytesToHex(tokenReceipt),
  receiptProof: tokenLeaf.proof.map((node) => bytesToHex(node)),
  logIndex: 0,
  txRlp: "",
  txProof: [],
};
const tokenOpenLine = `o:${payer.address}:1000:eth:${token}:${ethDestination}:4:${tokenProof.publicKey}:${tokenProof.signature}`;
const tokenSettleLine = `e:${tokenProof.id}:${tokenParsed.hash}:0:${bytesToHex(tokenReceipt)}:${tokenSettle.op === "settleEth" ? tokenSettle.receiptProof.join(",") : ""}:0::`;
assert.equal(canonicalEvidence(evidence([tokenOpen])).endsWith(`|||${tokenOpenLine}`), true);
assert.equal(canonicalEvidence(evidence([tokenExec, tokenSettle])).endsWith(`|||x:${bytesToHex(tokenHeader)};${tokenSettleLine}`), true);

const admitted = must(step(base(), [tokenExec]));
assert.equal(admitted.next.ethExecution[0]?.hash, tokenParsed.hash);
assert.equal(admitted.next.ethExecution[0]?.receiptsRoot, tokenParsed.receiptsRoot);
assert.equal(admitted.next.ledger.get(payer.address)?.balance, 5000);
const strippedExecution = cloneOmega(admitted.next);
strippedExecution.ethExecution = [];
assert.equal(stateRootOf(admitted.next), stateRootOf(strippedExecution));
assert.notEqual(omegaDigest(admitted.next), omegaDigest(strippedExecution));
const duplicate = step(admitted.next, [tokenExec]);
assert.equal(duplicate.ok, false);
if (duplicate.ok) throw new Error("duplicate header");
assert.equal(duplicate.error, "eth header exists");
const badParent = executionHeader({
  parentHash: new Uint8Array(32).fill(0x11),
  transactionsRoot: tokenLeaf.root,
  receiptsRoot: tokenLeaf.root,
  number: tokenParsed.number + 1,
});
const badParentStep = step(admitted.next, [{ op: "exec", headerRlp: bytesToHex(badParent) }]);
assert.equal(badParentStep.ok, false);
if (badParentStep.ok) throw new Error("bad parent");
assert.equal(badParentStep.error, "eth parent does not match the tip");
const wrongNumber = executionHeader({
  parentHash: hexToBytes(tokenParsed.hash),
  transactionsRoot: tokenLeaf.root,
  receiptsRoot: tokenLeaf.root,
  number: tokenParsed.number + 2,
});
const wrongNumberStep = step(admitted.next, [{ op: "exec", headerRlp: bytesToHex(wrongNumber) }]);
assert.equal(wrongNumberStep.ok, false);
if (wrongNumberStep.ok) throw new Error("number");
assert.equal(wrongNumberStep.error, "eth number does not extend the tip");
const child = executionHeader({
  parentHash: hexToBytes(tokenParsed.hash),
  transactionsRoot: tokenLeaf.root,
  receiptsRoot: tokenLeaf.root,
  number: tokenParsed.number + 1,
});
const extended = must(step(admitted.next, [{ op: "exec", headerRlp: bytesToHex(child) }]));
assert.equal(extended.next.ethExecution.length, 2);
assert.equal(extended.next.ethExecution[1]?.parentHash, tokenParsed.hash);

const decoy = "44".repeat(32);
const beaconed = base();
beaconed.eth.push({
  slot: 1,
  hash: decoy,
  parentRoot: "00".repeat(32),
  stateRoot: "00".repeat(32),
  bodyRoot: tokenParsed.receiptsRoot,
  participants: 342,
  participation: "ff".repeat(32),
});
const beaconOpen = must(step(beaconed, [tokenOpen]));
assert.equal(beaconOpen.next.ledger.get(payer.address)?.balance, 4000);
assert.equal(beaconOpen.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 1000);
assert.equal(beaconOpen.next.ledger.get(recipient)?.balance, undefined);
const beaconSettle = step(beaconOpen.next, [{ ...tokenSettle, blockHash: decoy }]);
assert.equal(beaconSettle.ok, false);
if (beaconSettle.ok) throw new Error("beacon");
assert.equal(beaconSettle.error, "eth header is not in Ω");
const btcShaped = step(beaconOpen.next, [{ ...settleOp, id: tokenProof.id }]);
assert.equal(btcShaped.ok, false);
if (btcShaped.ok) throw new Error("btc shaped");
assert.equal(btcShaped.error, "eth execution proof refused");
assert.equal(beaconOpen.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 1000);

const tokenLocked = must(step(must(step(base(), [tokenOpen])).next, [tokenExec]));
const tokenSettled = must(step(tokenLocked.next, [tokenSettle]));
assert.equal(tokenSettled.next.withdrawals[0]?.status, "settled");
assert.equal(tokenSettled.next.withdrawals[0]?.effectLocator, `${tokenParsed.hash}:0:0`);
assert.equal(tokenSettled.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 0);
assert.equal(tokenSettled.next.ledger.get(payer.address)?.balance, 4000);
assert.equal(tokenSettled.next.ledger.get(recipient)?.balance, undefined);
assert.equal(tokenSettled.next.ledger.get(ethDestination)?.balance, undefined);
const tokenReplay = step(tokenSettled.next, [tokenSettle]);
assert.equal(tokenReplay.ok, false);
if (tokenReplay.ok) throw new Error("eth replay");
assert.equal(tokenReplay.error, "withdrawal is not locked");
const tampered = tokenLeaf.proof.map((node) => bytesToHex(node));
tampered[0] = `${tampered[0]!.slice(0, -2)}00`;
const tamperStep = step(tokenLocked.next, [{ ...tokenSettle, receiptProof: tampered }]);
assert.equal(tamperStep.ok, false);
if (tamperStep.ok) throw new Error("tamper");
assert.equal(tamperStep.error, "eth trie refused");
assert.equal(tokenLocked.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 1000);
const ethWrongAmount = signWithdraw(payer, {
  chainId, amount: 1001, network: "eth", asset: token, destination: ethDestination, nonce: 6,
});
const wrongOpen = must(step(base(), [{
  ...tokenOpen,
  amount: 1001,
  nonce: 6,
  publicKey: ethWrongAmount.publicKey,
  signature: ethWrongAmount.signature,
}]));
const wrongBound = step(must(step(wrongOpen.next, [tokenExec])).next, [{ ...tokenSettle, id: ethWrongAmount.id }]);
assert.equal(wrongBound.ok, false);
if (wrongBound.ok) throw new Error("eth binding");
assert.equal(wrongBound.error, "withdrawal binding refused");
const btcRow = must(step(base(), [openOp]));
const ethOnBtc = step(btcRow.next, [{ ...tokenSettle, id: proof.id }]);
assert.equal(ethOnBtc.ok, false);
if (ethOnBtc.ok) throw new Error("eth on btc");
assert.equal(ethOnBtc.error, "withdrawal binding refused");

const nativeTo = "cd".repeat(20);
const nativeTx = rlpEncode([
  rlpUintBytes(0),
  rlpUintBytes(1),
  rlpUintBytes(21000),
  hexToBytes(nativeTo),
  rlpUintBytes(1000),
  new Uint8Array(),
  rlpUintBytes(27),
  new Uint8Array(32),
  new Uint8Array(32),
]);
const nativeReceipt = legacyReceipt({ status: 1, cumulativeGas: 21000, logs: [] });
const nativeKey = rlpUint(0);
const nativeReceiptLeaf = secureLeaf(nativeKey, nativeReceipt);
const nativeTxLeaf = secureLeaf(nativeKey, nativeTx);
const nativeHeader = executionHeader({
  parentHash: new Uint8Array(32),
  transactionsRoot: nativeTxLeaf.root,
  receiptsRoot: nativeReceiptLeaf.root,
  number: 4,
});
const nativeParsed = parseExecutionHeader(nativeHeader);
if (!nativeParsed) throw new Error("native header");
const nativeDestination = `eth:${nativeTo}`;
const nativeProof = signWithdraw(payer, {
  chainId, amount: 1000, network: "eth", asset: "eth", destination: nativeDestination, nonce: 5,
});
const nativeOpen: WithdrawalEvidence = {
  op: "open",
  sender: payer.address,
  amount: 1000,
  network: "eth",
  asset: "eth",
  destination: nativeDestination,
  nonce: 5,
  publicKey: nativeProof.publicKey,
  signature: nativeProof.signature,
};
const nativeExec: WithdrawalEvidence = { op: "exec", headerRlp: bytesToHex(nativeHeader) };
const nativeSettle: WithdrawalEvidence = {
  op: "settleEth",
  id: nativeProof.id,
  blockHash: nativeParsed.hash,
  txIndex: 0,
  receiptRlp: bytesToHex(nativeReceipt),
  receiptProof: nativeReceiptLeaf.proof.map((node) => bytesToHex(node)),
  logIndex: 0,
  txRlp: bytesToHex(nativeTx),
  txProof: nativeTxLeaf.proof.map((node) => bytesToHex(node)),
};
const nativeLocked = must(step(must(step(base(), [nativeOpen])).next, [nativeExec]));
const nativeSettled = must(step(nativeLocked.next, [nativeSettle]));
assert.equal(nativeSettled.next.withdrawals[0]?.status, "settled");
assert.equal(nativeSettled.next.withdrawals[0]?.effectLocator, `${nativeParsed.hash}:0:value`);
assert.equal(nativeSettled.next.ledger.get(WITHDRAWAL_ESCROW)?.balance, 0);
assert.equal(nativeSettled.next.ledger.get(payer.address)?.balance, 4000);
assert.equal(nativeSettled.next.ledger.get(nativeTo)?.balance, undefined);
const failedReceipt = legacyReceipt({ status: 0, cumulativeGas: 21000, logs: [] });
const failedLeaf = secureLeaf(nativeKey, failedReceipt);
const failedHeader = executionHeader({
  parentHash: new Uint8Array(32),
  transactionsRoot: nativeTxLeaf.root,
  receiptsRoot: failedLeaf.root,
  number: 8,
});
const failedParsed = parseExecutionHeader(failedHeader);
if (!failedParsed) throw new Error("failed header");
const failedLocked = must(step(must(step(base(), [nativeOpen])).next, [{ op: "exec", headerRlp: bytesToHex(failedHeader) }]));
const failedSettle = step(failedLocked.next, [{
  ...nativeSettle,
  blockHash: failedParsed.hash,
  receiptRlp: bytesToHex(failedReceipt),
  receiptProof: failedLeaf.proof.map((node) => bytesToHex(node)),
}]);
assert.equal(failedSettle.ok, false);
if (failedSettle.ok) throw new Error("status");
assert.equal(failedSettle.error, "eth receipt refused");
const hugeTx = rlpEncode([
  rlpUintBytes(0),
  rlpUintBytes(1),
  rlpUintBytes(21000),
  hexToBytes(nativeTo),
  hexToBytes("0de0b6b3a7640000"),
  new Uint8Array(),
  rlpUintBytes(1),
  new Uint8Array(32),
  new Uint8Array(32),
]);
const hugeLeaf = secureLeaf(nativeKey, hugeTx);
const hugeHeader = executionHeader({
  parentHash: new Uint8Array(32),
  transactionsRoot: hugeLeaf.root,
  receiptsRoot: nativeReceiptLeaf.root,
  number: 9,
});
const hugeParsed = parseExecutionHeader(hugeHeader);
if (!hugeParsed) throw new Error("huge header");
const hugeLocked = must(step(must(step(base(), [nativeOpen])).next, [{ op: "exec", headerRlp: bytesToHex(hugeHeader) }]));
const hugeStep = step(hugeLocked.next, [{
  ...nativeSettle,
  blockHash: hugeParsed.hash,
  txRlp: bytesToHex(hugeTx),
  txProof: hugeLeaf.proof.map((node) => bytesToHex(node)),
}]);
assert.equal(hugeStep.ok, false);
if (hugeStep.ok) throw new Error("wei");
assert.equal(hugeStep.error, "eth transaction refused");

let ethCursor = must(step(base(), [tokenOpen])).next;
let ethRefundedAt = 0;
for (let i = 0; i < 12 && ethCursor.withdrawals[0]?.status === "locked"; i += 1) {
  if (ethCursor.height + 1 >= 10) {
    const late = step(ethCursor, [tokenExec, tokenSettle]);
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.error, "withdrawal expired");
  }
  ethCursor = must(step(ethCursor)).next;
  if (ethCursor.withdrawals[0]?.status === "refunded") ethRefundedAt = ethCursor.height;
}
assert.equal(ethRefundedAt, 10);
assert.equal(ethCursor.ledger.get(payer.address)?.balance, 5000);
assert.equal(ethCursor.ledger.get(WITHDRAWAL_ESCROW)?.balance, 0);

const ethProof = {
  decoy,
  childRlp: bytesToHex(child),
  badParentRlp: bytesToHex(badParent),
  token: {
    signature: tokenProof.signature,
    id: tokenProof.id,
    asset: token,
    destination: ethDestination,
    nonce: 4,
    amount: 1000,
    headerRlp: bytesToHex(tokenHeader),
    blockHash: tokenParsed.hash,
    txIndex: 0,
    receiptRlp: bytesToHex(tokenReceipt),
    receiptProof: tokenLeaf.proof.map((node) => bytesToHex(node)),
    logIndex: 0,
    txRlp: "",
    txProof: [] as string[],
    locator: `${tokenParsed.hash}:0:0`,
    openEvidence: canonicalEvidence(evidence([tokenOpen])),
    recipient,
  },
  native: {
    signature: nativeProof.signature,
    id: nativeProof.id,
    asset: "eth",
    destination: nativeDestination,
    nonce: 5,
    amount: 1000,
    headerRlp: bytesToHex(nativeHeader),
    blockHash: nativeParsed.hash,
    txIndex: 0,
    receiptRlp: bytesToHex(nativeReceipt),
    receiptProof: nativeReceiptLeaf.proof.map((node) => bytesToHex(node)),
    logIndex: 0,
    txRlp: bytesToHex(nativeTx),
    txProof: nativeTxLeaf.proof.map((node) => bytesToHex(node)),
    locator: `${nativeParsed.hash}:0:value`,
    recipient: nativeTo,
  },
};

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
  ethProof,
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
  eth: "settled",
  ethLocator: tokenSettled.next.withdrawals[0]?.effectLocator,
  nativeLocator: nativeSettled.next.withdrawals[0]?.effectLocator,
}));
