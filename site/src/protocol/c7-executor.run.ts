/**
 * Milestone 1. One executor for the local block and the external block.
 * A refused input stays refused.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OrganismNode } from "./chain";
import { cloneOmega, initialOmega } from "./constitution";
import { executeTransition, executionInputId } from "./executor";
import { transitionStatement } from "./transition-proof";
import { fullStateId } from "./fullstate";
import { minerKey } from "./genesis";
import { blankEvidence } from "./seal";
import type { TransitionEvidence } from "./types";

const before = initialOmega("testnet");
const miner = minerKey("testnet").address;
const opened = { ...before.couplings };
const spec = {
  transactions: [] as [],
  evidence: blankEvidence(before.chainId),
  timestamp: 15,
  nonce: 0n,
  miner,
  committedPressure: 0,
  couplings: opened,
  difficulty: before.difficulty,
};

const once = executeTransition(before, spec);
const twice = executeTransition(cloneOmega(before), spec);
assert.equal(once.ok, true);
assert.equal(twice.ok, true);
if (!once.ok || !twice.ok) throw new Error("executor");
assert.equal(once.execution.predecessor, twice.execution.predecessor);
assert.equal(once.execution.inputId, twice.execution.inputId);
assert.equal(once.execution.contextId, twice.execution.contextId);
assert.equal(once.execution.successor, twice.execution.successor);
assert.equal(once.execution.carried, twice.execution.carried);
assert.equal(once.execution.header, twice.execution.header);
assert.notEqual(once.execution.predecessor, once.execution.successor);
assert.notEqual(once.execution.successor, once.execution.carried);
assert.equal(once.execution.predecessor, fullStateId(before));

const otherTip = cloneOmega(before);
otherTip.tipHash = "ab".repeat(32);
const moved = executeTransition(otherTip, spec);
assert.equal(moved.ok, true);
if (!moved.ok) throw new Error("moved");
assert.notEqual(moved.execution.predecessor, once.execution.predecessor);
assert.notEqual(moved.execution.header, once.execution.header);

const absent = executionInputId({ ...spec, evidence: undefined });
const empty = executionInputId({ ...spec, evidence: blankEvidence(before.chainId) });
assert.notEqual(absent, empty);
assert.equal(once.execution.stateRootStateId, once.execution.stepped.stateRootStateId);
assert.notEqual(once.execution.stateRootStateId, once.execution.successor);
assert.throws(
  () => transitionStatement({ ...once.execution, predecessor: "0".repeat(64) }),
  /predecessor is not this execution/,
);

const tx = {
  hash: "ab".repeat(32),
  from: "cd".repeat(20),
  to: "ef".repeat(20),
  amount: 10,
  fee: 1,
  nonce: 0,
  timestamp: 15,
  status: "pending" as const,
  signature: "11".repeat(64),
  publicKey: "22".repeat(32),
  blockHash: null,
  blockHeight: null,
};
const rawId = executionInputId({ ...spec, transactions: [tx] });
const stampedId = executionInputId({
  ...spec,
  transactions: [{ ...tx, status: "confirmed" as const, blockHash: "33".repeat(32), blockHeight: 4 }],
});
assert.equal(rawId, stampedId);
assert.notEqual(rawId, executionInputId({ ...spec, transactions: [{ ...tx, timestamp: 16 }] }));

const bad = executeTransition(before, {
  ...spec,
  evidence: { ...blankEvidence(before.chainId), btc: [{ headerHex: "aa", height: 0 }] },
});
assert.equal(bad.ok, false);
if (bad.ok) throw new Error("bad header");
assert.equal(bad.error, "btc header is not 80 bytes");
assert.equal(bad.predecessor, fullStateId(before));

const chain = readFileSync(new URL("./chain.ts", import.meta.url), "utf8");
const composeAt = chain.indexOf("private composeBlock(");
const mineAt = chain.indexOf("\n  mine(");
const composeFn = chain.slice(composeAt, mineAt);
assert.equal(composeFn.includes("this.pending = this.blankEvidence()"), false);
assert.match(composeFn, /executeTransition\(omega, inputs\)/);
assert.match(chain, /const executed = executeTransition\(this\.toOmega\(\), inputs\)/);

const node = new OrganismNode("testnet");
const height = node.height;
const tip = node.tip?.hash;
const staged = (node as unknown as { pending: TransitionEvidence }).pending;
staged.btc.push({ headerHex: "aa", height: 0 });
assert.throws(() => node.mine((node.tip?.timestamp ?? 0) + 1), /btc header is not 80 bytes/);
assert.equal(node.height, height);
assert.equal(node.tip?.hash, tip);
assert.equal(staged.btc.length, 1);
assert.equal(staged.btc[0]?.headerHex, "aa");

const producer = new OrganismNode("testnet");
const parent = producer.tip!;
const sealed = producer.mine(parent.timestamp + 1);
const peer = new OrganismNode("testnet");
assert.equal(peer.tip?.hash, parent.hash);
const admitted = await peer.submitExternal(sealed);
assert.equal(admitted.ok, true, admitted.error ?? "peer refused the locally sealed block");
assert.equal(peer.tip?.hash, producer.tip?.hash);
assert.equal(peer.height, producer.height);
assert.equal(peer.wasmStorage.size, producer.wasmStorage.size);

const caller = new OrganismNode("testnet");
const contract = await caller.executeContract("init", caller.miner.address);
assert.equal(contract.ok, true, contract.error ?? "init was not queued");
const withCall = caller.mine((caller.tip?.timestamp ?? 0) + 1);
assert.equal(withCall.evidence?.wasm.length, 1);
assert.ok(caller.wasmStorage.size > 0);
const replay = new OrganismNode("testnet");
const replayed = await replay.submitExternal(withCall);
assert.equal(replayed.ok, true, replayed.error ?? "wasm block was not admitted");
assert.equal(replay.wasmStorage.size, caller.wasmStorage.size);
assert.deepEqual([...replay.wasmStorage.entries()], [...caller.wasmStorage.entries()]);

const tampered = { ...withCall, statement: withCall.statement && { ...withCall.statement, predecessor: "0".repeat(64) } };
const fresh = new OrganismNode("testnet");
const beforeHeight = fresh.height;
const beforeTip = fresh.tip?.hash;
const rejected = await fresh.submitExternal(tampered);
assert.equal(rejected.ok, false);
assert.match(rejected.error ?? "", /predecessor is not installed/);
assert.equal(fresh.height, beforeHeight);
assert.equal(fresh.tip?.hash, beforeTip);
