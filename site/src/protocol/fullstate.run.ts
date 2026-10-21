/**
 * FS1 against the digest collisions and the one order that moves finality.
 * This does not adopt a block and does not replace omegaDigest.
 */
import assert from "node:assert/strict";
import { applySuccessor, initialOmega, monetaryError, omegaDigest, openedCouplings, stateRootOf } from "./constitution";
import { decodeOmega, encodeOmega, fullStateId } from "./fullstate";
import type { CanonicalInputs, Omega, ValidatorRecord } from "./types";

function shell(): Omega {
  const omega = initialOmega("testnet");
  omega.height = 2;
  omega.tipTimestamp = 100;
  omega.finalizedHeight = -1;
  omega.ledger = new Map([["aa", { balance: 10, nonce: 0 }]]);
  omega.pools = [];
  omega.validators = new Map();
  omega.delegations = [];
  omega.unbonding = [];
  omega.withdrawals = [];
  omega.proposals = [];
  omega.models = [];
  omega.settlements = [];
  omega.btc = [];
  omega.eth = [];
  omega.ethPubkey = "";
  omega.ethCommittee = "";
  omega.ethExecution = [];
  omega.wasm = new Map();
  return omega;
}

function inputs(omega: Omega, miner = "m"): CanonicalInputs {
  return {
    transactions: [],
    timestamp: omega.tipTimestamp + 1,
    nonce: 0n,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}

/** Past monetaryError and identityError. A later miner refusal still counts. */
function enters(omega: Omega, miner = "m") {
  const step = applySuccessor(omega, inputs(omega, miner));
  if (!step.ok) {
    const early = /refused|validator key|pool id|unknown chain/;
    assert.equal(early.test(step.error) && step.error !== "miner is not a live validator", false, step.error);
  }
  assert.equal(monetaryError(omega), null);
  return step;
}

function bytesDiffer(a: Omega, b: Omega) {
  const left = encodeOmega(a);
  const right = encodeOmega(b);
  assert.equal(omegaDigest(a), omegaDigest(b));
  assert.notEqual(Buffer.from(left).toString("hex"), Buffer.from(right).toString("hex"));
}

const born = initialOmega("testnet");
const again = decodeOmega(encodeOmega(born));
assert.equal(fullStateId(born), fullStateId(again));
assert.equal(omegaDigest(born), omegaDigest(again));

const signed = shell();
signed.couplings = { ...signed.couplings, hash: -0 };
const signedBack = decodeOmega(encodeOmega(signed));
assert.equal(Object.is(signedBack.couplings.hash, -0), true);
assert.equal(Object.is(signedBack.couplings.hash, 0), false);

const missingExec = shell();
delete (missingExec as { ethExecution?: unknown }).ethExecution;
const emptyExec = shell();
bytesDiffer(missingExec, emptyExec);
const missingBack = decodeOmega(encodeOmega(missingExec));
assert.equal("ethExecution" in missingBack, false);

const oneDelegation = shell();
oneDelegation.delegations = [{ delegator: "p>q:1;r", validator: "s", amount: 2 }];
const twoDelegations = shell();
twoDelegations.delegations = [
  { delegator: "p", validator: "q", amount: 1 },
  { delegator: "r", validator: "s", amount: 2 },
];
bytesDiffer(oneDelegation, twoDelegations);
enters(oneDelegation);
enters(twoDelegations);

const oneUnbond = shell();
oneUnbond.unbonding = [{ delegator: "a:b:1:2;c", validator: "d", amount: 3, matureAt: 100 }];
const twoUnbonds = shell();
twoUnbonds.unbonding = [
  { delegator: "a", validator: "b", amount: 1, matureAt: 2 },
  { delegator: "c", validator: "d", amount: 3, matureAt: 100 },
];
bytesDiffer(oneUnbond, twoUnbonds);
enters(oneUnbond);
enters(twoUnbonds);

function withMiner(omega: Omega) {
  omega.validators.set("m", {
    address: "m",
    moniker: "m",
    bondedStake: 1,
    accumulatedRewards: 0,
    slashed: false,
    jailed: false,
    uptime: 1,
    blocksProposed: 0,
    commission: 1,
  });
}

const tailSettlement = shell();
tailSettlement.settlements = [
  { id: 1, asset: "btc", foreignRef: "h", from: "aa", to: "bb:9|del:val:1", amount: 3, status: "locked" },
];
withMiner(tailSettlement);
const tailUnbond = shell();
tailUnbond.settlements = [
  { id: 1, asset: "btc", foreignRef: "h", from: "aa", to: "bb", amount: 9, status: "locked" },
];
tailUnbond.unbonding = [{ delegator: "del", validator: "val", amount: 1, matureAt: 3 }];
withMiner(tailUnbond);
bytesDiffer(tailSettlement, tailUnbond);
const settled = applySuccessor(tailSettlement, inputs(tailSettlement));
const paid = applySuccessor(tailUnbond, inputs(tailUnbond));
assert.equal(settled.ok, true);
assert.equal(paid.ok, true);
if (settled.ok && paid.ok) {
  assert.equal(settled.next.ledger.get("del")?.balance, undefined);
  assert.equal(paid.next.ledger.get("del")?.balance, 1);
  assert.notEqual(settled.omegaRoot, paid.omegaRoot);
}

const committeeA = shell();
committeeA.ethPubkey = "ab";
committeeA.ethCommittee = "cd:ef";
const committeeB = shell();
committeeB.ethPubkey = "ab:cd";
committeeB.ethCommittee = "ef";
bytesDiffer(committeeA, committeeB);
enters(committeeA);
enters(committeeB);

const wasmA = shell();
wasmA.wasm = new Map([["a", "b|c=d"]]);
const wasmB = shell();
wasmB.wasm = new Map([["a", "b"], ["c", "d"]]);
bytesDiffer(wasmA, wasmB);
assert.equal(stateRootOf(wasmA), stateRootOf(wasmB));

const ledgerA = shell();
ledgerA.ledger = new Map([["a:1:0;b", { balance: 2, nonce: 0 }]]);
const ledgerB = shell();
ledgerB.ledger = new Map([
  ["a", { balance: 1, nonce: 0 }],
  ["b", { balance: 2, nonce: 0 }],
]);
bytesDiffer(ledgerA, ledgerB);
assert.notEqual(stateRootOf(ledgerA), stateRootOf(ledgerB));
enters(ledgerA);
enters(ledgerB);

const proposedA = shell();
withMiner(proposedA);
const proposedB = shell();
withMiner(proposedB);
proposedB.validators.get("m")!.blocksProposed = 1;
assert.notEqual(omegaDigest(proposedA), omegaDigest(proposedB));
assert.notEqual(fullStateId(proposedA), fullStateId(proposedB));

const M = Number.MAX_SAFE_INTEGER;
const jailedStake = 2 ** 52;
function record(address: string, bondedStake: number, jailed: boolean, commission: number): ValidatorRecord {
  return {
    address,
    moniker: address,
    bondedStake,
    accumulatedRewards: 0,
    slashed: false,
    jailed,
    uptime: 1,
    blocksProposed: 0,
    commission,
  };
}
const stakeRows = [
  record("m2", 2, false, 1),
  record("big", M, false, 0),
  record("jail", jailedStake, true, 0),
];
function passes(rows: ValidatorRecord[]): boolean {
  const total = rows.reduce((s, v) => s + v.bondedStake, 0);
  const voting = rows.filter((v) => !v.jailed && !v.slashed).reduce((s, v) => s + v.bondedStake, 0);
  return (total > 0 ? voting / total : 0) >= 2 / 3;
}
function permutations(rows: ValidatorRecord[]): ValidatorRecord[][] {
  if (rows.length <= 1) return [rows];
  const out: ValidatorRecord[][] = [];
  rows.forEach((row, i) => {
    for (const rest of permutations(rows.filter((_, j) => j !== i))) out.push([row, ...rest]);
  });
  return out;
}
const orders = permutations(stakeRows);
const passOrder = orders.find(passes);
const failOrder = orders.find((rows) => !passes(rows));
assert.ok(passOrder && failOrder);
function at(rows: ValidatorRecord[]): Omega {
  const omega = shell();
  omega.validators = new Map(rows.map((v) => [v.address, { ...v }]));
  return omega;
}
const high = at(passOrder!);
const low = at(failOrder!);
bytesDiffer(high, low);
const highStep = applySuccessor(high, inputs(high, "m2"));
const lowStep = applySuccessor(low, inputs(low, "m2"));
assert.equal(highStep.ok, true, !highStep.ok ? highStep.error : "");
assert.equal(lowStep.ok, true, !lowStep.ok ? lowStep.error : "");
if (highStep.ok && lowStep.ok) {
  assert.notEqual(highStep.next.finalizedHeight, lowStep.next.finalizedHeight);
  assert.notEqual(highStep.omegaRoot, lowStep.omegaRoot);
}

console.log("fullstate: FS1 separates the digest collisions, and validator order moves finality");
